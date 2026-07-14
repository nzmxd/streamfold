import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type {
  InstalledPluginPackage,
  PluginCatalogDocument,
  PluginCatalogEntry,
  PluginCatalogState,
  PluginManifestV2
} from '../../shared/plugin-host-contracts'
import {
  assertCatalogEntryInstallable,
  catalogContainsRevocation,
  isAppVersionCompatible,
  parseAndVerifyPluginCatalog,
  resolveLatestCompatiblePlugin
} from './plugin-catalog'
import type { PluginEntryStore } from './plugin-entry-store'
import type { PluginHostService } from './plugin-host-service'
import { MAX_PLUGIN_PACKAGE_BYTES, verifyPluginPackage, verifyPluginPackageFile } from './plugin-package'
import { PublicHttpsBroker } from './public-https-broker'

interface LifecycleRepository {
  listInstalledPluginPackages(): InstalledPluginPackage[]
  getInstalledPluginPackage(pluginId: string): InstalledPluginPackage | null
  upsertPluginPackage(manifest: PluginManifestV2, options: {
    source: 'catalog' | 'local_development'
    status: 'active'
    packageHash: string
    publisherKeyId: string
    enabled?: boolean
    development?: boolean
  }): InstalledPluginPackage
  setPluginPackageStatus(pluginId: string, status: 'active' | 'revoked' | 'failed', error?: string): InstalledPluginPackage
  setPluginUpdateAvailable(pluginId: string, version: string | null): void
  suspendPluginContributions(pluginId: string, contributionIds: string[], reason: string): void
  removePluginPackage(pluginId: string): void
  getSetting<T>(key: string): T | null
  setSetting(key: string, value: unknown): void
}

export interface PluginLifecycleOptions {
  repository: LifecycleRepository
  host: PluginHostService
  entries: PluginEntryStore
  catalogUrl: string
  catalogRootPublicKey: string
  catalogCachePath: string
  appVersion: string
  chooseDevelopmentPackage(): Promise<string | null>
  terminatePlugin?(pluginId: string): void
  network?: PublicHttpsBroker
  clock?: () => Date
}

/** Signed-catalog installation, update, revocation and developer package lifecycle. */
export class PluginLifecycleService {
  private catalog: PluginCatalogDocument | null = null
  private refreshedAt: string | null = null
  private error = ''
  private readonly network: PublicHttpsBroker
  private readonly clock: () => Date

  constructor(private readonly options: PluginLifecycleOptions) {
    this.network = options.network ?? new PublicHttpsBroker()
    this.clock = options.clock ?? (() => new Date())
  }

  async initialize(): Promise<void> {
    if (!this.configured()) return
    try {
      const bytes = await readFile(this.options.catalogCachePath)
      this.catalog = parseAndVerifyPluginCatalog(bytes, {
        rootPublicKey: this.options.catalogRootPublicKey,
        now: this.clock()
      })
      this.refreshedAt = this.catalog.generatedAt
      this.applyCatalogState()
    } catch {
      // A missing, expired or tampered cache is ignored. Refresh remains explicit.
    }
  }

  getCatalog(): PluginCatalogState {
    return {
      configured: this.configured(),
      refreshedAt: this.refreshedAt,
      expiresAt: this.catalog?.expiresAt ?? null,
      entries: structuredClone(this.catalog?.entries ?? []),
      error: this.error
    }
  }

  async refreshCatalog(): Promise<PluginCatalogState> {
    if (!this.configured()) throw new Error('发布构建尚未配置插件目录根公钥')
    const response = await this.network.download(this.options.catalogUrl, 2 * 1024 * 1024)
    try {
      if (response.status !== 200) throw new Error(`插件目录返回 HTTP ${response.status}`)
      const catalog = parseAndVerifyPluginCatalog(response.body, {
        rootPublicKey: this.options.catalogRootPublicKey,
        now: this.clock()
      })
      this.catalog = catalog
      this.refreshedAt = this.clock().toISOString()
      this.error = ''
      await atomicWrite(this.options.catalogCachePath, response.body)
      this.applyCatalogState()
      await this.applySafeAutomaticUpdates()
      return this.getCatalog()
    } catch (error) {
      this.error = safeMessage(error)
      throw error
    } finally {
      response.body.fill(0)
    }
  }

  async installFromCatalog(pluginId: string): Promise<InstalledPluginPackage> {
    const entry = this.resolveEntry(pluginId)
    return await this.installCatalogEntry(entry, true, false)
  }

  async update(pluginId: string, confirmPermissionExpansion = false): Promise<InstalledPluginPackage> {
    const current = this.requireInstalled(pluginId)
    if (current.source === 'builtin') throw new Error('内置插件随归页版本更新')
    const entry = this.resolveEntry(pluginId)
    if (entry.version === current.manifest.version && entry.packageHash === current.packageHash) return current
    return await this.installCatalogEntry(entry, true, confirmPermissionExpansion)
  }

  async installDevelopment(): Promise<InstalledPluginPackage | null> {
    if (!this.developerMode()) throw new Error('请先启用插件开发者模式')
    const filePath = await this.options.chooseDevelopmentPackage()
    if (!filePath) return null
    const verified = await verifyPluginPackageFile(filePath, { source: 'local_development' })
    assertManifestCompatibility(verified.manifest, this.options.appVersion)
    const existing = this.options.repository.getInstalledPluginPackage(verified.manifest.id)
    if (existing?.source === 'builtin') throw new Error('开发插件不能覆盖内置插件')
    const reauthorization = existing
      ? reauthorizationContributionIds(existing.manifest, verified.manifest)
      : []
    const breaking = Boolean(existing && (
      major(existing.manifest.version) !== major(verified.manifest.version) || reauthorization.length > 0
    ))
    this.options.host.registerVerifiedPackage(verified.manifest)
    try {
      await this.options.entries.stageAndActivate(verified)
      for (const contribution of verified.manifest.contributions) {
        await this.options.entries.readEntry(verified.manifest.id, verified.manifest.version, contribution.entry)
      }
      const installed = this.options.repository.upsertPluginPackage(verified.manifest, {
        source: 'local_development',
        status: 'active',
        packageHash: verified.archiveHash,
        publisherKeyId: verified.manifest.publisher.keyId,
        enabled: existing?.enabled ?? false,
        development: true
      })
      if (breaking) {
        this.options.repository.suspendPluginContributions(
          verified.manifest.id,
          major(existing!.manifest.version) !== major(verified.manifest.version)
            ? verified.manifest.contributions.map((item) => item.id)
            : reauthorization,
          '开发插件变更了权限或安全边界，请重新确认授权'
        )
      }
      return installed
    } catch (error) {
      restoreRegistry(this.options.host, verified.manifest.id, existing?.manifest ?? null)
      throw error
    }
  }

  async uninstall(pluginId: string): Promise<void> {
    const installed = this.requireInstalled(pluginId)
    if (installed.source === 'builtin') throw new Error('内置插件不能卸载')
    this.stop(pluginId)
    this.options.repository.removePluginPackage(pluginId)
    this.options.host.unregisterPackage(pluginId)
    await this.options.entries.removePlugin(pluginId)
  }

  stop(pluginId: string): void {
    this.options.terminatePlugin?.(pluginId)
  }

  getDeveloperMode(): { enabled: boolean } {
    return { enabled: this.developerMode() }
  }

  setDeveloperMode(enabled: boolean): { enabled: boolean } {
    this.options.repository.setSetting('plugins.developerMode', Boolean(enabled))
    return this.getDeveloperMode()
  }

  private async installCatalogEntry(
    entry: PluginCatalogEntry,
    explicit: boolean,
    confirmPermissionExpansion: boolean
  ): Promise<InstalledPluginPackage> {
    assertCatalogEntryInstallable(entry)
    const current = this.options.repository.getInstalledPluginPackage(entry.pluginId)
    if (current?.source === 'builtin') throw new Error('目录插件不能覆盖内置插件')
    const response = await this.network.download(entry.downloadUrl, MAX_PLUGIN_PACKAGE_BYTES)
    try {
      if (response.status !== 200) throw new Error(`插件包返回 HTTP ${response.status}`)
      const verified = await verifyPluginPackage(response.body, {
        source: 'catalog',
        publisherPublicKey: entry.publisherPublicKey,
        expectedArchiveHash: entry.packageHash,
        expectedPublisherKeyId: entry.publisherKeyId
      })
      if (verified.manifest.id !== entry.pluginId || verified.manifest.version !== entry.version) {
        throw new Error('插件包身份与目录记录不一致')
      }
      if (verified.manifest.minimumAppVersion !== entry.minimumAppVersion ||
        verified.manifest.maximumAppVersion !== entry.maximumAppVersion) {
        throw new Error('插件包兼容范围与目录记录不一致')
      }
      assertManifestCompatibility(verified.manifest, this.options.appVersion)
      const automaticSafe = !current || safeAutomaticUpgrade(current.manifest, verified.manifest)
      if (current && !explicit && !automaticSafe) return current
      const reauthorization = current ? reauthorizationContributionIds(current.manifest, verified.manifest) : []
      const breaking = Boolean(current && (
        major(current.manifest.version) !== major(verified.manifest.version) || reauthorization.length > 0
      ))
      if (breaking && !confirmPermissionExpansion) {
        throw new Error('插件更新包含主版本或权限范围变化，需要确认后重新授权')
      }
      const previousManifest = current?.manifest ?? null
      this.options.host.registerVerifiedPackage(verified.manifest)
      let installed: InstalledPluginPackage
      try {
        await this.options.entries.stageAndActivate(verified)
        for (const contribution of verified.manifest.contributions) {
          await this.options.entries.readEntry(verified.manifest.id, verified.manifest.version, contribution.entry)
        }
        installed = this.options.repository.upsertPluginPackage(verified.manifest, {
          source: 'catalog',
          status: 'active',
          packageHash: verified.archiveHash,
          publisherKeyId: entry.publisherKeyId,
          enabled: current?.enabled ?? false,
          development: false
        })
      } catch (error) {
        restoreRegistry(this.options.host, verified.manifest.id, previousManifest)
        throw error
      }
      if (breaking) {
        const ids = major(current!.manifest.version) !== major(verified.manifest.version)
          ? verified.manifest.contributions.map((item) => item.id)
          : reauthorization
        this.options.repository.suspendPluginContributions(
          verified.manifest.id,
          ids,
          '插件更新扩大了权限或安全边界，请重新确认授权'
        )
      }
      this.options.repository.setPluginUpdateAvailable(entry.pluginId, null)
      return installed
    } catch (error) {
      // The database still points to the previously verified version; leave it active for rollback.
      throw error
    } finally {
      response.body.fill(0)
    }
  }

  private applyCatalogState(): void {
    if (!this.catalog) return
    for (const installed of this.options.repository.listInstalledPluginPackages()) {
      if (installed.source !== 'catalog') continue
      if (catalogContainsRevocation(this.catalog, installed.manifest.id, installed.manifest.version, installed.packageHash)) {
        this.stop(installed.manifest.id)
        this.options.repository.setPluginPackageStatus(installed.manifest.id, 'revoked', '此插件版本已被签名目录撤销')
        continue
      }
      const resolution = resolveLatestCompatiblePlugin(this.catalog, installed.manifest.id, this.options.appVersion)
      const available = resolution.entry && resolution.entry.version !== installed.manifest.version
        ? resolution.entry.version
        : null
      this.options.repository.setPluginUpdateAvailable(installed.manifest.id, available)
    }
  }

  private async applySafeAutomaticUpdates(): Promise<void> {
    if (!this.catalog) return
    for (const installed of this.options.repository.listInstalledPluginPackages()) {
      if (installed.source !== 'catalog' || installed.status !== 'active') continue
      const resolution = resolveLatestCompatiblePlugin(this.catalog, installed.manifest.id, this.options.appVersion)
      if (!resolution.entry || resolution.entry.version === installed.manifest.version) continue
      if (major(resolution.entry.version) !== major(installed.manifest.version)) continue
      try {
        await this.installCatalogEntry(resolution.entry, false, false)
      } catch {
        // Keep the verified previous version available for explicit retry/rollback.
      }
    }
  }

  private resolveEntry(pluginId: string): PluginCatalogEntry {
    if (!this.catalog) throw new Error('请先刷新插件目录')
    const resolution = resolveLatestCompatiblePlugin(this.catalog, pluginId, this.options.appVersion)
    if (!resolution.entry) throw new Error(
      resolution.reason === 'revoked' ? '插件已被目录撤销' :
        resolution.reason === 'incompatible' ? '插件与当前归页版本不兼容' : '目录中没有此插件'
    )
    return resolution.entry
  }

  private requireInstalled(pluginId: string): InstalledPluginPackage {
    const installed = this.options.repository.getInstalledPluginPackage(pluginId)
    if (!installed) throw new Error('插件包不存在')
    return installed
  }

  private configured(): boolean {
    return /^https:\/\//.test(this.options.catalogUrl) && this.options.catalogRootPublicKey.trim().length > 0
  }

  private developerMode(): boolean {
    return this.options.repository.getSetting<boolean>('plugins.developerMode') === true
  }
}

function safeAutomaticUpgrade(current: PluginManifestV2, next: PluginManifestV2): boolean {
  if (major(current.version) !== major(next.version)) return false
  const nextById = new Map(next.contributions.map((item) => [item.id, item]))
  for (const previous of current.contributions) {
    const candidate = nextById.get(previous.id)
    if (!candidate || candidate.kind !== previous.kind) return false
  }
  return next.contributions.length === current.contributions.length &&
    reauthorizationContributionIds(current, next).length === 0
}

function reauthorizationContributionIds(current: PluginManifestV2, next: PluginManifestV2): string[] {
  const previousById = new Map(current.contributions.map((item) => [item.id, item]))
  return next.contributions.flatMap((candidate) => {
    const previous = previousById.get(candidate.id)
    if (!previous || previous.kind !== candidate.kind) return [candidate.id]
    if (candidate.permissions.some((permission) => !previous.permissions.includes(permission))) return [candidate.id]
    if (candidate.kind === 'platform.adapter' && previous.kind === 'platform.adapter' &&
      platformSecurityFingerprint(candidate) !== platformSecurityFingerprint(previous)) return [candidate.id]
    if (candidate.kind === 'event.handler' && previous.kind === 'event.handler' &&
      candidate.events.some((event) => !previous.events.includes(event))) return [candidate.id]
    return []
  })
}

function platformSecurityFingerprint(
  contribution: Extract<PluginManifestV2['contributions'][number], { kind: 'platform.adapter' }>
): string {
  return JSON.stringify({
    navigationHosts: [...contribution.platform.navigationHosts].sort(),
    imageHosts: [...contribution.platform.imageHosts].sort(),
    contentUrls: structuredClone(contribution.platform.contentUrls).sort((left, right) => (
      `${left.origin}${left.pathTemplate}${left.remoteIdTemplate}`.localeCompare(
        `${right.origin}${right.pathTemplate}${right.remoteIdTemplate}`
      )
    )),
    endpoints: structuredClone(contribution.endpoints).sort((left, right) => left.id.localeCompare(right.id)),
    captures: structuredClone(contribution.captures).sort((left, right) => left.id.localeCompare(right.id))
  })
}

function restoreRegistry(host: PluginHostService, pluginId: string, previous: PluginManifestV2 | null): void {
  host.unregisterPackage(pluginId)
  if (previous) host.registerVerifiedPackage(previous)
}

function major(version: string): number {
  return Number(version.split('.')[0])
}

function assertManifestCompatibility(manifest: PluginManifestV2, appVersion: string): void {
  if (!isAppVersionCompatible(manifest, appVersion)) throw new Error('插件与当前归页版本不兼容')
  if (major(manifest.sdkVersion) !== 1) throw new Error('插件 SDK 主版本不受支持')
}

async function atomicWrite(path: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, bytes, { mode: 0o600 })
  try {
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : '插件操作失败')
    .replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300)
}
