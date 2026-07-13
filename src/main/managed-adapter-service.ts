import { randomUUID } from 'node:crypto'
import type {
  Account,
  ConfirmManagedIdentityInput,
  ManagedIdentityCheckResult
} from '../shared/contracts'
import {
  xiaohongshuManagedBrowserAdapter,
  type AdapterExecutionStatus,
  type AdapterIdentity,
  type AdapterOperation,
  type AdapterWhoamiResult,
  type ManagedBrowserAdapter
} from './adapters'
import type { PluginService } from './plugin-service'

const CONFIRMATION_TTL_MS = 5 * 60_000
const MAX_CONFIRMATION_PREVIEWS = 50

interface IdentityPreview {
  token: string
  accountId: string
  identity: AdapterIdentity
  pageUrl: string
  evidence: string[]
  expiresAtMs: number
}

interface ManagedBrowserRunner {
  runAdapterOperation(
    accountId: string,
    adapter: ManagedBrowserAdapter,
    operation: AdapterOperation
  ): Promise<unknown>
}

interface ManagedIdentityRepository {
  getAccount(id: string): Account | null
  getSetting(key: string): string | null
  setSetting(key: string, value: string): void
  applyManagedIdentity(
    accountId: string,
    identity: { remoteId: string; remoteName: string },
    verifiedAt: string
  ): Account
  applyManagedProbeStatus(
    accountId: string,
    status: 'login_required' | 'challenge' | 'page_not_ready' | 'unsupported',
    message: string,
    observedAt: string
  ): Account
}

export interface ManagedAdapterServiceOptions {
  repository: ManagedIdentityRepository
  browser: ManagedBrowserRunner
  plugins: PluginService
  clock?: () => Date
  createToken?: () => string
}

export class ManagedAdapterService {
  private readonly clock: () => Date
  private readonly createToken: () => string
  private readonly previews = new Map<string, IdentityPreview>()
  private readonly runningAccounts = new Set<string>()

  constructor(private readonly options: ManagedAdapterServiceOptions) {
    this.clock = options.clock ?? (() => new Date())
    this.createToken = options.createToken ?? randomUUID
  }

  async verifyIdentity(accountId: string): Promise<ManagedIdentityCheckResult> {
    return this.withAccountLock(accountId, async () => {
      const { account, adapter, minimumIntervalSeconds } = this.requireReadyAdapter(accountId)
      this.startRateLimitedRun(account, minimumIntervalSeconds)
      try {
        const rawProbe = await this.options.browser.runAdapterOperation(accountId, adapter, 'probe')
        const probe = adapter.parseProbeResult(rawProbe)
        if (probe.status !== 'ready') return this.finishNonReady(accountId, adapter, probe)

        const whoami = await this.runWhoami(accountId, adapter)
        if (whoami.status !== 'ready' || !whoami.identity) {
          return this.finishNonReady(accountId, adapter, whoami)
        }

        if (!account.remoteId) {
          const preview = this.cachePreview(accountId, whoami)
          this.options.repository.applyManagedProbeStatus(
            accountId,
            'page_not_ready',
            '等待用户确认首次平台身份绑定',
            this.now()
          )
          this.options.plugins.recordManagedRun(adapter.metadata.id, true)
          return {
            ...identityResultBase(accountId, adapter, whoami),
            status: 'confirmation_required',
            verifiedAt: null,
            confirmationToken: preview.token,
            confirmationExpiresAt: new Date(preview.expiresAtMs).toISOString(),
            message: '请核对远端 ID 与昵称，确认这是本人账号后再完成首次绑定。'
          }
        }

        return this.commitIdentity(account, adapter, whoami)
      } catch (error) {
        this.recordFailure(adapter.metadata.id, error)
        throw error
      }
    })
  }

  async confirmIdentity(input: ConfirmManagedIdentityInput): Promise<ManagedIdentityCheckResult> {
    if (!input.confirmIdentity) throw new Error('必须明确确认这是本人账号')
    return this.withAccountLock(input.accountId, async () => {
      this.purgeExpiredPreviews()
      const preview = this.previews.get(input.token)
      if (!preview || preview.accountId !== input.accountId) throw new Error('身份确认已过期，请重新核验')
      this.previews.delete(input.token)

      const { account, adapter } = this.requireReadyAdapter(input.accountId)
      this.assertNotCoolingDown(account)
      try {
        const whoami = await this.runWhoami(input.accountId, adapter)
        if (whoami.status !== 'ready' || !whoami.identity) {
          return this.finishNonReady(input.accountId, adapter, whoami)
        }
        if (
          whoami.identity.remoteId !== preview.identity.remoteId ||
          whoami.identity.remoteName !== preview.identity.remoteName
        ) throw new Error('页面身份在确认前发生变化，未写入任何绑定')
        if (account.remoteId && account.remoteId !== preview.identity.remoteId) {
          throw new Error('本地账号已绑定其他身份，未写入任何变更')
        }
        return this.commitIdentity(account, adapter, whoami)
      } catch (error) {
        this.recordFailure(adapter.metadata.id, error)
        throw error
      }
    })
  }

  invalidatePreviews(): void {
    if (this.runningAccounts.size > 0) throw new Error('仍有身份核验正在执行')
    this.previews.clear()
  }

  private requireReadyAdapter(accountId: string): {
    account: Account
    adapter: ManagedBrowserAdapter
    minimumIntervalSeconds: number
  } {
    const adapter = xiaohongshuManagedBrowserAdapter
    const account = this.options.repository.getAccount(accountId)
    if (!account) throw new Error('账号不存在')
    if (account.platformId !== adapter.metadata.platformId) throw new Error('该平台身份核验适配器尚未开放')
    const installation = this.options.plugins.requireEnabledManagedBrowser(adapter.metadata.id)
    this.assertNotCoolingDown(account)
    return {
      account,
      adapter,
      minimumIntervalSeconds: installation.manifest.minimumIntervalSeconds
    }
  }

  private startRateLimitedRun(account: Account, minimumIntervalSeconds: number): void {
    const now = this.nowDate()
    const key = `adapter_last_started:${account.id}`
    const previous = this.options.repository.getSetting(key)
    if (previous) {
      const elapsedMs = now.getTime() - new Date(previous).getTime()
      const minimumMs = minimumIntervalSeconds * 1_000
      if (Number.isFinite(elapsedMs) && elapsedMs >= 0 && elapsedMs < minimumMs) {
        const remaining = Math.ceil((minimumMs - elapsedMs) / 1_000)
        throw new Error(`身份核验频率受限，请在 ${remaining} 秒后重试`)
      }
    }
    this.options.repository.setSetting(key, now.toISOString())
  }

  private assertNotCoolingDown(account: Account): void {
    if (!account.cooldownUntil) return
    const until = new Date(account.cooldownUntil).getTime()
    if (Number.isFinite(until) && until > this.nowDate().getTime()) {
      throw new Error(`平台安全验证冷却中，请在 ${account.cooldownUntil} 后重试`)
    }
  }

  private async runWhoami(
    accountId: string,
    adapter: ManagedBrowserAdapter
  ): Promise<AdapterWhoamiResult> {
    const raw = await this.options.browser.runAdapterOperation(accountId, adapter, 'whoami')
    return adapter.parseWhoamiResult(raw)
  }

  private finishNonReady(
    accountId: string,
    adapter: ManagedBrowserAdapter,
    result: { status: AdapterExecutionStatus; pageUrl: string; evidence: readonly string[] }
  ): ManagedIdentityCheckResult {
    const status = nonReadyStatus(result.status)
    this.options.repository.applyManagedProbeStatus(accountId, status, statusMessage(status), this.now())
    this.options.plugins.recordManagedRun(adapter.metadata.id, true)
    return resultForStatus(accountId, adapter, status, result.pageUrl, result.evidence)
  }

  private commitIdentity(
    account: Account,
    adapter: ManagedBrowserAdapter,
    whoami: AdapterWhoamiResult
  ): ManagedIdentityCheckResult {
    if (!whoami.identity) throw new Error('身份核验结果缺少身份信息')
    const verifiedAt = this.now()
    const updated = this.options.repository.applyManagedIdentity(account.id, whoami.identity, verifiedAt)
    const mismatch = updated.connectionStatus === 'mismatch'
    this.options.plugins.recordManagedRun(adapter.metadata.id, true)
    return {
      ...identityResultBase(account.id, adapter, whoami),
      status: mismatch ? 'identity_mismatch' : 'verified',
      verifiedAt: mismatch ? null : verifiedAt,
      confirmationToken: null,
      confirmationExpiresAt: null,
      message: mismatch
        ? '当前登录身份与本地账号绑定不一致，已停止同步。'
        : '登录身份已通过固定只读脚本核验。'
    }
  }

  private cachePreview(accountId: string, whoami: AdapterWhoamiResult): IdentityPreview {
    if (!whoami.identity) throw new Error('身份核验结果缺少身份信息')
    this.purgeExpiredPreviews()
    while (this.previews.size >= MAX_CONFIRMATION_PREVIEWS) {
      const oldest = this.previews.keys().next().value as string | undefined
      if (!oldest) break
      this.previews.delete(oldest)
    }
    const preview: IdentityPreview = {
      token: this.createToken(),
      accountId,
      identity: { ...whoami.identity },
      pageUrl: whoami.pageUrl,
      evidence: [...whoami.evidence],
      expiresAtMs: this.nowDate().getTime() + CONFIRMATION_TTL_MS
    }
    this.previews.set(preview.token, preview)
    return preview
  }

  private purgeExpiredPreviews(): void {
    const now = this.nowDate().getTime()
    for (const [token, preview] of this.previews) {
      if (preview.expiresAtMs <= now) this.previews.delete(token)
    }
  }

  private recordFailure(adapterId: string, error: unknown): void {
    try {
      this.options.plugins.recordManagedRun(adapterId, false, messageOf(error))
    } catch {
      // Preserve the original adapter error if audit-counter persistence also fails.
    }
  }

  private async withAccountLock<T>(accountId: string, action: () => Promise<T>): Promise<T> {
    if (this.runningAccounts.has(accountId)) throw new Error('该账号正在核验身份')
    this.runningAccounts.add(accountId)
    try {
      return await action()
    } finally {
      this.runningAccounts.delete(accountId)
    }
  }

  private now(): string {
    return this.nowDate().toISOString()
  }

  private nowDate(): Date {
    const value = this.clock()
    if (!Number.isFinite(value.getTime())) throw new Error('身份核验时钟无效')
    return value
  }
}

type NonReadyStatus = 'login_required' | 'challenge' | 'page_not_ready' | 'unsupported'

function nonReadyStatus(status: AdapterExecutionStatus): NonReadyStatus {
  if (status === 'ready') throw new Error('身份核验结果缺少身份信息')
  return status
}

function identityResultBase(
  accountId: string,
  adapter: ManagedBrowserAdapter,
  whoami: AdapterWhoamiResult
): Omit<ManagedIdentityCheckResult, 'status' | 'verifiedAt' | 'message' | 'confirmationToken' | 'confirmationExpiresAt'> {
  if (!whoami.identity) throw new Error('身份核验结果缺少身份信息')
  return {
    accountId,
    adapterId: adapter.metadata.id,
    adapterVersion: adapter.metadata.version,
    pageUrl: whoami.pageUrl,
    remoteId: whoami.identity.remoteId,
    remoteName: whoami.identity.remoteName,
    profileUrl: whoami.identity.profileUrl,
    evidence: [...whoami.evidence]
  }
}

function resultForStatus(
  accountId: string,
  adapter: ManagedBrowserAdapter,
  status: NonReadyStatus,
  pageUrl: string,
  evidence: readonly string[]
): ManagedIdentityCheckResult {
  return {
    accountId,
    adapterId: adapter.metadata.id,
    adapterVersion: adapter.metadata.version,
    status,
    pageUrl,
    remoteId: null,
    remoteName: '',
    profileUrl: null,
    evidence: [...evidence],
    verifiedAt: null,
    confirmationToken: null,
    confirmationExpiresAt: null,
    message: statusMessage(status)
  }
}

function statusMessage(status: NonReadyStatus): string {
  if (status === 'login_required') return '尚未登录或登录已失效，请在官方页面完成登录。'
  if (status === 'challenge') return '平台要求安全验证，已停止核验并进入 30 分钟冷却。'
  if (status === 'unsupported') return '当前页面不在该适配器的审核范围内。'
  return '页面尚未展示可验证的本人账号标识，请进入创作中心账号页面后重试。'
}

function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : '身份核验失败'
}
