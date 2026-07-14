import type { Account, PlatformId } from '../shared/contracts'
import type {
  ConfirmSessionApiIdentityInput,
  SessionApiIdentityCheckResult,
  SessionApiSyncResult
} from '../shared/session-api-contracts'

/** Minimal adapter surface implemented by each managed platform integration. */
export interface SessionApiPlatformService {
  verifyIdentity(accountId: string): Promise<SessionApiIdentityCheckResult>
  confirmIdentity(input: ConfirmSessionApiIdentityInput): Promise<SessionApiIdentityCheckResult>
  sync(accountId: string): Promise<SessionApiSyncResult>
  isAccountActive(accountId: string): boolean
  invalidatePreviews(): void
}

export interface PlatformSyncAccountRepository {
  getAccount(id: string): Pick<Account, 'id' | 'platformId'> & Partial<Pick<Account, 'adapterContributionId'>> | null
}

export type PlatformSyncAdapters = Record<string, SessionApiPlatformService | undefined>

export interface PlatformSyncServiceOptions {
  repository: PlatformSyncAccountRepository
  adapters: PlatformSyncAdapters
}

/**
 * Thin platform router for identity and sync operations.
 *
 * Platform adapters retain their own locking, rate limits and persistence
 * rules. This service only resolves the account platform and delegates to the
 * matching adapter, keeping IPC independent from any one platform.
 */
export class PlatformSyncService implements SessionApiPlatformService {
  private readonly adapters: PlatformSyncAdapters
  private readonly activePlatforms = new Set<PlatformId>()

  constructor(private readonly options: PlatformSyncServiceOptions) {
    this.adapters = { ...options.adapters }
  }

  registerAdapter(contributionId: string, adapter: SessionApiPlatformService): () => void {
    if (!/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/.test(contributionId)) throw new Error('适配器贡献点 ID 非法')
    if (this.adapters[contributionId]) throw new Error('适配器贡献点已注册')
    this.adapters[contributionId] = adapter
    return () => {
      if (this.adapters[contributionId] === adapter) delete this.adapters[contributionId]
    }
  }

  async verifyIdentity(accountId: string): Promise<SessionApiIdentityCheckResult> {
    return await this.adapterForAccount(accountId).verifyIdentity(accountId)
  }

  async confirmIdentity(input: ConfirmSessionApiIdentityInput): Promise<SessionApiIdentityCheckResult> {
    return await this.adapterForAccount(input.accountId).confirmIdentity(input)
  }

  async sync(accountId: string): Promise<SessionApiSyncResult> {
    const account = this.options.repository.getAccount(accountId)
    if (!account) throw new Error('账号不存在')
    if (this.activePlatforms.has(account.platformId)) throw new Error('该平台已有同步任务正在运行')
    this.activePlatforms.add(account.platformId)
    try {
      return await this.adapterForAccount(accountId).sync(accountId)
    } finally {
      this.activePlatforms.delete(account.platformId)
    }
  }

  isAccountActive(accountId: string): boolean {
    const account = this.options.repository.getAccount(accountId)
    if (!account) return false
    return this.resolveAdapter(account)?.isAccountActive(accountId) ?? false
  }

  invalidatePreviews(): void {
    for (const adapter of new Set(Object.values(this.adapters))) {
      adapter?.invalidatePreviews()
    }
  }

  private adapterForAccount(accountId: string): SessionApiPlatformService {
    const account = this.options.repository.getAccount(accountId)
    if (!account) throw new Error('账号不存在')
    const adapter = this.resolveAdapter(account)
    if (!adapter) throw new Error('该平台的数据同步功能尚未开放')
    return adapter
  }

  private resolveAdapter(account: Pick<Account, 'platformId'> & Partial<Pick<Account, 'adapterContributionId'>>): SessionApiPlatformService | undefined {
    return (account.adapterContributionId ? this.adapters[account.adapterContributionId] : undefined) ??
      this.adapters[account.platformId]
  }
}
