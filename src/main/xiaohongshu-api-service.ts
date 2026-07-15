import { randomUUID } from 'node:crypto'
import type { Account, SyncMode } from '../shared/contracts'
import type {
  ContentMetricDefinition,
  ContentQuery,
  ContentSummary
} from '../shared/content-contracts'
import type {
  ApiIdentityCheckResult,
  ConfirmApiIdentityInput,
  XiaohongshuSyncResult
} from '../shared/xiaohongshu-api-contracts'
import type { JobRecord } from '../shared/job-contracts'
import type { ManagedSyncCommitMetadata, ManagedSyncCommitResult } from './database'
import type { XiaohongshuApiTransportLease } from './browser-manager'
import type { CachedProfileAvatar } from './profile-media'
import type { StandardDataset } from './plugins/types'
import type { SessionApiPluginGate } from './plugins/session-api-plugin-gate'
import { XIAOHONGSHU_PLATFORM_CONTRIBUTION_ID } from './plugins/builtin-manifests'
import type { JobService } from './services/job-service'
import {
  XiaohongshuApi,
  XiaohongshuApiError,
  type XiaohongshuAccountMetrics,
  type XiaohongshuApiSnapshot,
  type XiaohongshuProfile
} from './xiaohongshu-api'

export const XIAOHONGSHU_API_PLUGIN_ID = 'xiaohongshu-session-api'
export const XIAOHONGSHU_CONTENT_METRIC_DEFINITIONS: ContentMetricDefinition[] = [
  {
    id: 'impressions', label: '曝光', valueKind: 'count', unit: 'count', group: 'reach', sortOrder: 1,
    measurementKind: 'cumulative', standardMetricId: null
  },
  {
    id: 'views', label: '观看', valueKind: 'count', unit: 'count', group: 'reach', sortOrder: 2,
    measurementKind: 'cumulative', standardMetricId: 'views'
  },
  {
    id: 'cover_click_rate', label: '封面点击率', valueKind: 'ratio', unit: 'ratio', group: 'conversion', sortOrder: 3,
    measurementKind: 'gauge', standardMetricId: null
  },
  {
    id: 'likes', label: '点赞', valueKind: 'count', unit: 'count', group: 'engagement', sortOrder: 4,
    measurementKind: 'cumulative', standardMetricId: 'likes'
  },
  {
    id: 'comments', label: '评论', valueKind: 'count', unit: 'count', group: 'engagement', sortOrder: 5,
    measurementKind: 'cumulative', standardMetricId: 'comments'
  },
  {
    id: 'favorites', label: '收藏', valueKind: 'count', unit: 'count', group: 'engagement', sortOrder: 6,
    measurementKind: 'cumulative', standardMetricId: 'favorites'
  },
  {
    id: 'followers_gained', label: '涨粉', valueKind: 'count', unit: 'count', group: 'conversion', sortOrder: 7,
    measurementKind: 'cumulative', standardMetricId: null
  },
  {
    id: 'shares', label: '分享', valueKind: 'count', unit: 'count', group: 'engagement', sortOrder: 8,
    measurementKind: 'cumulative', standardMetricId: 'shares'
  },
  {
    id: 'average_view_duration', label: '人均观看时长', valueKind: 'duration', unit: 'seconds', group: 'engagement', sortOrder: 9,
    measurementKind: 'gauge', standardMetricId: null
  },
  {
    id: 'danmaku', label: '弹幕', valueKind: 'count', unit: 'count', group: 'engagement', sortOrder: 10,
    measurementKind: 'cumulative', standardMetricId: null
  }
]
const PREVIEW_TTL_MS = 5 * 60_000
const MAX_PREVIEWS = 50

interface ApiBrowser {
  acquireXiaohongshuApiTransport(accountId: string): Promise<XiaohongshuApiTransportLease>
  cacheXiaohongshuAvatar(accountId: string, sourceUrl: string): Promise<CachedProfileAvatar | null>
  pruneAccountAvatarMedia?(accountId: string, keepCacheKey: string): Promise<void>
}

interface ApiRepository {
  getAccount(id: string): Account | null
  listContents(query?: ContentQuery): ContentSummary[]
  getSetting<T>(key: string): T | null
  setSetting(key: string, value: unknown): void
  applyManagedIdentity(
    accountId: string,
    identity: {
      remoteId: string
      remoteName: string
      avatarCacheKey?: string | null
      avatarMime?: string | null
      bio?: string
      creatorLevel?: number | null
    },
    verifiedAt: string
  ): Account
  applyManagedProbeStatus(
    accountId: string,
    status: 'login_required' | 'challenge' | 'page_not_ready' | 'unsupported',
    message: string,
    observedAt: string
  ): Account
  markManagedIdentityMismatch(accountId: string, message: string, observedAt: string): Account
  markManagedSyncStarted(accountId: string, startedAt: string): Account
  markManagedSyncFailed(accountId: string, message: string, failedAt: string): Account
  commitManagedSync(
    payload: StandardDataset,
    metadata: ManagedSyncCommitMetadata
  ): ManagedSyncCommitResult
}

interface IdentityPreview {
  token: string
  accountId: string
  remoteId: string
  remoteName: string
  expiresAt: number
}

export interface XiaohongshuApiServiceOptions {
  repository: ApiRepository
  browser: ApiBrowser
  plugins: SessionApiPluginGate
  jobs: JobService
  clock?: () => Date
  createToken?: () => string
  detailWait?: (milliseconds: number) => Promise<void>
}

/** Coordinates the only live platform integration: fixed, read-only JSON APIs. */
export class XiaohongshuApiService {
  readonly pluginId = XIAOHONGSHU_API_PLUGIN_ID
  readonly contributionId = XIAOHONGSHU_PLATFORM_CONTRIBUTION_ID
  private readonly previews = new Map<string, IdentityPreview>()
  private readonly activeAccounts = new Set<string>()
  private platformSyncActive = false
  private readonly clock: () => Date
  private readonly createToken: () => string

  constructor(private readonly options: XiaohongshuApiServiceOptions) {
    this.clock = options.clock ?? (() => new Date())
    this.createToken = options.createToken ?? randomUUID
  }

  async verifyIdentity(accountId: string): Promise<ApiIdentityCheckResult> {
    return this.withAccountLock(accountId, '账号核验', async () => {
      const account = this.requireAccountAndPlugin(accountId)
      this.enforceInterval(account.id, 'identity', 60)
      let lease: XiaohongshuApiTransportLease | null = null
      try {
        lease = await this.options.browser.acquireXiaohongshuApiTransport(accountId)
        const profile = await new XiaohongshuApi(lease.transport).getProfile()
        if (account.remoteId) return await this.commitIdentity(account, profile)
        const preview = this.cachePreview(account.id, profile)
        this.options.plugins.recordSessionApiRun(XIAOHONGSHU_API_PLUGIN_ID, true)
        return {
          accountId: account.id,
          status: 'confirmation_required',
          remoteId: profile.remoteId,
          remoteName: profile.remoteName,
          confirmationToken: preview.token,
          confirmationExpiresAt: new Date(preview.expiresAt).toISOString(),
          verifiedAt: null,
          message: '已读取当前登录账号，请核对并确认。'
        }
      } catch (error) {
        return this.handleIdentityError(account.id, error, lease)
      } finally {
        lease?.release()
      }
    })
  }

  async confirmIdentity(input: ConfirmApiIdentityInput): Promise<ApiIdentityCheckResult> {
    if (!input.confirmIdentity) throw new Error('必须明确确认这是本人账号')
    return this.withAccountLock(input.accountId, '身份确认', async () => {
      this.purgeExpiredPreviews()
      const preview = this.previews.get(input.token)
      if (!preview || preview.accountId !== input.accountId) throw new Error('身份确认已过期，请重新核验')
      this.previews.delete(input.token)
      const account = this.requireAccountAndPlugin(input.accountId)
      let lease: XiaohongshuApiTransportLease | null = null
      try {
        lease = await this.options.browser.acquireXiaohongshuApiTransport(account.id)
        const profile = await new XiaohongshuApi(lease.transport).getProfile()
        if (profile.remoteId !== preview.remoteId || profile.remoteName !== preview.remoteName) {
          throw new XiaohongshuApiError('IDENTITY_MISMATCH', '确认前登录账号发生变化')
        }
        return await this.commitIdentity(account, profile)
      } catch (error) {
        return this.handleIdentityError(account.id, error, lease)
      } finally {
        lease?.release()
      }
    })
  }

  async sync(accountId: string): Promise<XiaohongshuSyncResult> {
    return this.withAccountLock(accountId, '数据同步', async () => {
      if (this.platformSyncActive) throw new Error('小红书已有一个同步任务正在运行')
      this.platformSyncActive = true
      let job: JobRecord | null = null
      let committed = false
      let lease: XiaohongshuApiTransportLease | null = null
      try {
        const account = this.requireSyncableAccount(accountId)
        const requestedMode = this.options.jobs.requestedSyncMode(
          account.syncMode as Exclude<SyncMode, 'disabled'>
        )
        const installation = this.options.plugins.requireEnabledSessionApi(XIAOHONGSHU_API_PLUGIN_ID, account.id)
        this.enforceInterval(account.id, 'sync', installation.manifest.minimumIntervalSeconds)
        const startedAt = this.now()
        job = await this.options.jobs.createManagedSync(
          account.id,
          XIAOHONGSHU_API_PLUGIN_ID,
          XIAOHONGSHU_PLATFORM_CONTRIBUTION_ID
        )
        this.options.repository.markManagedSyncStarted(account.id, startedAt)

        lease = await this.options.browser.acquireXiaohongshuApiTransport(account.id)
        const api = new XiaohongshuApi(lease.transport, { wait: this.options.detailWait })
        const capturedAt = this.now()
        const limit = requestedMode === 'recent_20' ? 20 : requestedMode === 'recent_100' ? 100 : 0
        const existingExcerpts = limit > 0
          ? new Map(this.options.repository.listContents({ accountId: account.id, limit: 5_000 }).map((content) => [
              content.remoteId,
              content.bodyExcerpt
            ]))
          : new Map<string, string>()
        const snapshot = limit === 0
          ? await collectProfileOnly(api, account.remoteId!)
          : await api.collect(account.remoteId!, limit, {
              enrichExcerpts: true,
              existingExcerpts
            })
        const cachedAvatar = await this.cacheAvatar(account.id, snapshot.profile)
        const payload = toPayload(snapshot, capturedAt, cachedAvatar)
        job = await this.options.jobs.transition(job, 'committing', { progress: 85, stage: '保存同步数据' })
        const finishedAt = this.now()
        const committedResult = this.options.repository.commitManagedSync(payload, {
          accountId: account.id,
          pluginId: XIAOHONGSHU_API_PLUGIN_ID,
          jobId: job.id,
          authorizedMode: account.syncMode as Exclude<SyncMode, 'disabled'>,
          payloadMode: requestedMode,
          finishedAt
        })
        committed = true
        await this.pruneAvatarCache(account.id, cachedAvatar)
        job = this.options.jobs.publishPersisted(committedResult.job)
        return syncResult(account, requestedMode, snapshot, capturedAt, committedResult, job)
      } catch (error) {
        if (!committed) {
          const failedAt = this.now()
          try {
            if (error instanceof XiaohongshuApiError && error.code === 'AUTH_REQUIRED') {
              this.showLoginWorkspace(lease)
              this.options.repository.applyManagedProbeStatus(accountId, 'login_required', messageOf(error), failedAt)
            } else if (error instanceof XiaohongshuApiError && error.code === 'RISK_CONTROL') {
              this.options.repository.applyManagedProbeStatus(accountId, 'challenge', messageOf(error), failedAt)
            } else if (error instanceof XiaohongshuApiError && error.code === 'IDENTITY_MISMATCH') {
              this.options.repository.markManagedIdentityMismatch(accountId, messageOf(error), failedAt)
            } else {
              this.options.repository.markManagedSyncFailed(accountId, messageOf(error), failedAt)
            }
          } catch {}
          if (job && (job.status === 'validating' || job.status === 'committing')) {
            try {
              job = await this.options.jobs.transition(job, 'failed', {
                progress: 100,
                stage: '同步失败',
                errorCode: errorCode(error),
                errorMessage: messageOf(error),
                finishedAt: failedAt
              })
            } catch {}
          }
          try {
            this.options.plugins.recordSessionApiRun(
              XIAOHONGSHU_API_PLUGIN_ID,
              false,
              messageOf(error)
            )
          } catch {}
        }
        throw error
      } finally {
        lease?.release()
        this.platformSyncActive = false
      }
    })
  }

  invalidatePreviews(): void {
    if (this.activeAccounts.size > 0) throw new Error('仍有账号操作正在执行')
    this.previews.clear()
  }

  isAccountActive(accountId: string): boolean {
    return this.activeAccounts.has(accountId)
  }

  private requireAccountAndPlugin(accountId: string): Account {
    const account = this.options.repository.getAccount(accountId)
    if (!account) throw new Error('账号不存在')
    if (account.platformId !== 'xiaohongshu') throw new Error('该平台的数据同步功能尚未开放')
    this.options.plugins.requireEnabledSessionApi(XIAOHONGSHU_API_PLUGIN_ID, account.id)
    return account
  }

  private requireSyncableAccount(accountId: string): Account {
    const account = this.requireAccountAndPlugin(accountId)
    if (!account.remoteId || account.ownershipStatus !== 'plugin_verified') throw new Error('请先核验当前账号')
    if (account.connectionStatus !== 'ready') throw new Error('账号登录状态尚未就绪，请先重新核验')
    if (!account.syncEnabled || account.syncMode === 'disabled') throw new Error('请先启用该账号的数据同步')
    return account
  }

  private async commitIdentity(
    account: Account,
    profile: XiaohongshuProfile
  ): Promise<ApiIdentityCheckResult> {
    const verifiedAt = this.now()
    const cachedAvatar = account.remoteId && account.remoteId !== profile.remoteId
      ? null
      : await this.cacheAvatar(account.id, profile)
    const updated = this.options.repository.applyManagedIdentity(account.id, {
      remoteId: profile.remoteId,
      remoteName: profile.remoteName,
      bio: profile.bio,
      creatorLevel: profile.creatorLevel,
      ...(cachedAvatar
        ? { avatarCacheKey: cachedAvatar.cacheKey, avatarMime: cachedAvatar.mime }
        : {})
    }, verifiedAt)
    const mismatch = updated.connectionStatus === 'mismatch'
    if (!mismatch) await this.pruneAvatarCache(account.id, cachedAvatar)
    this.options.plugins.recordSessionApiRun(XIAOHONGSHU_API_PLUGIN_ID, true)
    return {
      accountId: account.id,
      status: mismatch ? 'identity_mismatch' : 'verified',
      remoteId: profile.remoteId,
      remoteName: profile.remoteName,
      confirmationToken: null,
      confirmationExpiresAt: null,
      verifiedAt: mismatch ? null : verifiedAt,
      message: mismatch
        ? '当前账号与已绑定账号不一致，已停止同步。'
        : '当前账号已核验。'
    }
  }

  private handleIdentityError(
    accountId: string,
    error: unknown,
    lease: XiaohongshuApiTransportLease | null
  ): ApiIdentityCheckResult {
    const message = messageOf(error)
    this.options.plugins.recordSessionApiRun(XIAOHONGSHU_API_PLUGIN_ID, false, message)
    if (error instanceof XiaohongshuApiError && error.code === 'AUTH_REQUIRED') {
      this.showLoginWorkspace(lease)
      this.options.repository.applyManagedProbeStatus(accountId, 'login_required', message, this.now())
      return {
        accountId,
        status: 'login_required',
        remoteId: null,
        remoteName: null,
        confirmationToken: null,
        confirmationExpiresAt: null,
        verifiedAt: null,
        message
      }
    }
    if (error instanceof XiaohongshuApiError && error.code === 'RISK_CONTROL') {
      this.options.repository.applyManagedProbeStatus(accountId, 'challenge', message, this.now())
    }
    throw error
  }

  private showLoginWorkspace(lease: XiaohongshuApiTransportLease | null): void {
    if (!lease) return
    try {
      lease.showForLogin()
    } catch {}
  }

  private async cacheAvatar(
    accountId: string,
    profile: XiaohongshuProfile
  ): Promise<CachedProfileAvatar | null> {
    if (!profile.avatarUrl) return null
    try {
      return await this.options.browser.cacheXiaohongshuAvatar(accountId, profile.avatarUrl)
    } catch {
      return null
    }
  }

  private async pruneAvatarCache(
    accountId: string,
    cachedAvatar: CachedProfileAvatar | null
  ): Promise<void> {
    if (!cachedAvatar || !this.options.browser.pruneAccountAvatarMedia) return
    try {
      await this.options.browser.pruneAccountAvatarMedia(accountId, cachedAvatar.cacheKey)
    } catch {}
  }

  private cachePreview(accountId: string, profile: XiaohongshuProfile): IdentityPreview {
    this.purgeExpiredPreviews()
    while (this.previews.size >= MAX_PREVIEWS) {
      const first = this.previews.keys().next().value as string | undefined
      if (!first) break
      this.previews.delete(first)
    }
    const preview = {
      token: this.createToken(),
      accountId,
      remoteId: profile.remoteId,
      remoteName: profile.remoteName,
      expiresAt: this.nowDate().getTime() + PREVIEW_TTL_MS
    }
    this.previews.set(preview.token, preview)
    return preview
  }

  private purgeExpiredPreviews(): void {
    const now = this.nowDate().getTime()
    for (const [token, preview] of this.previews) {
      if (preview.expiresAt <= now) this.previews.delete(token)
    }
  }

  private enforceInterval(accountId: string, operation: 'identity' | 'sync', seconds: number): void {
    const key = `xiaohongshu_api_last_started:${operation}:${accountId}`
    const now = this.nowDate()
    const previous = this.options.repository.getSetting<string>(key)
    if (previous) {
      const elapsed = now.getTime() - new Date(previous).getTime()
      const minimum = seconds * 1_000
      if (Number.isFinite(elapsed) && elapsed >= 0 && elapsed < minimum) {
        throw new Error(`操作过于频繁，请在 ${Math.ceil((minimum - elapsed) / 1_000)} 秒后重试`)
      }
    }
    this.options.repository.setSetting(key, now.toISOString())
  }

  private async withAccountLock<T>(accountId: string, label: string, action: () => Promise<T>): Promise<T> {
    if (this.activeAccounts.has(accountId)) throw new Error(`该账号正在执行其他操作，不能同时开始${label}`)
    this.activeAccounts.add(accountId)
    try {
      return await action()
    } finally {
      this.activeAccounts.delete(accountId)
    }
  }

  private nowDate(): Date {
    const value = this.clock()
    if (!Number.isFinite(value.getTime())) throw new Error('API 服务时钟无效')
    return value
  }

  private now(): string {
    return this.nowDate().toISOString()
  }
}

async function collectProfileOnly(
  api: XiaohongshuApi,
  expectedRemoteId: string
): Promise<XiaohongshuApiSnapshot> {
  const before = await api.getProfile()
  if (before.remoteId !== expectedRemoteId) throw identityMismatch(before.remoteId, expectedRemoteId)
  const accountMetrics = await api.getAccountMetrics()
  const after = await api.getProfile()
  if (after.remoteId !== expectedRemoteId) throw identityMismatch(after.remoteId, expectedRemoteId)
  if (before.remoteId !== after.remoteId || before.remoteName !== after.remoteName) {
    throw new XiaohongshuApiError('IDENTITY_MISMATCH', '采集期间小红书登录身份发生变化')
  }
  return {
    identity: { remoteId: after.remoteId, remoteName: after.remoteName },
    profile: after,
    accountMetrics,
    contents: [],
    warnings: []
  }
}

function toPayload(
  snapshot: XiaohongshuApiSnapshot,
  capturedAt: string,
  cachedAvatar: CachedProfileAvatar | null
): StandardDataset {
  const metrics = snapshot.accountMetrics.thirty
  return {
    capturedAt,
    contentMetricDefinitions: XIAOHONGSHU_CONTENT_METRIC_DEFINITIONS,
    profile: {
      remoteId: snapshot.profile.remoteId,
      remoteName: snapshot.profile.remoteName,
      bio: snapshot.profile.bio,
      creatorLevel: snapshot.profile.creatorLevel,
      ...(cachedAvatar
        ? { avatarCacheKey: cachedAvatar.cacheKey, avatarMime: cachedAvatar.mime }
        : {}),
      followers: snapshot.profile.followers,
      following: snapshot.profile.following,
      contentCount: null,
      viewsTotal: metrics.views,
      likesAndFavoritesTotal: snapshot.profile.likesAndFavorites,
      views: metrics.views,
      likes: metrics.likes,
      comments: metrics.comments,
      shares: metrics.shares,
      favorites: metrics.favorites
    },
    contents: snapshot.contents.map((content) => ({
      remoteId: content.id,
      type: content.type ?? 'post',
      title: content.title,
      bodyExcerpt: content.bodyExcerpt,
      url: content.url,
      publishedAt: content.postTime,
      snapshots: [{
        capturedAt,
        views: content.readCount,
        likes: content.likeCount,
        comments: content.commentCount,
        shares: content.shareCount,
        favorites: content.favoriteCount,
        metrics: {
          impressions: content.impressions,
          cover_click_rate: content.coverClickRate,
          followers_gained: content.followersGained,
          average_view_duration: content.averageViewDurationSeconds,
          danmaku: content.danmaku
        }
      }]
    })),
    warnings: snapshot.warnings
  }
}

function syncResult(
  account: Account,
  mode: Exclude<SyncMode, 'disabled'>,
  snapshot: XiaohongshuApiSnapshot,
  capturedAt: string,
  committed: ManagedSyncCommitResult,
  job: JobRecord
): XiaohongshuSyncResult {
  const excerptCount = snapshot.contents.filter((content) => Boolean(content.bodyExcerpt)).length
  const missingExcerptCount = snapshot.contents.length - excerptCount
  const excerptMessage = excerptCount > 0
    ? `其中 ${excerptCount} 条包含正文摘要。`
    : ''
  const missingExcerptMessage = missingExcerptCount > 0
    ? snapshot.warnings.length > 0
      ? `${missingExcerptCount} 条摘要将在后续同步中继续补齐。`
      : `${missingExcerptCount} 条作品的平台详情未提供摘要。`
    : ''
  return {
    accountId: account.id,
    mode,
    capturedAt,
    profile: {
      remoteId: snapshot.profile.remoteId,
      remoteName: snapshot.profile.remoteName,
      avatarAvailable: Boolean(snapshot.profile.avatarUrl),
      followers: snapshot.profile.followers,
      following: snapshot.profile.following,
      likesAndFavorites: snapshot.profile.likesAndFavorites,
      bio: snapshot.profile.bio,
      creatorLevel: snapshot.profile.creatorLevel
    },
    contentCount: snapshot.contents.length,
    stats: committed.stats,
    job,
    message: snapshot.contents.length > 0
      ? `已同步账号资料和 ${snapshot.contents.length} 条作品。${excerptMessage}${missingExcerptMessage}`
      : '已同步账号资料和账号指标。'
  }
}

function identityMismatch(actual: string, expected: string): XiaohongshuApiError {
  return new XiaohongshuApiError(
    'IDENTITY_MISMATCH',
    `当前 API 身份 ${actual} 与本地绑定身份 ${expected} 不一致`
  )
}

function errorCode(error: unknown): string {
  return error instanceof XiaohongshuApiError ? error.code : 'API_SYNC_FAILED'
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
