import type {
  CreatePluginScheduleInput,
  InstalledPluginPackage,
  PluginConfigProperty,
  PluginConfigView,
  PluginContributionState,
  PluginContribution,
  PluginGrant,
  PluginManifestV2,
  PluginSchedule,
  SavePluginConfigInput,
  UpsertPluginGrantInput
} from '../../shared/plugin-host-contracts'
import type {
  PluginConfigRecord,
  PluginContributionRecord,
  UpsertPluginPackageOptions
} from '../database'
import {
  builtinPluginManifestsV2,
  MANUAL_COLLECTION_INTERVAL_MINUTES_CONFIG_KEY
} from './builtin-manifests'
import { ExtensionRegistry } from './extension-registry'
import type { PluginSecretStore } from './plugin-secret-store'
import {
  legacyIntervalMinutes,
  minimumPluginScheduleSpacingMinutes,
  nextPluginScheduleOccurrence,
  normalizePluginScheduleCadence
} from './schedule-recurrence'

interface PluginHostRepository {
  listAccounts?(): Array<{
    id: string
    platformId?: string
    adapterContributionId?: string | null
    groupIds?: string[]
  }>
  listGroups?(): Array<{ id: string }>
  getPluginState?(pluginId: string): { enabled: boolean } | null
  upsertPluginPackage(manifest: PluginManifestV2, options: UpsertPluginPackageOptions): InstalledPluginPackage
  listInstalledPluginPackages(): InstalledPluginPackage[]
  getInstalledPluginPackage(pluginId: string): InstalledPluginPackage | null
  setPluginPackageEnabled(pluginId: string, enabled: boolean): InstalledPluginPackage
  setPluginContributionEnabled(pluginId: string, contributionId: string, enabled: boolean): void
  listPluginContributionRecords(pluginId?: string): PluginContributionRecord[]
  upsertPluginGrant(grant: PluginGrant): PluginGrant
  getPluginGrant(pluginId: string, contributionId: string): PluginGrant | null
  savePluginConfig(record: Omit<PluginConfigRecord, 'updatedAt'>): PluginConfigRecord
  getPluginConfig(pluginId: string, contributionId: string): PluginConfigRecord | null
  getSetting?<T>(key: string, fallback: T): T
  setSetting?<T>(key: string, value: T): T
  createPluginSchedule(input: Omit<PluginSchedule, 'id' | 'createdAt' | 'updatedAt'>): PluginSchedule
  listPluginSchedules(): PluginSchedule[]
  updatePluginSchedule(id: string, patch: Partial<Pick<PluginSchedule,
    'enabled' | 'nextRunAt' | 'lastRunAt' | 'consecutiveFailures' | 'suspendedReason'
  >>): PluginSchedule
  removePluginSchedule(id: string): void
}

export class PluginHostService {
  private defaultPlatformPluginIds = new Set<string>()

  constructor(
    private readonly repository: PluginHostRepository,
    private readonly secrets: PluginSecretStore,
    private readonly registry = new ExtensionRegistry()
  ) {}

  initialize(defaultPlatformPluginIds: readonly string[] = []): void {
    const builtinIds = new Set(builtinPluginManifestsV2.map((manifest) => manifest.id))
    this.defaultPlatformPluginIds = new Set([...builtinIds, ...defaultPlatformPluginIds])
    for (const registered of this.registry.listManifests()) {
      if (!builtinIds.has(registered.id)) this.registry.unregister(registered.id)
    }
    for (const manifest of builtinPluginManifestsV2) {
      const existingPackage = this.repository.getInstalledPluginPackage(manifest.id)
      const legacyState = existingPackage ? null : this.repository.getPluginState?.(manifest.id) ?? null
      const enabled = existingPackage?.enabled ?? legacyState?.enabled ?? true
      this.repository.upsertPluginPackage(manifest, {
        source: 'builtin',
        status: 'active',
        packageHash: `builtin:${manifest.id}@${manifest.version}`,
        publisherKeyId: manifest.publisher.keyId,
        enabled
      })
      if (!existingPackage && !legacyState) this.initializeBuiltinDefaults(manifest)
      else if (!existingPackage && legacyState?.enabled) this.migrateBuiltinGrant(manifest)
    }
    for (const installed of this.repository.listInstalledPluginPackages()) {
      if (!builtinIds.has(installed.manifest.id) && this.defaultPlatformPluginIds.has(installed.manifest.id)) {
        this.initializeTrustedPlatformDefaults(installed)
      }
    }
    for (const installed of this.repository.listInstalledPluginPackages()) {
      if (!this.registry.getManifest(installed.manifest.id)) this.registry.register(installed.manifest)
    }
  }

  requireEnabledSessionApi(pluginId: string, accountId?: string): {
    manualCollectionIntervalSeconds: number
  } {
    const installed = this.requirePackage(pluginId)
    if (installed.status !== 'active' || !installed.enabled) throw new Error('请先在插件中心启用该平台的数据同步')
    const contribution = installed.manifest.contributions.find((item) => item.kind === 'platform.adapter')
    if (!contribution || !this.listContributions().some((item) => (
      item.pluginId === pluginId && item.contribution.id === contribution.id && item.enabled && !item.suspendedReason
    ))) throw new Error('请先在插件中心启用该平台的数据同步')
    if (accountId) {
      const accounts = this.repository.listAccounts?.() ?? []
      const account = accounts.find((item) => item.id === accountId)
      if (!account) throw new Error('账号不存在')
      if (account.platformId && account.platformId !== contribution.platform.id) throw new Error('账号平台与适配器不匹配')
      if (account.adapterContributionId && account.adapterContributionId !== contribution.id) {
        throw new Error('账号未绑定此平台适配器')
      }
      const grant = this.reconcileDefaultBuiltinGrant(
        pluginId,
        contribution,
        this.repository.getPluginGrant(pluginId, contribution.id)
      )
      const allowed = Boolean(grant?.permissions.includes('platform.session-json') && (
        grant.accountIds.includes(accountId) ||
        (account.groupIds ?? []).some((groupId) => grant.groupIds.includes(groupId))
      ))
      if (!allowed) throw new Error('请先授权该适配器访问此账号的登录会话')
    }
    return {
      manualCollectionIntervalSeconds: this.manualCollectionIntervalSeconds(pluginId, contribution)
    }
  }

  recordSessionApiRun(_pluginId: string, _succeeded: boolean, _error = ''): void {
    // Built-in adapters already persist their managed sync job and safe error state.
  }

  platformCollectionIntervalSeconds(pluginId: string, contributionId: string): number {
    const contribution = this.requireContribution(pluginId, contributionId)
    if (contribution.kind !== 'platform.adapter') throw new Error('贡献点不是平台适配器')
    return this.manualCollectionIntervalSeconds(pluginId, contribution)
  }

  listPackages(): InstalledPluginPackage[] {
    return this.repository.listInstalledPluginPackages()
  }

  listContributions(): PluginContributionState[] {
    const runtime = new Map(this.repository.listPluginContributionRecords().map((item) => [
      `${item.pluginId}:${item.contributionId}`,
      item
    ]))
    return this.repository.listInstalledPluginPackages().flatMap((installed) => installed.manifest.contributions.map((contribution) => {
      const record = runtime.get(`${installed.manifest.id}:${contribution.id}`)
      const grant = this.reconcileDefaultBuiltinGrant(
        installed.manifest.id,
        contribution,
        this.repository.getPluginGrant(installed.manifest.id, contribution.id)
      )
      const packageSuspension = installed.status !== 'active'
        ? packageStatusMessage(installed.status)
        : installed.enabled
          ? ''
          : '插件包已停用'
      return {
        pluginId: installed.manifest.id,
        pluginName: installed.manifest.name,
        pluginVersion: installed.manifest.version,
        contribution: structuredClone(contribution),
        enabled: installed.status === 'active' && installed.enabled && (record?.enabled ?? false),
        granted: grantValid(grant, contribution),
        suspendedReason: packageSuspension || record?.suspendedReason || ''
      }
    }))
  }

  setPackageEnabled(pluginId: string, enabled: boolean): InstalledPluginPackage {
    return this.repository.setPluginPackageEnabled(pluginId, enabled)
  }

  setContributionEnabled(pluginId: string, contributionId: string, enabled: boolean): PluginContributionState {
    const installed = this.requirePackage(pluginId)
    const contribution = installed.manifest.contributions.find((item) => item.id === contributionId)
    if (!contribution) throw new Error('插件贡献点不存在')
    if (enabled && (installed.status !== 'active' || !installed.enabled)) {
      throw new Error('请先启用可用的插件包')
    }
    if (enabled && !grantValid(this.repository.getPluginGrant(pluginId, contributionId), contribution)) {
      throw new Error('请先确认该贡献点的数据和网络权限')
    }
    this.repository.setPluginContributionEnabled(pluginId, contributionId, enabled)
    return this.listContributions().find((item) => (
      item.pluginId === pluginId && item.contribution.id === contributionId
    ))!
  }

  grant(input: UpsertPluginGrantInput): PluginGrant {
    const contribution = this.requireContribution(input.pluginId, input.contributionId)
    if (input.permissions.some((permission) => !contribution.permissions.includes(permission))) {
      throw new Error('授权范围超过插件声明')
    }
    const permittedScopes = new Set([
      ...(input.permissions.includes('accounts.read') ? ['account' as const] : []),
      ...(input.permissions.includes('profiles.read') ? ['profile' as const] : []),
      ...(input.permissions.includes('contents.read') ? ['content' as const] : []),
      ...(input.permissions.includes('metrics.read') ? ['metrics' as const] : [])
    ])
    if (input.dataScopes.some((scope) => !permittedScopes.has(scope))) throw new Error('数据授权范围超过已授予权限')
    if (!input.permissions.includes('network.https') && input.networkOrigins.length) throw new Error('贡献点未获准访问网络')
    const accountIds = uniqueIds(input.accountIds, '账号')
    const groupIds = uniqueIds(input.groupIds, '分组')
    const knownAccounts = this.repository.listAccounts?.()
    const knownGroups = this.repository.listGroups?.()
    if (knownAccounts && accountIds.some((id) => !knownAccounts.some((item) => item.id === id))) throw new Error('账号授权范围包含未知账号')
    if (knownGroups && groupIds.some((id) => !knownGroups.some((item) => item.id === id))) throw new Error('分组授权范围包含未知分组')
    const origins = [...new Set(input.networkOrigins.map(normalizePublicHttpsOrigin))]
    if (origins.length > 32) throw new Error('网络授权目标过多')
    const saved = this.repository.upsertPluginGrant({
      ...input,
      accountIds,
      groupIds,
      networkOrigins: origins,
      grantedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    })
    this.repository.setSetting?.(builtinDefaultGrantKey(input.pluginId, input.contributionId), false)
    return saved
  }

  getGrant(pluginId: string, contributionId: string): PluginGrant | null {
    const contribution = this.requireContribution(pluginId, contributionId)
    const grant = this.reconcileDefaultBuiltinGrant(
      pluginId,
      contribution,
      this.repository.getPluginGrant(pluginId, contributionId)
    )
    return grant ? structuredClone(grant) : null
  }

  registerVerifiedPackage(manifest: PluginManifestV2): void {
    const current = this.registry.getManifest(manifest.id)
    if (current?.version === manifest.version) return
    if (current) this.registry.unregister(manifest.id)
    try {
      this.registry.register(manifest)
    } catch (error) {
      if (current) this.registry.register(current)
      throw error
    }
  }

  unregisterPackage(pluginId: string): void {
    if (builtinPluginManifestsV2.some((manifest) => manifest.id === pluginId)) return
    this.registry.unregister(pluginId)
  }

  getConfig(pluginId: string, contributionId: string): PluginConfigView {
    this.requireContribution(pluginId, contributionId)
    const config = this.repository.getPluginConfig(pluginId, contributionId)
    return {
      pluginId,
      contributionId,
      values: structuredClone(config?.publicConfig ?? {}),
      configuredSecrets: Object.keys(config?.encryptedSecrets ?? {}).sort(),
      updatedAt: config?.updatedAt ?? null
    }
  }

  /** Main-process only. Decrypted values are never exposed through IPC. */
  getRuntimeSecrets(pluginId: string, contributionId: string): Record<string, string> {
    const contribution = this.requireContribution(pluginId, contributionId)
    const schema = contribution.configSchema
    const config = this.repository.getPluginConfig(pluginId, contributionId)
    if (!schema || !config) return {}
    const result: Record<string, string> = {}
    for (const [key, encrypted] of Object.entries(config.encryptedSecrets)) {
      const property = schema.properties[key]
      if (property?.type !== 'string' || property.format !== 'secret') continue
      result[key] = this.secrets.decrypt(encrypted)
    }
    return result
  }

  saveConfig(input: SavePluginConfigInput): PluginConfigView {
    const contribution = this.requireContribution(input.pluginId, input.contributionId)
    const schema = contribution.configSchema
    if (!schema) {
      if (Object.keys(input.values).length || Object.keys(input.secrets ?? {}).length) {
        throw new Error('该贡献点没有可配置项')
      }
      return this.getConfig(input.pluginId, input.contributionId)
    }
    const previous = this.repository.getPluginConfig(input.pluginId, input.contributionId)
    const publicConfig: Record<string, unknown> = {}
    const encryptedSecrets = { ...(previous?.encryptedSecrets ?? {}) }
    const clear = new Set(input.clearSecrets ?? [])
    for (const key of clear) delete encryptedSecrets[key]
    for (const [key, property] of Object.entries(schema.properties)) {
      if (property.type === 'string' && property.format === 'secret') {
        const supplied = input.secrets?.[key]
        if (supplied !== undefined) {
          validateConfigValue(property, supplied, key)
          encryptedSecrets[key] = this.secrets.encrypt(supplied)
        }
        continue
      }
      const supplied = input.values[key]
      if (supplied === undefined) {
        if ('default' in property && property.default !== undefined) publicConfig[key] = structuredClone(property.default)
        continue
      }
      validateConfigValue(property, supplied, key)
      publicConfig[key] = structuredClone(supplied)
    }
    for (const key of Object.keys(input.values)) {
      if (!(key in schema.properties)) throw new Error('插件配置包含未知字段')
    }
    for (const key of [...Object.keys(input.secrets ?? {}), ...(input.clearSecrets ?? [])]) {
      const property = schema.properties[key]
      if (property?.type !== 'string' || property.format !== 'secret') {
        throw new Error('插件密钥配置包含未知字段')
      }
    }
    for (const key of schema.required ?? []) {
      const property = schema.properties[key]
      const available = property?.type === 'string' && property.format === 'secret'
        ? Boolean(encryptedSecrets[key])
        : publicConfig[key] !== undefined
      if (!available) throw new Error(`插件配置缺少必填项：${key}`)
    }
    this.repository.savePluginConfig({
      pluginId: input.pluginId,
      contributionId: input.contributionId,
      publicConfig,
      encryptedSecrets
    })
    return this.getConfig(input.pluginId, input.contributionId)
  }

  listSchedules(): PluginSchedule[] {
    return this.repository.listPluginSchedules()
  }

  createSchedule(input: CreatePluginScheduleInput): PluginSchedule {
    const contribution = this.requireContribution(input.pluginId, input.contributionId)
    if (!contribution.permissions.includes('scheduler.run')) throw new Error('贡献点没有定时执行能力')
    if (contribution.kind === 'platform.adapter' && input.accountIds.length === 0 && input.groupIds.length === 0) {
      throw new Error('平台自动同步计划必须选择账号或分组')
    }
    const grant = this.reconcileDefaultBuiltinGrant(
      input.pluginId,
      contribution,
      this.repository.getPluginGrant(input.pluginId, input.contributionId)
    )
    if (!grant?.permissions.includes('scheduler.run')) throw new Error('尚未授权定时执行')
    if (input.accountIds.some((id) => !grant.accountIds.includes(id)) || input.groupIds.some((id) => !grant.groupIds.includes(id))) {
      throw new Error('计划范围超过贡献点授权范围')
    }
    const declaredMinimum = contribution.kind === 'scheduled.task'
      ? contribution.minimumIntervalMinutes
      : contribution.kind === 'platform.adapter'
        ? Math.max(60, Math.ceil(contribution.minimumIntervalSeconds / 60))
        : 5
    const cadence = normalizePluginScheduleCadence(input.cadence, input.intervalMinutes)
    if (minimumPluginScheduleSpacingMinutes(cadence) < declaredMinimum) {
      throw new Error(`运行周期的最短间隔不能少于 ${declaredMinimum} 分钟`)
    }
    const now = new Date()
    return this.repository.createPluginSchedule({
      pluginId: input.pluginId,
      contributionId: input.contributionId,
      accountIds: uniqueIds(input.accountIds, '账号'),
      groupIds: uniqueIds(input.groupIds, '分组'),
      cadence,
      intervalMinutes: legacyIntervalMinutes(cadence),
      enabled: input.enabled,
      nextRunAt: input.enabled ? nextPluginScheduleOccurrence(cadence, now).toISOString() : null,
      lastRunAt: null,
      consecutiveFailures: 0,
      suspendedReason: ''
    })
  }

  updateSchedule(id: string, enabled: boolean): PluginSchedule {
    const current = this.repository.listPluginSchedules().find((item) => item.id === id)
    if (!current) throw new Error('插件计划不存在')
    return this.repository.updatePluginSchedule(id, {
      enabled,
      nextRunAt: enabled
        ? nextPluginScheduleOccurrence(current.cadence, new Date()).toISOString()
        : null,
      suspendedReason: ''
    })
  }

  removeSchedule(id: string): void {
    this.repository.removePluginSchedule(id)
  }

  extensionRegistry(): ExtensionRegistry {
    return this.registry
  }

  private initializeBuiltinDefaults(manifest: PluginManifestV2): void {
    const accounts = this.repository.listAccounts?.() ?? []
    for (const contribution of manifest.contributions) {
      if (this.repository.getPluginGrant(manifest.id, contribution.id)) continue
      const accountIds = contribution.kind === 'platform.adapter'
        ? accounts.filter((account) => (
            account.platformId === contribution.platform.id &&
            (!account.adapterContributionId || account.adapterContributionId === contribution.id)
          )).map((account) => account.id)
        : []
      const now = new Date().toISOString()
      this.repository.upsertPluginGrant({
        pluginId: manifest.id,
        contributionId: contribution.id,
        permissions: [...contribution.permissions],
        accountIds,
        groupIds: [],
        dataScopes: defaultDataScopes(contribution.permissions),
        networkOrigins: [],
        grantedAt: now,
        updatedAt: now
      })
      this.repository.setSetting?.(builtinDefaultGrantKey(manifest.id, contribution.id), true)
    }
  }

  private initializeTrustedPlatformDefaults(installed: InstalledPluginPackage): void {
    if (installed.source !== 'builtin' || installed.status !== 'active') return
    const contributions = installed.manifest.contributions.filter((item) => item.kind === 'platform.adapter')
    if (contributions.length === 0) return
    const initializedKey = trustedPlatformDefaultsKey(installed.manifest.id)
    if (this.repository.getSetting?.<boolean>(initializedKey, false) === true) return

    const pending = contributions.filter((contribution) => (
      !this.repository.getPluginGrant(installed.manifest.id, contribution.id)
    ))
    if (pending.length > 0) {
      this.repository.setPluginPackageEnabled(installed.manifest.id, true)
      const accounts = this.repository.listAccounts?.() ?? []
      for (const contribution of pending) {
        const now = new Date().toISOString()
        const accountIds = accounts.filter((account) => (
          account.platformId === contribution.platform.id &&
          (!account.adapterContributionId || account.adapterContributionId === contribution.id)
        )).map((account) => account.id)
        this.repository.upsertPluginGrant({
          pluginId: installed.manifest.id,
          contributionId: contribution.id,
          permissions: [...contribution.permissions],
          accountIds,
          groupIds: [],
          dataScopes: defaultDataScopes(contribution.permissions),
          networkOrigins: [],
          grantedAt: now,
          updatedAt: now
        })
        this.repository.setPluginContributionEnabled(installed.manifest.id, contribution.id, true)
        this.repository.setSetting?.(builtinDefaultGrantKey(installed.manifest.id, contribution.id), true)
      }
    }
    this.repository.setSetting?.(initializedKey, true)
  }

  private reconcileDefaultBuiltinGrant(
    pluginId: string,
    contribution: PluginContribution,
    grant: PluginGrant | null
  ): PluginGrant | null {
    if (!grant || contribution.kind !== 'platform.adapter') return grant
    if (!this.defaultPlatformPluginIds.has(pluginId)) return grant
    if (this.repository.getSetting?.<boolean>(builtinDefaultGrantKey(pluginId, contribution.id), false) !== true) return grant
    const missingAccountIds = (this.repository.listAccounts?.() ?? []).filter((account) => (
      account.platformId === contribution.platform.id &&
      (!account.adapterContributionId || account.adapterContributionId === contribution.id) &&
      !grant.accountIds.includes(account.id)
    )).map((account) => account.id)
    if (missingAccountIds.length === 0) return grant
    const updatedAt = new Date().toISOString()
    return this.repository.upsertPluginGrant({
      ...grant,
      accountIds: [...grant.accountIds, ...missingAccountIds],
      updatedAt
    })
  }

  private manualCollectionIntervalSeconds(
    pluginId: string,
    contribution: Extract<PluginContribution, { kind: 'platform.adapter' }>
  ): number {
    const property = contribution.configSchema?.properties[MANUAL_COLLECTION_INTERVAL_MINUTES_CONFIG_KEY]
    const saved = this.repository.getPluginConfig(pluginId, contribution.id)
      ?.publicConfig[MANUAL_COLLECTION_INTERVAL_MINUTES_CONFIG_KEY]
    const configured = saved ?? (property && 'default' in property ? property.default : undefined)
    if (typeof configured !== 'number' || !Number.isSafeInteger(configured)) {
      return contribution.minimumIntervalSeconds
    }
    const minimum = property && 'minimum' in property ? property.minimum : undefined
    const maximum = property && 'maximum' in property ? property.maximum : undefined
    if ((minimum !== undefined && configured < minimum) || (maximum !== undefined && configured > maximum)) {
      return contribution.minimumIntervalSeconds
    }
    return Math.max(contribution.minimumIntervalSeconds, configured * 60)
  }

  private migrateBuiltinGrant(manifest: PluginManifestV2): void {
    const accounts = this.repository.listAccounts?.() ?? []
    for (const contribution of manifest.contributions) {
      if (contribution.kind !== 'platform.adapter' || this.repository.getPluginGrant(manifest.id, contribution.id)) continue
      const accountIds = accounts.filter((account) => (
        account.platformId === contribution.platform.id &&
        (!account.adapterContributionId || account.adapterContributionId === contribution.id)
      )).map((account) => account.id)
      if (accountIds.length === 0) continue
      const now = new Date().toISOString()
      this.repository.upsertPluginGrant({
        pluginId: manifest.id,
        contributionId: contribution.id,
        permissions: ['platform.session-json'],
        accountIds,
        groupIds: [],
        dataScopes: [],
        networkOrigins: [],
        grantedAt: now,
        updatedAt: now
      })
    }
  }

  private requirePackage(pluginId: string): InstalledPluginPackage {
    const installed = this.repository.getInstalledPluginPackage(pluginId)
    if (!installed) throw new Error('插件包不存在')
    return installed
  }

  private requireContribution(pluginId: string, contributionId: string) {
    const installed = this.requirePackage(pluginId)
    const contribution = installed.manifest.contributions.find((item) => item.id === contributionId)
    if (!contribution) throw new Error('插件贡献点不存在')
    return contribution
  }
}

function packageStatusMessage(status: InstalledPluginPackage['status']): string {
  if (status === 'revoked') return '插件版本已被目录撤销'
  if (status === 'incompatible') return '插件与当前版本不兼容'
  if (status === 'failed') return '插件加载失败'
  if (status === 'disabled') return '插件包已停用'
  return ''
}

function normalizePublicHttpsOrigin(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('网络授权地址无效')
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('网络授权必须是 HTTPS 来源')
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || isIpAddress(host)) {
    throw new Error('网络授权只允许公网 HTTPS 域名')
  }
  return url.origin
}

function isIpAddress(host: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(':')
}

function uniqueIds(values: string[], label: string): string[] {
  if (!Array.isArray(values) || values.length > 500 || values.some((value) => (
    typeof value !== 'string' || !/^[a-zA-Z0-9._:-]{1,160}$/.test(value)
  ))) throw new Error(`${label}授权范围无效`)
  return [...new Set(values)]
}

function builtinDefaultGrantKey(pluginId: string, contributionId: string): string {
  return `plugins.builtin-default-grant:${pluginId}:${contributionId}`
}

function trustedPlatformDefaultsKey(pluginId: string): string {
  return `plugins.trusted-platform-defaults:${pluginId}`
}

function defaultDataScopes(permissions: readonly PluginGrant['permissions'][number][]): PluginGrant['dataScopes'] {
  return [
    ...(permissions.includes('accounts.read') ? ['account' as const] : []),
    ...(permissions.includes('profiles.read') ? ['profile' as const] : []),
    ...(permissions.includes('contents.read') ? ['content' as const] : []),
    ...(permissions.includes('metrics.read') ? ['metrics' as const] : [])
  ]
}

function validateConfigValue(property: PluginConfigProperty, value: unknown, key: string): void {
  if (property.type === 'string') {
    if (typeof value !== 'string' || value.length < (property.minLength ?? 0) || value.length > (property.maxLength ?? 4_096)) {
      throw new Error(`插件配置 ${key} 无效`)
    }
    if (property.enum && !property.enum.includes(value)) throw new Error(`插件配置 ${key} 不在允许范围内`)
    if (property.format === 'url') {
      let url: URL
      try {
        url = new URL(value)
      } catch {
        throw new Error(`插件配置 ${key} 必须是公网 HTTPS 地址`)
      }
      normalizePublicHttpsOrigin(url.origin)
    }
    return
  }
  if (property.type === 'boolean') {
    if (typeof value !== 'boolean') throw new Error(`插件配置 ${key} 必须是布尔值`)
    return
  }
  if (property.type === 'array') {
    if (!Array.isArray(value) || value.length > (property.maxItems ?? 128) || value.some((item) => typeof item !== 'string')) {
      throw new Error(`插件配置 ${key} 必须是字符串数组`)
    }
    if (property.items.enum && value.some((item) => !property.items.enum!.includes(item))) {
      throw new Error(`插件配置 ${key} 包含未知值`)
    }
    return
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || (property.type === 'integer' && !Number.isInteger(value))) {
    throw new Error(`插件配置 ${key} 必须是数值`)
  }
  if (property.minimum !== undefined && value < property.minimum) throw new Error(`插件配置 ${key} 过小`)
  if (property.maximum !== undefined && value > property.maximum) throw new Error(`插件配置 ${key} 过大`)
}

function grantValid(
  grant: PluginGrant | null,
  contribution: PluginContribution
): boolean {
  if (!grant || grant.permissions.some((permission) => !contribution.permissions.includes(permission))) return false
  const mandatory = contribution.kind === 'platform.adapter'
    ? 'platform.session-json'
    : contribution.kind === 'event.handler'
      ? 'events.subscribe'
      : contribution.kind === 'scheduled.task'
        ? 'scheduler.run'
        : null
  return mandatory === null || grant.permissions.includes(mandatory)
}
