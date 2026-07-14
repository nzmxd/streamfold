import { randomUUID } from 'node:crypto'
import type { Account, SyncMode } from '../shared/contracts'
import type { JobRecord } from '../shared/job-contracts'
import type {
  ConfirmSessionApiIdentityInput,
  SessionApiIdentityCheckResult,
  SessionApiSyncResult
} from '../shared/session-api-contracts'
import type { ManagedSyncCommitMetadata, ManagedSyncCommitResult } from './database'
import type { SessionApiPlatformService } from './platform-sync-service'
import type { CachedProfileAvatar } from './profile-media'
import type { NormalizedImportPayload } from './plugins/types'
import type { PluginService } from './plugin-service'
import type { JobService } from './services/job-service'
import {
  ZhihuApi,
  ZhihuApiError,
  type ZhihuApiSnapshot,
  type ZhihuApiTransport,
  type ZhihuIdentity,
  type ZhihuProfile
} from './zhihu-api'

export const ZHIHU_API_PLUGIN_ID = 'zhihu-session-api'

const PREVIEW_TTL_MS = 5 * 60_000
const MAX_PREVIEWS = 50

export interface ZhihuApiTransportLease {
  transport: ZhihuApiTransport
  showForLogin(): void
  release(): void
}

interface ZhihuApiBrowser {
  acquireZhihuApiTransport(accountId: string): Promise<ZhihuApiTransportLease>
  cacheZhihuAvatar(accountId: string, sourceUrl: string): Promise<CachedProfileAvatar | null>
  pruneAccountAvatarMedia?(accountId: string, keepCacheKey: string): Promise<void>
}

interface ZhihuApiRepository {
  getAccount(id: string): Account | null
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
    payload: NormalizedImportPayload,
    metadata: ManagedSyncCommitMetadata
  ): ManagedSyncCommitResult
}

interface IdentityPreview {
  token: string
  accountId: string
  remoteId: string
  remoteHandle: string
  remoteName: string
  expiresAt: number
}

export interface ZhihuApiServiceOptions {
  repository: ZhihuApiRepository
  browser: ZhihuApiBrowser
  plugins: PluginService
  jobs: JobService
  clock?: () => Date
  createToken?: () => string
}

/** Coordinates the fixed, read-only Zhihu JSON integration for an isolated account session. */
export class ZhihuApiService implements SessionApiPlatformService {
  private readonly previews = new Map<string, IdentityPreview>()
  private readonly activeAccounts = new Set<string>()
  private platformSyncActive = false
  private readonly clock: () => Date
  private readonly createToken: () => string

  constructor(private readonly options: ZhihuApiServiceOptions) {
    this.clock = options.clock ?? (() => new Date())
    this.createToken = options.createToken ?? randomUUID
  }

  async verifyIdentity(accountId: string): Promise<SessionApiIdentityCheckResult> {
    return await this.withAccountLock(accountId, '账号核验', async () => {
      const account = this.requireAccountAndPlugin(accountId)
      this.enforceInterval(account.id, 'identity', 60)
      let lease: ZhihuApiTransportLease | null = null
      try {
        lease = await this.options.browser.acquireZhihuApiTransport(account.id)
        const profile = await new ZhihuApi(lease.transport).getProfile()
        if (account.remoteId) return await this.commitIdentity(account, profile)

        const preview = this.cachePreview(account.id, profile)
        this.options.plugins.recordSessionApiRun(ZHIHU_API_PLUGIN_ID, true)
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

  async confirmIdentity(input: ConfirmSessionApiIdentityInput): Promise<SessionApiIdentityCheckResult> {
    if (!input.confirmIdentity) throw new Error('必须明确确认这是本人账号')
    return await this.withAccountLock(input.accountId, '身份确认', async () => {
      this.purgeExpiredPreviews()
      const preview = this.previews.get(input.token)
      if (!preview || preview.accountId !== input.accountId) throw new Error('身份确认已过期，请重新核验')
      this.previews.delete(input.token)

      const account = this.requireAccountAndPlugin(input.accountId)
      let lease: ZhihuApiTransportLease | null = null
      try {
        lease = await this.options.browser.acquireZhihuApiTransport(account.id)
        const profile = await new ZhihuApi(lease.transport).getProfile()
        if (
          profile.remoteId !== preview.remoteId ||
          profile.remoteHandle !== preview.remoteHandle ||
          profile.remoteName !== preview.remoteName
        ) {
          throw new ZhihuApiError('IDENTITY_MISMATCH', '确认前知乎登录账号发生变化')
        }
        return await this.commitIdentity(account, profile)
      } catch (error) {
        return this.handleIdentityError(account.id, error, lease)
      } finally {
        lease?.release()
      }
    })
  }

  async sync(accountId: string): Promise<SessionApiSyncResult> {
    return await this.withAccountLock(accountId, '数据同步', async () => {
      if (this.platformSyncActive) throw new Error('知乎已有一个同步任务正在运行')
      this.platformSyncActive = true
      let job: JobRecord | null = null
      let committed = false
      let lease: ZhihuApiTransportLease | null = null
      try {
        const account = this.requireSyncableAccount(accountId)
        const installation = this.options.plugins.requireEnabledSessionApi(ZHIHU_API_PLUGIN_ID)
        this.enforceInterval(account.id, 'sync', installation.manifest.minimumIntervalSeconds)
        const startedAt = this.now()
        job = await this.options.jobs.createManagedSync(account.id, ZHIHU_API_PLUGIN_ID)
        this.options.repository.markManagedSyncStarted(account.id, startedAt)

        lease = await this.options.browser.acquireZhihuApiTransport(account.id)
        const api = new ZhihuApi(lease.transport)
        const capturedAt = this.now()
        const limit = account.syncMode === 'recent_20' ? 20 : account.syncMode === 'recent_100' ? 100 : 0
        const snapshot = limit === 0
          ? await collectProfileOnly(api, account.remoteId!)
          : await api.collect(account.remoteId!, limit)
        const cachedAvatar = await this.cacheAvatar(account.id, snapshot.profile)
        const mode = account.syncMode as Exclude<SyncMode, 'disabled'>
        const payload = toPayload(snapshot, capturedAt, cachedAvatar, mode)
        job = await this.options.jobs.transition(job, 'committing', {
          progress: 85,
          stage: '保存同步数据'
        })
        const finishedAt = this.now()
        const committedResult = this.options.repository.commitManagedSync(payload, {
          accountId: account.id,
          pluginId: ZHIHU_API_PLUGIN_ID,
          jobId: job.id,
          authorizedMode: account.syncMode as Exclude<SyncMode, 'disabled'>,
          payloadMode: account.syncMode as Exclude<SyncMode, 'disabled'>,
          finishedAt
        })
        committed = true
        await this.pruneAvatarCache(account.id, cachedAvatar)
        job = this.options.jobs.publishPersisted(committedResult.job)
        return syncResult(account, snapshot, capturedAt, committedResult, job)
      } catch (error) {
        if (!committed) {
          const failedAt = this.now()
          try {
            if (isZhihuError(error, 'AUTH_REQUIRED')) {
              this.showLoginWorkspace(lease)
              this.options.repository.applyManagedProbeStatus(accountId, 'login_required', messageOf(error), failedAt)
            } else if (isZhihuError(error, 'IDENTITY_MISMATCH')) {
              this.options.repository.markManagedIdentityMismatch(accountId, messageOf(error), failedAt)
            } else if (isRateLimited(error)) {
              this.options.repository.applyManagedProbeStatus(accountId, 'challenge', messageOf(error), failedAt)
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
            this.options.plugins.recordSessionApiRun(ZHIHU_API_PLUGIN_ID, false, messageOf(error))
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
    if (account.platformId !== 'zhihu') throw new Error('该平台的数据同步功能尚未开放')
    this.options.plugins.requireEnabledSessionApi(ZHIHU_API_PLUGIN_ID)
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
    profile: ZhihuProfile
  ): Promise<SessionApiIdentityCheckResult> {
    const verifiedAt = this.now()
    const cachedAvatar = account.remoteId && account.remoteId !== profile.remoteId
      ? null
      : await this.cacheAvatar(account.id, profile)
    const updated = this.options.repository.applyManagedIdentity(account.id, {
      remoteId: profile.remoteId,
      remoteName: profile.remoteName,
      bio: profile.bio,
      ...(cachedAvatar
        ? { avatarCacheKey: cachedAvatar.cacheKey, avatarMime: cachedAvatar.mime }
        : {})
    }, verifiedAt)
    const mismatch = updated.connectionStatus === 'mismatch'
    if (!mismatch) await this.pruneAvatarCache(account.id, cachedAvatar)
    this.options.plugins.recordSessionApiRun(ZHIHU_API_PLUGIN_ID, true)
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
    lease: ZhihuApiTransportLease | null
  ): SessionApiIdentityCheckResult {
    const message = messageOf(error)
    this.options.plugins.recordSessionApiRun(ZHIHU_API_PLUGIN_ID, false, message)
    if (isZhihuError(error, 'AUTH_REQUIRED')) {
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
    if (isRateLimited(error)) {
      this.options.repository.applyManagedProbeStatus(accountId, 'challenge', message, this.now())
    }
    throw error
  }

  private showLoginWorkspace(lease: ZhihuApiTransportLease | null): void {
    if (!lease) return
    try {
      lease.showForLogin()
    } catch {}
  }

  private async cacheAvatar(
    accountId: string,
    profile: ZhihuProfile
  ): Promise<CachedProfileAvatar | null> {
    if (!profile.avatarUrl) return null
    try {
      return await this.options.browser.cacheZhihuAvatar(accountId, profile.avatarUrl)
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

  private cachePreview(accountId: string, profile: ZhihuProfile): IdentityPreview {
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
      remoteHandle: profile.remoteHandle,
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
    const key = `zhihu_api_last_started:${operation}:${accountId}`
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
  api: ZhihuApi,
  expectedRemoteId: string
): Promise<ZhihuApiSnapshot> {
  const before = await api.getIdentity()
  assertExpectedIdentity(before, expectedRemoteId)
  const profile = await api.getProfile(before)
  const after = await api.getIdentity()
  assertExpectedIdentity(after, expectedRemoteId)
  if (
    before.remoteId !== after.remoteId ||
    before.remoteHandle !== after.remoteHandle ||
    before.remoteName !== after.remoteName
  ) {
    throw new ZhihuApiError('IDENTITY_MISMATCH', '采集期间知乎登录身份发生变化')
  }
  return { identity: after, profile, contents: [] }
}

function toPayload(
  snapshot: ZhihuApiSnapshot,
  capturedAt: string,
  cachedAvatar: CachedProfileAvatar | null,
  mode: Exclude<SyncMode, 'disabled'>
): NormalizedImportPayload {
  return {
    capturedAt,
    profile: {
      remoteId: snapshot.profile.remoteId,
      remoteName: snapshot.profile.remoteName,
      bio: snapshot.profile.bio,
      ...(cachedAvatar
        ? { avatarCacheKey: cachedAvatar.cacheKey, avatarMime: cachedAvatar.mime }
        : {}),
      followers: snapshot.profile.followers,
      following: snapshot.profile.following,
      contentCount: snapshot.profile.contentCount,
      viewsTotal: null,
      likesAndFavoritesTotal: snapshot.profile.likesAndFavoritesTotal,
      views: null,
      likes: snapshot.profile.voteupCount,
      comments: null,
      shares: null,
      favorites: snapshot.profile.favoriteCount
    },
    contents: snapshot.contents.map((content) => ({
      remoteId: content.id,
      type: content.type,
      title: content.title,
      bodyExcerpt: content.bodyExcerpt,
      url: content.url,
      publishedAt: content.publishedAt,
      snapshots: [{
        capturedAt,
        views: content.readCount,
        likes: content.likeCount,
        comments: content.commentCount,
        shares: content.shareCount,
        favorites: content.favoriteCount
      }]
    })),
    warnings: contentCoverageWarnings(snapshot, mode)
  }
}

function syncResult(
  account: Account,
  snapshot: ZhihuApiSnapshot,
  capturedAt: string,
  committed: ManagedSyncCommitResult,
  job: JobRecord
): SessionApiSyncResult {
  return {
    accountId: account.id,
    mode: account.syncMode as Exclude<SyncMode, 'disabled'>,
    capturedAt,
    profile: {
      remoteId: snapshot.profile.remoteId,
      remoteName: snapshot.profile.remoteName,
      avatarAvailable: Boolean(snapshot.profile.avatarUrl),
      followers: snapshot.profile.followers,
      following: snapshot.profile.following,
      bio: snapshot.profile.bio,
      contentCount: snapshot.profile.contentCount,
      likes: snapshot.profile.voteupCount,
      favorites: snapshot.profile.favoriteCount,
      likesAndFavorites: snapshot.profile.likesAndFavoritesTotal,
      thanks: snapshot.profile.thankedCount
    },
    contentCount: snapshot.contents.length,
    stats: committed.stats,
    job,
    message: syncMessage(snapshot, account.syncMode as Exclude<SyncMode, 'disabled'>)
  }
}

function contentCoverageWarnings(
  snapshot: ZhihuApiSnapshot,
  mode: Exclude<SyncMode, 'disabled'>
): string[] {
  if (mode === 'profile_only' || snapshot.profile.contentCount === null) return []
  const limit = mode === 'recent_20' ? 20 : 100
  const expected = Math.min(snapshot.profile.contentCount, limit)
  if (snapshot.contents.length >= expected) return []
  return [
    `平台资料统计为 ${snapshot.profile.contentCount} 条，列表接口本次返回 ${snapshot.contents.length} 条可见内容。`
  ]
}

function syncMessage(
  snapshot: ZhihuApiSnapshot,
  mode: Exclude<SyncMode, 'disabled'>
): string {
  if (snapshot.contents.length === 0) return '已同步账号资料和账号指标。'
  const warning = contentCoverageWarnings(snapshot, mode)[0]
  return warning
    ? `已同步账号资料和 ${snapshot.contents.length} 条可见内容；${warning}`
    : `已同步账号资料和 ${snapshot.contents.length} 条内容。`
}

function assertExpectedIdentity(identity: ZhihuIdentity, expectedRemoteId: string): void {
  if (identity.remoteId !== expectedRemoteId) {
    throw new ZhihuApiError(
      'IDENTITY_MISMATCH',
      `当前知乎登录身份 ${identity.remoteId} 与本地绑定身份 ${expectedRemoteId} 不一致`
    )
  }
}

function isZhihuError(error: unknown, code: string): error is ZhihuApiError {
  return error instanceof ZhihuApiError && error.code === code
}

function isRateLimited(error: unknown): error is ZhihuApiError {
  return error instanceof ZhihuApiError && ['RATE_LIMITED', 'HTTP_429', 'CHALLENGE'].includes(error.code)
}

function errorCode(error: unknown): string {
  return error instanceof ZhihuApiError ? error.code : 'API_SYNC_FAILED'
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
