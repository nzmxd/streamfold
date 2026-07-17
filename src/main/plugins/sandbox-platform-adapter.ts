import { randomUUID } from 'node:crypto'
import type { Account, SyncMode } from '../../shared/contracts'
import type {
  AccountMetricDefinition,
  AccountMetricPeriod,
  ContentMetricDefinition
} from '../../shared/content-contracts'
import type { JobRecord } from '../../shared/job-contracts'
import type {
  ConfirmSessionApiIdentityInput,
  SessionApiIdentityCheckResult,
  SessionApiSyncResult
} from '../../shared/session-api-contracts'
import type { ManagedSyncCommitMetadata, ManagedSyncCommitResult } from '../database'
import { isOfficialContentUrl } from '../platforms'
import type { SessionApiPlatformService } from '../platform-sync-service'
import type { JobService } from '../services/job-service'
import type {
  StandardAccountMetricSnapshot,
  StandardDataset,
  StandardProfile
} from './types'
import type { PluginHostService } from './plugin-host-service'
import { PluginPlatformSessionError, type PluginRuntimeExecutor } from './plugin-runtime-executor'
import {
  PluginSupplyChainError,
  isPluginSupplyChainError,
  type PluginSupplyChainErrorCode
} from './supply-chain-errors'

interface SandboxAdapterRepository {
  getAccount(id: string): Account | null
  applyManagedIdentity(accountId: string, identity: {
    remoteId: string
    remoteName: string
    bio?: string
    creatorLevel?: number | null
  }, verifiedAt: string): Account
  markManagedIdentityMismatch(accountId: string, message: string, observedAt: string): Account
  markManagedSyncStarted(accountId: string, startedAt: string): Account
  markManagedSyncFailed(accountId: string, message: string, failedAt: string): Account
  applyManagedProbeStatus(
    accountId: string,
    probeStatus: 'login_required' | 'challenge' | 'page_not_ready' | 'unsupported',
    message: string,
    observedAt: string
  ): Account
  commitManagedSync(payload: StandardDataset, metadata: ManagedSyncCommitMetadata): ManagedSyncCommitResult
}

interface IdentityPreview {
  token: string
  accountId: string
  remoteId: string
  remoteName: string
  expiresAt: number
}

export interface SandboxAvatarCache {
  cacheAvatar(accountId: string, sourceUrl: string): Promise<{ cacheKey: string; mime: string } | null>
}

const PREVIEW_TTL_MS = 5 * 60_000
const OFFICIAL_X_PLUGIN_ID = 'streamfold.x'
const OFFICIAL_X_CONTRIBUTION_ID = 'streamfold.x.platform'
const OFFICIAL_IDENTITY_FAILURE_KEY = '__streamfoldFailure'
const INVALID_IDENTITY_FAILURE_MESSAGE =
  '平台身份核验未完成，请确认已经登录并等待页面加载完成；若持续失败，请停止重试并更新归页。'
const X_IDENTITY_FAILURES: ReadonlyMap<string, {
  code: PluginSupplyChainErrorCode
  message: string
}> = new Map([
  ['X_IDENTITY_SETTINGS_EMPTY', {
    code: 'PLUGIN_ADAPTER_IDENTITY_SETTINGS_EMPTY',
    message: '未捕获到 X 当前登录账号设置，请确认已经登录并等待 X 首页加载完成后重试。'
  }],
  ['X_IDENTITY_CURRENT_PROFILE_EMPTY', {
    code: 'PLUGIN_ADAPTER_IDENTITY_PROFILE_EMPTY',
    message: '已识别 X 登录账号，但未捕获到当前账号资料，请在 X 首页停留片刻后重试。'
  }],
  ['X_IDENTITY_RESPONSE_INVALID', {
    code: 'PLUGIN_ADAPTER_IDENTITY_RESPONSE_INVALID',
    message: 'X 返回的身份资料结构暂不受支持，请停止重试并更新归页。'
  }],
  ['X_IDENTITY_STABLE_ID_VERIFY_FAILED', {
    code: 'PLUGIN_ADAPTER_IDENTITY_STABLE_ID_FAILED',
    message: '当前 X 账号资料已读取，但稳定账号 ID 复核失败；为避免账号串绑，本次核验已终止，请更新归页。'
  }]
])

/** Host orchestration shared by every untrusted platform.adapter contribution. */
export class SandboxPlatformAdapter implements SessionApiPlatformService {
  private readonly activeAccounts = new Set<string>()
  private readonly previews = new Map<string, IdentityPreview>()
  private syncing = false

  constructor(
    readonly pluginId: string,
    readonly contributionId: string,
    readonly platformId: string,
    private readonly repository: SandboxAdapterRepository,
    private readonly host: PluginHostService,
    private readonly runtime: PluginRuntimeExecutor,
    private readonly jobs: JobService,
    private readonly clock: () => Date = () => new Date(),
    private readonly avatars?: SandboxAvatarCache
  ) {}

  async verifyIdentity(accountId: string): Promise<SessionApiIdentityCheckResult> {
    return await this.withAccountLock(accountId, async () => {
      const account = this.requireAccount(accountId)
      const identity = await this.readIdentity(accountId, account.remoteId)
      if (account.remoteId) return this.commitIdentity(account, identity)
      const preview: IdentityPreview = {
        token: randomUUID(),
        accountId,
        remoteId: identity.remoteId,
        remoteName: identity.remoteName,
        expiresAt: this.clock().getTime() + PREVIEW_TTL_MS
      }
      this.previews.set(preview.token, preview)
      return {
        accountId,
        status: 'confirmation_required',
        remoteId: preview.remoteId,
        remoteName: preview.remoteName,
        confirmationToken: preview.token,
        confirmationExpiresAt: new Date(preview.expiresAt).toISOString(),
        verifiedAt: null,
        message: '已读取当前登录账号，请核对并确认。'
      }
    })
  }

  async probeIdentity(accountId: string): Promise<{ remoteId: string; remoteName: string }> {
    return await this.withAccountLock(accountId, async () => {
      const account = this.repository.getAccount(accountId)
      if (!account || account.platformId !== this.platformId) throw new Error('候选适配器与账号平台不匹配')
      const state = this.host.listContributions().find((item) => (
        item.pluginId === this.pluginId && item.contribution.id === this.contributionId
      ))
      if (!state?.enabled || !state.granted || state.suspendedReason) throw new Error('候选适配器未启用或尚未授权')
      const identity = await this.readIdentity(accountId, account.remoteId, true)
      return { remoteId: identity.remoteId, remoteName: identity.remoteName }
    })
  }

  async confirmIdentity(input: ConfirmSessionApiIdentityInput): Promise<SessionApiIdentityCheckResult> {
    if (!input.confirmIdentity) throw new Error('必须明确确认这是本人账号')
    return await this.withAccountLock(input.accountId, async () => {
      this.purgePreviews()
      const preview = this.previews.get(input.token)
      if (!preview || preview.accountId !== input.accountId) throw new Error('身份确认已过期，请重新核验')
      this.previews.delete(input.token)
      const account = this.requireAccount(input.accountId)
      const identity = await this.readIdentity(input.accountId, preview.remoteId)
      if (identity.remoteId !== preview.remoteId || identity.remoteName !== preview.remoteName) {
        this.repository.markManagedIdentityMismatch(account.id, '确认前登录账号发生变化', this.now())
        return identityResult(account.id, identity, 'identity_mismatch', null, '确认前登录账号发生变化，已暂停同步。')
      }
      return this.commitIdentity(account, identity)
    })
  }

  async sync(accountId: string): Promise<SessionApiSyncResult> {
    return await this.withAccountLock(accountId, async () => {
      if (this.syncing) throw new Error('该平台适配器已有同步任务正在运行')
      this.syncing = true
      let job: JobRecord | null = null
      let committed = false
      try {
        const account = this.requireSyncableAccount(accountId)
        const requestedMode = this.jobs.requestedSyncMode(
          account.syncMode as Exclude<SyncMode, 'disabled'>
        )
        this.enforceMinimumInterval(account)
        job = await this.jobs.createManagedSync(account.id, this.pluginId, this.contributionId)
        this.repository.markManagedSyncStarted(account.id, this.now())
        const before = await this.readIdentity(account.id, account.remoteId)
        if (before.remoteId !== account.remoteId) throw new Error('当前登录身份与已绑定账号不一致')
        const raw = await this.runtime.invoke(
          this.pluginId,
          this.contributionId,
          'collect',
          account.id,
          { scope: requestedMode, boundRemoteId: before.remoteId }
        )
        const dataset = parseDataset(raw, this.platformId)
        const after = await this.readIdentity(account.id, account.remoteId)
        if (after.remoteId !== before.remoteId || after.remoteId !== account.remoteId) {
          throw new Error('同步期间平台登录身份发生变化')
        }
        if (!dataset.profile) dataset.profile = identityProfile(after)
        if (dataset.profile.remoteId !== account.remoteId) throw new Error('插件数据集身份与已绑定账号不一致')
        const avatarUrl = dataset.profile.avatarUrl || after.avatarUrl
        if (avatarUrl && this.avatars) {
          try {
            const cached = await this.avatars.cacheAvatar(account.id, avatarUrl)
            if (cached) {
              dataset.profile.avatarCacheKey = cached.cacheKey
              dataset.profile.avatarMime = cached.mime
            }
          } catch {
            dataset.warnings.push('账号头像暂时无法缓存，已保留现有头像。')
          }
        }
        delete dataset.profile.avatarUrl
        job = await this.jobs.transition(job, 'committing', { progress: 85, stage: '保存同步数据' })
        const finishedAt = this.now()
        const result = this.repository.commitManagedSync(dataset, {
          accountId: account.id,
          pluginId: this.pluginId,
          jobId: job.id,
          authorizedMode: account.syncMode as Exclude<SyncMode, 'disabled'>,
          payloadMode: requestedMode,
          finishedAt
        })
        committed = true
        job = this.jobs.publishPersisted(result.job)
        return toSyncResult(account, requestedMode, dataset, result, job)
      } catch (error) {
        if (!committed) {
          const message = safeMessage(error)
          try {
            if (error instanceof PluginPlatformSessionError) {
              this.repository.applyManagedProbeStatus(
                accountId,
                error.kind === 'expired' ? 'login_required' : 'challenge',
                message,
                this.now()
              )
            } else {
              this.repository.markManagedSyncFailed(accountId, message, this.now())
            }
          } catch {}
          if (job && (job.status === 'validating' || job.status === 'committing')) {
            try {
              await this.jobs.transition(job, 'failed', {
                progress: 100,
                stage: '同步失败',
                errorCode: 'PLUGIN_ADAPTER_FAILED',
                errorMessage: message,
                finishedAt: this.now()
              })
            } catch {}
          }
        }
        throw error
      } finally {
        this.syncing = false
      }
    })
  }

  isAccountActive(accountId: string): boolean {
    return this.activeAccounts.has(accountId)
  }

  invalidatePreviews(): void {
    if (this.activeAccounts.size) throw new Error('仍有账号操作正在执行')
    this.previews.clear()
  }

  private async readIdentity(
    accountId: string,
    expectedRemoteId: string | null,
    allowUnboundAdapter = false
  ): Promise<Identity> {
    try {
      const value = allowUnboundAdapter
        ? await this.runtime.invoke(
            this.pluginId,
            this.contributionId,
            'readIdentity',
            accountId,
            { expectedRemoteId },
            true
          )
        : await this.runtime.invoke(
            this.pluginId,
            this.contributionId,
            'readIdentity',
            accountId,
            { expectedRemoteId }
          )
      const reportedFailure = officialXIdentityFailure(this.pluginId, this.contributionId, value)
      if (reportedFailure) throw reportedFailure
      return parseIdentity(value)
    } catch (error) {
      if (isPluginSupplyChainError(error) && error.code === 'PLUGIN_SANDBOX_FAILED') {
        throw new PluginSupplyChainError(
          'PLUGIN_ADAPTER_IDENTITY_FAILED',
          INVALID_IDENTITY_FAILURE_MESSAGE,
          { cause: error }
        )
      }
      throw error
    }
  }

  private commitIdentity(account: Account, identity: Identity): SessionApiIdentityCheckResult {
    const verifiedAt = this.now()
    const updated = this.repository.applyManagedIdentity(account.id, {
      remoteId: identity.remoteId,
      remoteName: identity.remoteName,
      bio: identity.bio,
      creatorLevel: identity.creatorLevel
    }, verifiedAt)
    const mismatch = updated.connectionStatus === 'mismatch'
    return identityResult(
      account.id,
      identity,
      mismatch ? 'identity_mismatch' : 'verified',
      mismatch ? null : verifiedAt,
      mismatch ? '当前账号与已绑定账号不一致，已停止同步。' : '当前账号已核验。'
    )
  }

  private requireAccount(accountId: string): Account {
    const account = this.repository.getAccount(accountId)
    if (!account) throw new Error('账号不存在')
    if (account.platformId !== this.platformId) throw new Error('账号平台与适配器不匹配')
    if (account.adapterContributionId !== this.contributionId) throw new Error('账号未绑定此平台适配器')
    const state = this.host.listContributions().find((item) => (
      item.pluginId === this.pluginId && item.contribution.id === this.contributionId
    ))
    if (!state?.enabled || state.suspendedReason || !state.granted) throw new Error('平台适配器未启用或尚未授权')
    return account
  }

  private requireSyncableAccount(accountId: string): Account {
    const account = this.requireAccount(accountId)
    if (!account.remoteId || account.ownershipStatus !== 'plugin_verified') throw new Error('请先核验当前账号')
    if (account.connectionStatus !== 'ready') throw new Error('账号登录状态尚未就绪，请先重新核验')
    if (!account.syncEnabled || account.syncMode === 'disabled') throw new Error('请先启用该账号的数据同步')
    return account
  }

  private enforceMinimumInterval(account: Account): void {
    if (!account.lastSyncedAt) return
    const elapsed = this.clock().getTime() - Date.parse(account.lastSyncedAt)
    const minimum = this.host.platformCollectionIntervalSeconds(this.pluginId, this.contributionId) * 1_000
    if (Number.isFinite(elapsed) && elapsed >= 0 && elapsed < minimum) {
      const seconds = Math.ceil((minimum - elapsed) / 1_000)
      throw new Error(`同步过于频繁，请在 ${seconds} 秒后重试`)
    }
  }

  private async withAccountLock<T>(accountId: string, handler: () => Promise<T>): Promise<T> {
    if (this.activeAccounts.has(accountId)) throw new Error('该账号已有操作正在运行')
    this.activeAccounts.add(accountId)
    try {
      return await handler()
    } finally {
      this.activeAccounts.delete(accountId)
    }
  }

  private purgePreviews(): void {
    const now = this.clock().getTime()
    for (const [token, preview] of this.previews) if (preview.expiresAt <= now) this.previews.delete(token)
  }

  private now(): string {
    return this.clock().toISOString()
  }
}

interface Identity {
  remoteId: string
  remoteName: string
  avatarUrl: string
  bio: string
  creatorLevel: number | null
  followers: number | null
  following: number | null
  contentCount: number | null
  viewsTotal: number | null
  likesAndFavoritesTotal: number | null
}

function officialXIdentityFailure(
  pluginId: string,
  contributionId: string,
  value: Record<string, unknown>
): PluginSupplyChainError | null {
  if (pluginId !== OFFICIAL_X_PLUGIN_ID || contributionId !== OFFICIAL_X_CONTRIBUTION_ID ||
      !Object.prototype.hasOwnProperty.call(value, OFFICIAL_IDENTITY_FAILURE_KEY)) return null
  const keys = Reflect.ownKeys(value)
  const descriptor = Object.getOwnPropertyDescriptor(value, OFFICIAL_IDENTITY_FAILURE_KEY)
  const prototype = Object.getPrototypeOf(value)
  if ((prototype !== Object.prototype && prototype !== null) ||
      keys.length !== 1 || keys[0] !== OFFICIAL_IDENTITY_FAILURE_KEY || !descriptor?.enumerable ||
      !('value' in descriptor) || typeof descriptor.value !== 'string') {
    return new PluginSupplyChainError('PLUGIN_ADAPTER_IDENTITY_FAILED', INVALID_IDENTITY_FAILURE_MESSAGE)
  }
  const failure = X_IDENTITY_FAILURES.get(descriptor.value)
  if (!failure) return new PluginSupplyChainError('PLUGIN_ADAPTER_IDENTITY_FAILED', INVALID_IDENTITY_FAILURE_MESSAGE)
  return new PluginSupplyChainError(failure.code, failure.message)
}

function parseIdentity(value: Record<string, unknown>): Identity {
  const profile = record(value.profile)
  const remoteId = text(value.remoteId ?? value.stableId, '稳定账号 ID', 1, 256)
  const remoteName = text(value.remoteName ?? value.nickname, '账号昵称', 1, 200)
  return {
    remoteId,
    remoteName,
    avatarUrl: optionalText(profile.avatarUrl ?? value.avatarUrl, 2_048),
    bio: optionalText(profile.bio, 2_000),
    creatorLevel: nullableNumber(profile.creatorLevel),
    followers: nullableNumber(profile.followers),
    following: nullableNumber(profile.following),
    contentCount: nullableNumber(profile.contentCount),
    viewsTotal: nullableNumber(profile.viewsTotal),
    likesAndFavoritesTotal: nullableNumber(profile.likesAndFavoritesTotal)
  }
}

function parseDataset(value: Record<string, unknown>, platformId: string): StandardDataset {
  const capturedAt = text(value.capturedAt, '采集时间', 10, 40)
  if (new Date(capturedAt).toISOString() !== capturedAt) throw new Error('插件采集时间无效')
  const profile = value.profile === null || value.profile === undefined ? null : parseProfile(record(value.profile))
  const contentMetricDefinitions = parseContentMetricDefinitions(value.contentMetricDefinitions)
  const accountMetricDefinitions = parseAccountMetricDefinitions(value.accountMetricDefinitions)
  const accountMetricSnapshots = parseAccountMetricSnapshots(value.accountMetricSnapshots)
  if (!Array.isArray(value.contents) || value.contents.length > 5_000) throw new Error('插件内容数据集无效')
  const contents = value.contents.map((item) => {
    const content = record(item)
    if (!['article', 'video', 'image', 'post', 'answer'].includes(String(content.type))) {
      throw new Error('插件内容类型无效')
    }
    if (!Array.isArray(content.snapshots) || content.snapshots.length > 1_000) throw new Error('插件指标快照无效')
    const remoteId = text(content.remoteId, '内容 ID', 1, 256)
    const url = optionalText(content.url, 2_048)
    if (url && !isOfficialContentUrl(platformId, url, remoteId)) {
      throw new Error('插件返回了未在清单中声明的原帖链接')
    }
    return {
      remoteId,
      type: content.type as 'article' | 'video' | 'image' | 'post' | 'answer',
      title: optionalText(content.title, 500),
      bodyExcerpt: optionalText(content.bodyExcerpt, 4_000),
      url,
      publishedAt: content.publishedAt === null || content.publishedAt === undefined
        ? null
        : text(content.publishedAt, '发布时间', 10, 40),
      snapshots: content.snapshots.map((snapshot) => {
        const metrics = record(snapshot)
        return {
          views: nullableNumber(metrics.views),
          likes: nullableNumber(metrics.likes),
          comments: nullableNumber(metrics.comments),
          shares: nullableNumber(metrics.shares),
          favorites: nullableNumber(metrics.favorites),
          metrics: parseDynamicMetrics(metrics.metrics),
          capturedAt: text(metrics.capturedAt, '快照时间', 10, 40)
        }
      })
    }
  })
  const warnings = Array.isArray(value.warnings)
    ? value.warnings.slice(0, 100).map((item) => text(item, '插件警告', 0, 500))
    : []
  return {
    capturedAt,
    profile,
    contents,
    ...(contentMetricDefinitions === undefined ? {} : { contentMetricDefinitions }),
    ...(accountMetricDefinitions === undefined ? {} : { accountMetricDefinitions }),
    ...(accountMetricSnapshots === undefined ? {} : { accountMetricSnapshots }),
    warnings
  }
}

function parseContentMetricDefinitions(value: unknown): ContentMetricDefinition[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value) || value.length > 100) throw new Error('插件内容指标定义无效')
  const ids = new Set<string>()
  const standardIds = new Set<string>()
  return value.map((raw) => {
    const definition = record(raw)
    const id = text(definition.id, '内容指标 ID', 1, 64)
    if (!/^[a-z][a-z0-9._-]{0,63}$/.test(id) || ids.has(id)) throw new Error('插件内容指标 ID 无效或重复')
    ids.add(id)
    const valueKind = text(definition.valueKind, '内容指标类型', 1, 16)
    const unit = text(definition.unit, '内容指标单位', 1, 16)
    const group = text(definition.group, '内容指标分组', 1, 16)
    if (!['count', 'ratio', 'duration'].includes(valueKind) ||
      !['count', 'ratio', 'seconds'].includes(unit) ||
      !['reach', 'engagement', 'conversion', 'other'].includes(group)) {
      throw new Error('插件内容指标定义无效')
    }
    if ((valueKind === 'count' && unit !== 'count') ||
      (valueKind === 'ratio' && unit !== 'ratio') ||
      (valueKind === 'duration' && unit !== 'seconds')) {
      throw new Error('插件内容指标单位无效')
    }
    if (!Number.isSafeInteger(definition.sortOrder) || (definition.sortOrder as number) < 0 ||
      (definition.sortOrder as number) > 10_000) {
      throw new Error('插件内容指标排序无效')
    }
    const measurementKind = definition.measurementKind === undefined
      ? undefined
      : text(definition.measurementKind, '内容指标测量语义', 1, 20)
    if (measurementKind !== undefined && !['cumulative', 'period_total', 'gauge'].includes(measurementKind)) {
      throw new Error('插件内容指标测量语义无效')
    }
    const standardMetricId = definition.standardMetricId === undefined || definition.standardMetricId === null
      ? definition.standardMetricId as null | undefined
      : text(definition.standardMetricId, '标准内容指标', 1, 20)
    if (standardMetricId !== undefined && standardMetricId !== null &&
      !['views', 'likes', 'comments', 'shares', 'favorites'].includes(standardMetricId)) {
      throw new Error('插件标准内容指标无效')
    }
    if (standardMetricId && standardIds.has(standardMetricId)) {
      throw new Error('插件标准内容指标映射重复')
    }
    if (standardMetricId) standardIds.add(standardMetricId)
    return {
      id,
      label: text(definition.label, '内容指标名称', 1, 40),
      valueKind: valueKind as ContentMetricDefinition['valueKind'],
      unit: unit as ContentMetricDefinition['unit'],
      group: group as ContentMetricDefinition['group'],
      sortOrder: definition.sortOrder as number,
      ...(measurementKind === undefined ? {} : {
        measurementKind: measurementKind as ContentMetricDefinition['measurementKind']
      }),
      ...(standardMetricId === undefined ? {} : {
        standardMetricId: standardMetricId as ContentMetricDefinition['standardMetricId']
      })
    }
  })
}

function parseAccountMetricDefinitions(value: unknown): AccountMetricDefinition[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value) || value.length > 100) throw new Error('插件账号指标定义无效')
  const ids = new Set<string>()
  return value.map((raw) => {
    const definition = record(raw)
    const id = text(definition.id, '账号指标 ID', 1, 64)
    if (!/^[a-z][a-z0-9._-]{0,63}$/.test(id) || ids.has(id)) throw new Error('插件账号指标 ID 无效或重复')
    ids.add(id)
    const valueKind = text(definition.valueKind, '账号指标类型', 1, 16)
    const unit = text(definition.unit, '账号指标单位', 1, 16)
    const group = text(definition.group, '账号指标分组', 1, 16)
    if (!['count', 'ratio', 'duration'].includes(valueKind) ||
      !['count', 'ratio', 'seconds'].includes(unit) ||
      !['reach', 'engagement', 'conversion', 'other'].includes(group)) {
      throw new Error('插件账号指标定义无效')
    }
    if ((valueKind === 'count' && unit !== 'count') ||
      (valueKind === 'ratio' && unit !== 'ratio') ||
      (valueKind === 'duration' && unit !== 'seconds')) {
      throw new Error('插件账号指标单位无效')
    }
    if (!Number.isSafeInteger(definition.sortOrder) || (definition.sortOrder as number) < 0 ||
      (definition.sortOrder as number) > 10_000) {
      throw new Error('插件账号指标排序无效')
    }
    return {
      id,
      label: text(definition.label, '账号指标名称', 1, 40),
      valueKind: valueKind as AccountMetricDefinition['valueKind'],
      unit: unit as AccountMetricDefinition['unit'],
      group: group as AccountMetricDefinition['group'],
      sortOrder: definition.sortOrder as number
    }
  })
}

function parseAccountMetricSnapshots(value: unknown): StandardAccountMetricSnapshot[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value) || value.length > 5_000) throw new Error('插件账号指标快照无效')
  const periods = new Set<AccountMetricPeriod>([
    'daily', 'last_7_days', 'last_14_days', 'last_30_days', 'lifetime'
  ])
  return value.map((raw) => {
    const snapshot = record(raw)
    const period = text(snapshot.period, '账号指标周期', 1, 32) as AccountMetricPeriod
    if (!periods.has(period)) throw new Error('插件账号指标周期无效')
    const periodStart = snapshot.periodStart === null
      ? null
      : text(snapshot.periodStart, '账号指标开始日期', 10, 10)
    const status = snapshot.status === undefined || snapshot.status === null
      ? null
      : text(snapshot.status, '账号指标状态', 1, 100)
    return {
      period,
      periodStart,
      periodEnd: text(snapshot.periodEnd, '账号指标结束日期', 10, 10),
      status,
      metrics: parseDynamicMetrics(snapshot.metrics),
      capturedAt: text(snapshot.capturedAt, '账号指标采集时间', 10, 40)
    }
  })
}

function parseDynamicMetrics(value: unknown): Record<string, number | null> {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('插件动态指标无效')
  const input = value as Record<string, unknown>
  if (Object.keys(input).length > 100) throw new Error('插件动态指标数量过多')
  const result: Record<string, number | null> = {}
  for (const [metricId, metricValue] of Object.entries(input)) {
    if (!/^[a-z][a-z0-9._-]{0,63}$/.test(metricId) ||
      (metricValue !== null && (typeof metricValue !== 'number' || !Number.isFinite(metricValue)))) {
      throw new Error('插件动态指标无效')
    }
    result[metricId] = metricValue as number | null
  }
  return result
}

function parseProfile(value: Record<string, unknown>): StandardProfile {
  return {
    remoteId: text(value.remoteId, '账号 ID', 1, 256),
    remoteName: text(value.remoteName, '账号昵称', 1, 200),
    avatarUrl: optionalText(value.avatarUrl, 2_048),
    bio: optionalText(value.bio, 2_000),
    creatorLevel: nullableNumber(value.creatorLevel),
    followers: nullableNumber(value.followers),
    following: nullableNumber(value.following),
    contentCount: nullableNumber(value.contentCount),
    viewsTotal: nullableNumber(value.viewsTotal),
    likesAndFavoritesTotal: nullableNumber(value.likesAndFavoritesTotal),
    views: nullableNumber(value.views),
    likes: nullableNumber(value.likes),
    comments: nullableNumber(value.comments),
    shares: nullableNumber(value.shares),
    favorites: nullableNumber(value.favorites)
  }
}

function identityProfile(identity: Identity): StandardProfile {
  return {
    remoteId: identity.remoteId,
    remoteName: identity.remoteName,
    avatarUrl: identity.avatarUrl,
    bio: identity.bio,
    creatorLevel: identity.creatorLevel,
    followers: identity.followers,
    following: identity.following,
    contentCount: identity.contentCount,
    viewsTotal: identity.viewsTotal,
    likesAndFavoritesTotal: identity.likesAndFavoritesTotal
  }
}

function identityResult(
  accountId: string,
  identity: Identity,
  status: 'verified' | 'identity_mismatch',
  verifiedAt: string | null,
  message: string
): SessionApiIdentityCheckResult {
  return {
    accountId,
    status,
    remoteId: identity.remoteId,
    remoteName: identity.remoteName,
    confirmationToken: null,
    confirmationExpiresAt: null,
    verifiedAt,
    message
  }
}

function toSyncResult(
  account: Account,
  mode: Exclude<SyncMode, 'disabled'>,
  dataset: StandardDataset,
  committed: ManagedSyncCommitResult,
  job: JobRecord
): SessionApiSyncResult {
  const profile = dataset.profile!
  return {
    accountId: account.id,
    mode,
    capturedAt: dataset.capturedAt,
    profile: {
      remoteId: profile.remoteId,
      remoteName: profile.remoteName,
      avatarAvailable: Boolean(profile.avatarCacheKey),
      followers: profile.followers,
      following: profile.following,
      bio: profile.bio ?? '',
      contentCount: profile.contentCount,
      likesAndFavorites: profile.likesAndFavoritesTotal,
      creatorLevel: profile.creatorLevel
    },
    contentCount: dataset.contents.length,
    stats: committed.stats,
    job,
    message: `已同步账号资料和 ${dataset.contents.length} 条内容。`
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function text(value: unknown, label: string, minimum: number, maximum: number): string {
  if (typeof value !== 'string') throw new Error(`${label}无效`)
  const result = value.trim()
  if (result.length < minimum || result.length > maximum || /[\u0000-\u001f\u007f]/.test(result)) throw new Error(`${label}无效`)
  return result
}

function optionalText(value: unknown, maximum: number): string {
  return value === undefined || value === null ? '' : text(String(value), '插件文本字段', 0, maximum)
}

function nullableNumber(value: unknown): number | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('插件指标字段无效')
  return value
}

function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : '平台插件执行失败').slice(0, 500)
}
