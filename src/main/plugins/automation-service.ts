import { randomUUID } from 'node:crypto'
import type { Account } from '../../shared/contracts'
import {
  AccountExecutionBusyError,
  type AccountExecutionCoordinator
} from '../services/account-execution-coordinator'
import { PlatformSyncBusyError } from '../platform-sync-service'
import type {
  PluginContributionState,
  PluginEventDelivery,
  PluginEventEnvelope,
  PluginGrant,
  PluginRunRecord,
  PluginSchedule
} from '../../shared/plugin-host-contracts'

export interface PluginExecutionRequest {
  pluginId: string
  contributionId: string
  trigger: 'manual' | 'event' | 'schedule'
  accountId: string | null
  event: PluginEventEnvelope | null
  deliveryId: string | null
}

export interface PluginExecutor {
  execute(request: PluginExecutionRequest): Promise<Record<string, unknown> | null>
}

interface AutomationRepository {
  listAccounts(): Account[]
  listPluginEvents(limit?: number): PluginEventEnvelope[]
  listUndeliveredPluginEvents?(pluginId: string, contributionId: string, limit?: number): PluginEventEnvelope[]
  ensurePluginEventDelivery(eventId: string, pluginId: string, contributionId: string): PluginEventDelivery
  listDuePluginDeliveries(now: string, limit?: number): PluginEventDelivery[]
  updatePluginDelivery(id: string, patch: Partial<Pick<PluginEventDelivery,
    'status' | 'attempt' | 'nextAttemptAt' | 'errorCode' | 'errorMessage'
  >>): PluginEventDelivery
  createPluginRun(run: PluginRunRecord): PluginRunRecord
  updateExtensionRun(id: string, patch: Partial<Pick<PluginRunRecord,
    'status' | 'attempt' | 'startedAt' | 'finishedAt' | 'nextAttemptAt' | 'errorCode' | 'errorMessage'
  >>): PluginRunRecord
  listPluginSchedules(): PluginSchedule[]
  updatePluginSchedule(id: string, patch: Partial<Pick<PluginSchedule,
    'enabled' | 'nextRunAt' | 'lastRunAt' | 'consecutiveFailures' | 'suspendedReason'
  >>): PluginSchedule
  getPluginGrant(pluginId: string, contributionId: string): PluginGrant | null
  recoverInterruptedPluginRuns?(finishedAt: string): void
}

interface ContributionSource {
  listContributions(): PluginContributionState[]
}

const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 6 * 60 * 60_000, 24 * 60 * 60_000]

export class PluginAutomationService {
  private timer: ReturnType<typeof setTimeout> | null = null
  private running = false
  private paused = false
  private started = false
  private activeRuns = 0
  private readonly activeAccounts = new Set<string>()
  private readonly listeners = new Set<() => void>()
  private accountCoordinator: AccountExecutionCoordinator | null = null

  constructor(
    private readonly repository: AutomationRepository,
    private readonly contributions: ContributionSource,
    private readonly executor: PluginExecutor,
    private readonly pollIntervalMs = 30_000,
    private readonly clock: () => Date = () => new Date()
  ) {}

  start(): void {
    if (this.started) return
    this.started = true
    this.repository.recoverInterruptedPluginRuns?.(this.now())
    this.schedule(1_000)
  }

  stop(): void {
    this.started = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  onChanged(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  setAccountCoordinator(coordinator: AccountExecutionCoordinator): void {
    this.accountCoordinator = coordinator
  }

  async tick(): Promise<void> {
    if (this.running || this.paused) return
    this.running = true
    try {
      this.materializeEventDeliveries()
      await this.processDeliveries()
      await this.processSchedules()
    } finally {
      this.running = false
    }
  }

  async runManual(
    pluginId: string,
    contributionId: string,
    accountId: string | null,
    attempt = 1
  ): Promise<PluginRunRecord> {
    const contribution = this.requireEnabledContribution(pluginId, contributionId)
    const grant = this.requireGrant(pluginId, contributionId)
    if (accountId && !this.accountAllowed(accountId, grant)) throw new Error('该插件未获准访问此账号')
    if (contribution.contribution.kind === 'platform.adapter' && !accountId) throw new Error('平台同步需要选择账号')
    return await this.executeRun(
      { pluginId, contributionId, trigger: 'manual', accountId, event: null, deliveryId: null },
      Math.max(1, Math.trunc(attempt))
    )
  }

  isPaused(): boolean {
    return this.paused
  }

  setPaused(paused: boolean): boolean {
    this.paused = paused
    if (!paused && this.started && !this.running) this.schedule(0)
    this.emitChanged()
    return this.paused
  }

  hasRunningTasks(): boolean {
    return this.running || this.activeRuns > 0
  }

  private materializeEventDeliveries(): void {
    const handlers = this.contributions.listContributions().filter((item): item is PluginContributionState & {
      contribution: Extract<PluginContributionState['contribution'], { kind: 'event.handler' }>
    } => item.enabled && item.granted && item.contribution.kind === 'event.handler')
    for (const handler of handlers) {
      const grant = this.repository.getPluginGrant(handler.pluginId, handler.contribution.id)
      if (!grant) continue
      const events = this.repository.listUndeliveredPluginEvents?.(
        handler.pluginId,
        handler.contribution.id,
        500
      ) ?? this.repository.listPluginEvents()
      for (const event of events) {
        if (!handler.contribution.events.includes(event.type)) continue
        if (Date.parse(event.occurredAt) < Date.parse(grant.grantedAt)) continue
        if (event.subject.accountId && !this.accountAllowed(event.subject.accountId, grant)) continue
        this.repository.ensurePluginEventDelivery(event.id, handler.pluginId, handler.contribution.id)
      }
    }
  }

  private async processDeliveries(): Promise<void> {
    const due = this.repository.listDuePluginDeliveries(this.now(), 50)
    for (const delivery of due) {
      const contribution = this.contributions.listContributions().find((item) => (
        item.pluginId === delivery.pluginId && item.contribution.id === delivery.contributionId
      ))
      if (!contribution?.enabled || contribution.suspendedReason) {
        this.repository.updatePluginDelivery(delivery.id, {
          status: 'cancelled',
          errorCode: 'CONTRIBUTION_DISABLED',
          errorMessage: '插件贡献点已停用'
        })
        continue
      }
      const grant = this.repository.getPluginGrant(delivery.pluginId, delivery.contributionId)
      if (!grant) {
        this.repository.updatePluginDelivery(delivery.id, {
          status: 'cancelled',
          errorCode: 'GRANT_REVOKED',
          errorMessage: '插件授权已撤销'
        })
        continue
      }
      const event = filterEvent(delivery.event, grant)
      this.repository.updatePluginDelivery(delivery.id, {
        status: 'running',
        attempt: delivery.attempt + 1,
        nextAttemptAt: null,
        errorCode: '',
        errorMessage: ''
      })
      try {
        await this.executeRun({
          pluginId: delivery.pluginId,
          contributionId: delivery.contributionId,
          trigger: 'event',
          accountId: event.subject.accountId,
          event,
          deliveryId: delivery.id
        }, delivery.attempt + 1)
        this.repository.updatePluginDelivery(delivery.id, {
          status: 'succeeded',
          attempt: delivery.attempt + 1,
          nextAttemptAt: null,
          errorCode: '',
          errorMessage: ''
        })
      } catch (error) {
        const attempt = delivery.attempt + 1
        const retry = isRetryable(error) && attempt <= RETRY_DELAYS_MS.length
        const retryDelay = retry
          ? Math.max(RETRY_DELAYS_MS[attempt - 1]!, error instanceof RetryablePluginError ? error.retryAfterMs ?? 0 : 0)
          : 0
        this.repository.updatePluginDelivery(delivery.id, {
          status: retry ? 'retry' : 'failed',
          attempt,
          nextAttemptAt: retry ? new Date(this.clock().getTime() + retryDelay).toISOString() : null,
          errorCode: safeErrorCode(error),
          errorMessage: safeErrorMessage(error)
        })
      }
    }
  }

  private async processSchedules(): Promise<void> {
    const now = this.clock()
    const due = this.repository.listPluginSchedules().filter((schedule) => (
      schedule.enabled && !schedule.suspendedReason && schedule.nextRunAt !== null &&
      Date.parse(schedule.nextRunAt) <= now.getTime()
    ))
    for (const schedule of due) {
      const contribution = this.contributions.listContributions().find((item) => (
        item.pluginId === schedule.pluginId && item.contribution.id === schedule.contributionId
      ))
      if (!contribution?.enabled || contribution.suspendedReason) {
        this.repository.updatePluginSchedule(schedule.id, {
          enabled: false,
          suspendedReason: '插件贡献点已停用',
          nextRunAt: null
        })
        continue
      }
      const grant = this.repository.getPluginGrant(schedule.pluginId, schedule.contributionId)
      if (!grant) {
        this.repository.updatePluginSchedule(schedule.id, {
          enabled: false,
          suspendedReason: '插件授权已撤销',
          nextRunAt: null
        })
        continue
      }
      const accountIds = this.resolveScheduleAccounts(schedule).filter((id) => this.accountAllowed(id, grant))
      const paused = this.repository.listAccounts().find((account) => accountIds.includes(account.id) && (
        account.connectionStatus === 'expired' || account.connectionStatus === 'mismatch' ||
        account.status === 'cooldown'
      ))
      if (paused) {
        this.repository.updatePluginSchedule(schedule.id, {
          enabled: false,
          nextRunAt: null,
          suspendedReason: '账号登录失效、身份变化或暂时受限，计划已暂停'
        })
        continue
      }
      const targets = accountIds.length > 0 ? accountIds : [null]
      let error: unknown = null
      for (const accountId of targets) {
        try {
          await this.executeRun({
            pluginId: schedule.pluginId,
            contributionId: schedule.contributionId,
            trigger: 'schedule',
            accountId,
            event: null,
            deliveryId: null
          })
        } catch (cause) {
          error = cause
          break
        }
      }
      const failures = error ? schedule.consecutiveFailures + 1 : 0
      const suspended = failures >= 3 ? '连续失败三次，自动计划已暂停' : ''
      this.repository.updatePluginSchedule(schedule.id, {
        enabled: suspended ? false : schedule.enabled,
        lastRunAt: this.now(),
        nextRunAt: suspended ? null : new Date(now.getTime() + schedule.intervalMinutes * 60_000).toISOString(),
        consecutiveFailures: failures,
        suspendedReason: suspended
      })
    }
  }

  private async executeRun(request: PluginExecutionRequest, attempt = 1): Promise<PluginRunRecord> {
    this.activeRuns += 1
    try {
      return await this.executeRunActive(request, attempt)
    } finally {
      this.activeRuns -= 1
    }
  }

  private async executeRunActive(request: PluginExecutionRequest, attempt: number): Promise<PluginRunRecord> {
    const now = this.now()
    let run = this.repository.createPluginRun({
      id: randomUUID(),
      pluginId: request.pluginId,
      contributionId: request.contributionId,
      trigger: request.trigger,
      status: 'running',
      accountId: request.accountId,
      eventId: request.event?.id ?? null,
      attempt,
      startedAt: now,
      finishedAt: null,
      nextAttemptAt: null,
      errorCode: '',
      errorMessage: '',
      createdAt: now
    })
    this.emitChanged()
    if (request.accountId && this.activeAccounts.has(request.accountId)) {
      this.repository.updateExtensionRun(run.id, {
        status: 'failed',
        finishedAt: this.now(),
        errorCode: 'ACCOUNT_BUSY',
        errorMessage: '该账号已有插件任务正在运行'
      })
      this.emitChanged()
      throw new RetryablePluginError('ACCOUNT_BUSY', '该账号已有插件任务正在运行')
    }
    if (request.accountId) this.activeAccounts.add(request.accountId)
    try {
      const execute = () => this.executor.execute(request)
      if (request.accountId && this.accountCoordinator) {
        await this.accountCoordinator.run(request.accountId, execute)
      } else {
        await execute()
      }
      run = this.repository.updateExtensionRun(run.id, {
        status: 'succeeded',
        finishedAt: this.now(),
        errorCode: '',
        errorMessage: ''
      })
      this.emitChanged()
      return run
    } catch (error) {
      const failure = error instanceof AccountExecutionBusyError || error instanceof PlatformSyncBusyError
        ? new RetryablePluginError(
            error instanceof PlatformSyncBusyError ? error.code : 'ACCOUNT_BUSY',
            error.message
          )
        : error
      this.repository.updateExtensionRun(run.id, {
        status: 'failed',
        finishedAt: this.now(),
        errorCode: safeErrorCode(failure),
        errorMessage: safeErrorMessage(failure)
      })
      this.emitChanged()
      throw failure
    } finally {
      if (request.accountId) this.activeAccounts.delete(request.accountId)
    }
  }

  private resolveScheduleAccounts(schedule: PluginSchedule): string[] {
    const selected = new Set(schedule.accountIds)
    if (schedule.groupIds.length > 0) {
      for (const account of this.repository.listAccounts()) {
        if (account.groupIds.some((groupId) => schedule.groupIds.includes(groupId))) selected.add(account.id)
      }
    }
    return [...selected]
  }

  private accountAllowed(accountId: string, grant: PluginGrant): boolean {
    if (grant.accountIds.includes(accountId)) return true
    const account = this.repository.listAccounts().find((item) => item.id === accountId)
    return Boolean(account && account.groupIds.some((groupId) => grant.groupIds.includes(groupId)))
  }

  private requireEnabledContribution(pluginId: string, contributionId: string): PluginContributionState {
    const contribution = this.contributions.listContributions().find((item) => (
      item.pluginId === pluginId && item.contribution.id === contributionId
    ))
    if (!contribution?.enabled || contribution.suspendedReason) throw new Error('插件贡献点未启用')
    return contribution
  }

  private requireGrant(pluginId: string, contributionId: string): PluginGrant {
    const grant = this.repository.getPluginGrant(pluginId, contributionId)
    if (!grant) throw new Error('插件贡献点尚未授权')
    return grant
  }

  private now(): string {
    return this.clock().toISOString()
  }

  private schedule(delay: number): void {
    if (!this.started || this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.tick().finally(() => {
        if (this.started) this.schedule(this.pollIntervalMs)
      })
    }, delay)
    this.timer.unref?.()
  }

  private emitChanged(): void {
    for (const listener of this.listeners) {
      try { listener() } catch {}
    }
  }
}

export class RetryablePluginError extends Error {
  constructor(readonly code: string, message: string, readonly retryAfterMs: number | null = null) {
    super(message)
    this.name = 'RetryablePluginError'
  }
}

function isRetryable(error: unknown): boolean {
  return error instanceof RetryablePluginError
}

function safeErrorCode(error: unknown): string {
  return error instanceof RetryablePluginError ? error.code.slice(0, 80) : 'PLUGIN_EXECUTION_FAILED'
}

function safeErrorMessage(error: unknown): string {
  const value = error instanceof Error ? error.message : '插件执行失败'
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500) || '插件执行失败'
}

function filterEvent(event: PluginEventEnvelope, grant: PluginGrant): PluginEventEnvelope {
  const source = event.data && typeof event.data === 'object' && !Array.isArray(event.data)
    ? structuredClone(event.data as Record<string, unknown>)
    : {}
  if (!grant.dataScopes.includes('profile')) delete source.profile
  if (!grant.dataScopes.includes('content')) {
    delete source.contents
    delete source.note
    delete source.tags
  }
  if (!grant.dataScopes.includes('metrics')) {
    delete source.stats
    stripMetrics(source.profile)
    if (Array.isArray(source.contents)) {
      for (const content of source.contents) stripMetrics(content)
    }
  }
  if (!grant.dataScopes.includes('account')) {
    delete source.alias
    delete source.groupIds
  }
  return { ...structuredClone(event), data: source }
}

function stripMetrics(value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  const record = value as Record<string, unknown>
  for (const key of [
    'followers', 'following', 'contentCount', 'viewsTotal', 'likesAndFavoritesTotal',
    'views', 'likes', 'comments', 'shares', 'favorites', 'snapshots'
  ]) delete record[key]
}
