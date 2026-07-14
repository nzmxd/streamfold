import { AsyncLocalStorage } from 'node:async_hooks'

export class AccountExecutionBusyError extends Error {
  constructor(readonly accountId: string) {
    super('该账号已有任务正在运行')
    this.name = 'AccountExecutionBusyError'
  }
}

/** Re-entrant process-local lock shared by sync and plugin tasks that use an account session. */
export class AccountExecutionCoordinator {
  private readonly activeAccounts = new Set<string>()
  private readonly context = new AsyncLocalStorage<ReadonlySet<string>>()

  isActive(accountId: string): boolean {
    return this.activeAccounts.has(accountId)
  }

  async run<T>(accountId: string, action: () => Promise<T>): Promise<T> {
    const current = this.context.getStore()
    if (current?.has(accountId)) return await action()
    if (this.activeAccounts.has(accountId)) throw new AccountExecutionBusyError(accountId)
    this.activeAccounts.add(accountId)
    const next = new Set(current ?? [])
    next.add(accountId)
    try {
      return await this.context.run(next, action)
    } finally {
      this.activeAccounts.delete(accountId)
    }
  }
}
