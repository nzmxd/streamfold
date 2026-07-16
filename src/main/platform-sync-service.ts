import type { Account, PlatformId } from '../shared/contracts'
import type {
  ConfirmSessionApiIdentityInput,
  SessionApiIdentityCheckResult,
  SessionApiSyncResult,
  SessionApiSyncTrigger
} from '../shared/session-api-contracts'
import type { AccountExecutionCoordinator } from './services/account-execution-coordinator'

/** Minimal adapter surface implemented by each managed platform integration. */
export interface SessionApiPlatformService {
  readonly pluginId: string
  readonly contributionId: string
  verifyIdentity(accountId: string): Promise<SessionApiIdentityCheckResult>
  confirmIdentity(input: ConfirmSessionApiIdentityInput): Promise<SessionApiIdentityCheckResult>
  sync(accountId: string, trigger?: SessionApiSyncTrigger): Promise<SessionApiSyncResult>
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
  coordinator?: AccountExecutionCoordinator
}

export interface SyncAdapterDescriptor {
  accountId: string
  platformId: PlatformId
  pluginId: string
  contributionId: string
}

export class PlatformSyncBusyError extends Error {
  constructor(readonly code: 'ACCOUNT_BUSY' | 'ADAPTER_BUSY', message: string) {
    super(message)
    this.name = 'PlatformSyncBusyError'
  }
}

/**
 * Thin platform router for identity and sync operations.
 *
 * Platform adapters retain their own locking, rate limits and persistence
 * rules. This service only resolves the account platform and delegates to the
 * matching adapter, keeping IPC independent from any one platform.
 */
export class PlatformSyncService {
  private readonly adapters: PlatformSyncAdapters
  private readonly activeAdapters = new Set<string>()
  private readonly activeAccounts = new Set<string>()

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
    const action = () => this.adapterForAccount(accountId).verifyIdentity(accountId)
    return this.options.coordinator
      ? await this.options.coordinator.run(accountId, action)
      : await action()
  }

  async confirmIdentity(input: ConfirmSessionApiIdentityInput): Promise<SessionApiIdentityCheckResult> {
    const action = () => this.adapterForAccount(input.accountId).confirmIdentity(input)
    return this.options.coordinator
      ? await this.options.coordinator.run(input.accountId, action)
      : await action()
  }

  async sync(accountId: string, trigger: SessionApiSyncTrigger = 'manual'): Promise<SessionApiSyncResult> {
    const action = () => this.syncWithAdapterLock(accountId, trigger)
    return this.options.coordinator
      ? await this.options.coordinator.run(accountId, action)
      : await action()
  }

  private async syncWithAdapterLock(
    accountId: string,
    trigger: SessionApiSyncTrigger
  ): Promise<SessionApiSyncResult> {
    const descriptor = this.descriptorForAccount(accountId)
    if (this.activeAccounts.has(accountId)) {
      throw new PlatformSyncBusyError('ACCOUNT_BUSY', '该账号已有同步任务正在运行')
    }
    if (this.activeAdapters.has(descriptor.contributionId)) {
      throw new PlatformSyncBusyError('ADAPTER_BUSY', '该平台适配器已有同步任务正在运行')
    }
    this.activeAccounts.add(accountId)
    this.activeAdapters.add(descriptor.contributionId)
    try {
      return await this.adapterForAccount(accountId).sync(accountId, trigger)
    } finally {
      this.activeAccounts.delete(accountId)
      this.activeAdapters.delete(descriptor.contributionId)
    }
  }

  descriptorForAccount(accountId: string): SyncAdapterDescriptor {
    const account = this.options.repository.getAccount(accountId)
    if (!account) throw new Error('账号不存在')
    const adapter = this.resolveAdapter(account)
    if (!adapter) throw new Error('该平台的数据同步功能尚未开放')
    return {
      accountId,
      platformId: account.platformId,
      pluginId: adapter.pluginId,
      contributionId: adapter.contributionId
    }
  }

  isAccountActive(accountId: string): boolean {
    const account = this.options.repository.getAccount(accountId)
    if (!account) return false
    return this.activeAccounts.has(accountId) ||
      (this.options.coordinator?.isActive(accountId) ?? false) ||
      (this.resolveAdapter(account)?.isAccountActive(accountId) ?? false)
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
