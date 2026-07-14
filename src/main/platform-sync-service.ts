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
  getAccount(id: string): Pick<Account, 'id' | 'platformId'> | null
}

export type PlatformSyncAdapters = Partial<Record<PlatformId, SessionApiPlatformService>>

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

  constructor(private readonly options: PlatformSyncServiceOptions) {
    this.adapters = { ...options.adapters }
  }

  async verifyIdentity(accountId: string): Promise<SessionApiIdentityCheckResult> {
    return await this.adapterForAccount(accountId).verifyIdentity(accountId)
  }

  async confirmIdentity(input: ConfirmSessionApiIdentityInput): Promise<SessionApiIdentityCheckResult> {
    return await this.adapterForAccount(input.accountId).confirmIdentity(input)
  }

  async sync(accountId: string): Promise<SessionApiSyncResult> {
    return await this.adapterForAccount(accountId).sync(accountId)
  }

  isAccountActive(accountId: string): boolean {
    const account = this.options.repository.getAccount(accountId)
    if (!account) return false
    return this.adapters[account.platformId]?.isAccountActive(accountId) ?? false
  }

  invalidatePreviews(): void {
    for (const adapter of new Set(Object.values(this.adapters))) {
      adapter?.invalidatePreviews()
    }
  }

  private adapterForAccount(accountId: string): SessionApiPlatformService {
    const account = this.options.repository.getAccount(accountId)
    if (!account) throw new Error('账号不存在')
    const adapter = this.adapters[account.platformId]
    if (!adapter) throw new Error('该平台的数据同步功能尚未开放')
    return adapter
  }
}
