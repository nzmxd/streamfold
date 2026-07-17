import { randomUUID } from 'node:crypto'
import type { Account, Group } from '../../shared/contracts'
import type {
  EnqueueSyncBatchInput,
  EnqueueSyncBatchResult,
  JobRecord,
  RequestedSyncMode,
  SyncBatchPreview,
  SyncBatchPreviewAccount,
  SyncBatchScope
} from '../../shared/job-contracts'
import type {
  CreateJobBatchInput,
  CreateJobInput,
  CreateSyncBatchResult
} from '../database'
import {
  PlatformSyncBusyError,
  type PlatformSyncService,
  type SyncAdapterDescriptor
} from '../platform-sync-service'
import { SafeJobError } from '../plugins/errors'
import { AccountExecutionBusyError } from './account-execution-coordinator'
import { markErrorReported } from '../error-reporting'
import type { JobService } from './job-service'

type MaybePromise<T> = T | Promise<T>

export interface SyncBatchRepository {
  listAccounts(): MaybePromise<Account[]>
  listGroups(): MaybePromise<Group[]>
  getAccount(id: string): MaybePromise<Account | null>
  listJobs(): MaybePromise<JobRecord[]>
  getJob(id: string): MaybePromise<JobRecord | null>
  createSyncBatch(
    batch: CreateJobBatchInput,
    jobs: readonly CreateJobInput[]
  ): MaybePromise<CreateSyncBatchResult>
  clearManagedSyncQueueState(accountId: string, clearedAt?: string): MaybePromise<Account>
}

export interface SyncBatchServiceOptions {
  clock?: () => Date
  createId?: () => string
  maximumAccounts?: number
}

const modeRanks: Readonly<Record<RequestedSyncMode, number>> = {
  profile_only: 0,
  recent_20: 20,
  recent_100: 100
}

/** Durable host queue for account sync jobs. It never opens an account browser itself. */
export class SyncBatchService {
  private readonly clock: () => Date
  private readonly createId: () => string
  private readonly maximumAccounts: number
  private wakeTimer: ReturnType<typeof setTimeout> | null = null
  private draining = false
  private activeExecutions = 0
  private stopped = true
  private mutationChain: Promise<void> = Promise.resolve()

  constructor(
    private readonly repository: SyncBatchRepository,
    private readonly platformSync: PlatformSyncService,
    private readonly jobs: JobService,
    options: SyncBatchServiceOptions = {}
  ) {
    this.clock = options.clock ?? (() => new Date())
    this.createId = options.createId ?? randomUUID
    this.maximumAccounts = Math.max(1, Math.min(500, options.maximumAccounts ?? 200))
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.wake()
  }

  stop(): void {
    this.stopped = true
    if (this.wakeTimer) clearTimeout(this.wakeTimer)
    this.wakeTimer = null
  }

  hasRunningTasks(): boolean {
    return this.activeExecutions > 0
  }

  async preview(input: EnqueueSyncBatchInput): Promise<SyncBatchPreview> {
    const requestedScope = input.requestedScope ?? 'account_default'
    const selected = await this.resolveAccounts(input)
    const activeAccountIds = new Set((await this.repository.listJobs())
      .filter((job) => ['queued', 'validating', 'committing'].includes(job.status))
      .map((job) => job.accountId))
    const accounts = selected.map((account) => this.previewAccount(
      account,
      requestedScope,
      activeAccountIds.has(account.id)
    ))
    return {
      requestedScope,
      accounts,
      eligibleAccountIds: accounts.filter((account) => account.status === 'ready').map((account) => account.accountId),
      skippedAccountIds: accounts.filter((account) => account.status !== 'ready').map((account) => account.accountId)
    }
  }

  async enqueue(input: EnqueueSyncBatchInput): Promise<EnqueueSyncBatchResult> {
    return await this.serializeMutation(() => this.enqueueInternal(input))
  }

  private async enqueueInternal(input: EnqueueSyncBatchInput): Promise<EnqueueSyncBatchResult> {
    const trigger = input.trigger ?? 'manual'
    if (trigger !== 'manual' && trigger !== 'retry' && trigger !== 'scheduled') {
      throw new Error('账号同步批次的触发来源无效')
    }
    const preview = await this.preview(input)
    const ready = preview.accounts.filter((account) => account.status === 'ready')
    if (ready.length === 0) throw new Error(preview.accounts[0]?.message || '没有可同步的账号')
    const now = this.now()
    const jobInputs: CreateJobInput[] = ready.map((item) => {
      const descriptor = this.platformSync.descriptorForAccount(item.accountId)
      return {
        id: this.createId(),
        kind: 'managed_sync',
        accountId: item.accountId,
        pluginId: descriptor.pluginId,
        contributionId: descriptor.contributionId,
        trigger,
        status: 'queued',
        progress: 0,
        stage: '等待同步',
        attempt: 1,
        retryOfJobId: null,
        requestedSyncMode: item.requestedSyncMode,
        createdAt: now,
        startedAt: null,
        finishedAt: null
      }
    })
    const created = await this.repository.createSyncBatch({
      id: this.createId(),
      trigger,
      requestedScope: preview.requestedScope,
      createdAt: now
    }, jobInputs)
    for (const job of created.jobs) this.jobs.publishPersisted(job)
    this.wake()
    return {
      ...created,
      skipped: preview.accounts.filter((account) => account.status !== 'ready')
    }
  }

  async retry(jobId: string): Promise<EnqueueSyncBatchResult> {
    return await this.serializeMutation(() => this.retryInternal(jobId))
  }

  private async retryInternal(jobId: string): Promise<EnqueueSyncBatchResult> {
    const original = await this.repository.getJob(jobId)
    if (!original) throw new SafeJobError('JOB_NOT_FOUND', '任务不存在')
    if (original.status !== 'failed' && original.status !== 'interrupted') {
      throw new SafeJobError('JOB_NOT_RETRYABLE', '只能重试失败或中断的账号同步任务')
    }
    const preview = await this.preview({
      accountIds: [original.accountId],
      requestedScope: original.requestedSyncMode ?? 'account_default',
      trigger: 'retry'
    })
    const candidate = preview.accounts[0]
    if (!candidate || candidate.status !== 'ready' || !candidate.requestedSyncMode) {
      throw new SafeJobError('JOB_RETRY_BLOCKED', candidate?.message || '该账号当前不能重试')
    }
    const descriptor = this.platformSync.descriptorForAccount(original.accountId)
    if (descriptor.pluginId !== original.pluginId || descriptor.contributionId !== original.contributionId) {
      throw new SafeJobError('ADAPTER_CHANGED', '账号适配器已变化，请先完成身份复验后再同步')
    }
    const now = this.now()
    const created = await this.repository.createSyncBatch({
      id: this.createId(),
      trigger: 'retry',
      requestedScope: candidate.requestedSyncMode,
      createdAt: now
    }, [{
      id: this.createId(),
      kind: 'managed_sync',
      accountId: original.accountId,
      pluginId: original.pluginId,
      contributionId: original.contributionId,
      trigger: 'retry',
      status: 'queued',
      progress: 0,
      stage: '等待重试',
      attempt: original.attempt + 1,
      retryOfJobId: original.id,
      requestedSyncMode: candidate.requestedSyncMode,
      createdAt: now,
      startedAt: null,
      finishedAt: null
    }])
    for (const job of created.jobs) this.jobs.publishPersisted(job)
    this.wake()
    return { ...created, skipped: [] }
  }

  async cancel(jobId: string): Promise<JobRecord> {
    const cancelled = await this.jobs.cancel(jobId)
    await this.repository.clearManagedSyncQueueState(cancelled.accountId, cancelled.finishedAt ?? this.now())
    return cancelled
  }

  private async resolveAccounts(input: EnqueueSyncBatchInput): Promise<Account[]> {
    const accountIds = new Set((input.accountIds ?? []).filter(Boolean))
    const groupIds = new Set((input.groupIds ?? []).filter(Boolean))
    if (accountIds.size === 0 && groupIds.size === 0) throw new Error('请选择至少一个账号或分组')
    const [accounts, groups] = await Promise.all([
      this.repository.listAccounts(),
      this.repository.listGroups()
    ])
    const knownGroups = new Set(groups.map((group) => group.id))
    for (const groupId of groupIds) {
      if (!knownGroups.has(groupId)) throw new Error('所选分组不存在')
    }
    const knownAccounts = new Map(accounts.map((account) => [account.id, account]))
    for (const accountId of accountIds) {
      if (!knownAccounts.has(accountId)) throw new Error('所选账号不存在')
    }
    for (const account of accounts) {
      if (account.groupIds.some((groupId) => groupIds.has(groupId))) accountIds.add(account.id)
    }
    if (accountIds.size === 0) throw new Error('所选分组中没有账号')
    if (accountIds.size > this.maximumAccounts) throw new Error(`单个批次最多同步 ${this.maximumAccounts} 个账号`)
    return accounts.filter((account) => accountIds.has(account.id))
  }

  private previewAccount(
    account: Account,
    requestedScope: SyncBatchScope,
    alreadyQueued: boolean
  ): SyncBatchPreviewAccount {
    const base = {
      accountId: account.id,
      accountAlias: account.alias.trim() || account.remoteName.trim() || '平台账号',
      platformId: account.platformId,
      contributionId: account.adapterContributionId
    }
    if (alreadyQueued) return {
      ...base,
      requestedSyncMode: null,
      status: 'already_queued',
      message: '该账号已有同步任务'
    }
    let descriptor: SyncAdapterDescriptor
    try {
      descriptor = this.platformSync.descriptorForAccount(account.id)
    } catch {
      return {
        ...base,
        requestedSyncMode: null,
        status: 'adapter_unavailable',
        message: '账号适配器当前不可用'
      }
    }
    if (!descriptor.pluginId || !descriptor.contributionId) return {
      ...base,
      requestedSyncMode: null,
      status: 'adapter_unavailable',
      message: '账号适配器当前不可用'
    }
    if (account.connectionStatus !== 'ready') return {
      ...base,
      requestedSyncMode: null,
      status: 'login_required',
      message: '请先通过官方入口完成登录并重新核验'
    }
    if (account.ownershipStatus !== 'plugin_verified' || !account.remoteId) return {
      ...base,
      requestedSyncMode: null,
      status: 'identity_required',
      message: '请先核验当前登录账号身份'
    }
    if (!account.syncEnabled || account.syncMode === 'disabled') return {
      ...base,
      requestedSyncMode: null,
      status: 'sync_disabled',
      message: '该账号的数据同步尚未启用'
    }
    const requestedSyncMode = requestedScope === 'account_default' ? account.syncMode : requestedScope
    if (modeRanks[requestedSyncMode] > modeRanks[account.syncMode]) return {
      ...base,
      requestedSyncMode: null,
      status: 'scope_not_authorized',
      message: '所选同步范围超过该账号已保存的授权范围'
    }
    return {
      ...base,
      requestedSyncMode,
      status: 'ready',
      message: '可以在后台同步'
    }
  }

  private wake(delay = 0): void {
    if (this.stopped || this.draining || this.wakeTimer) return
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = null
      void this.drain().catch((error: unknown) => {
        markErrorReported(error, {
          scope: 'sync',
          context: { stage: 'queue-drain' }
        })
        if (!this.stopped) this.wake(1_000)
      })
    }, delay)
    this.wakeTimer.unref?.()
  }

  private async drain(): Promise<void> {
    if (this.stopped || this.draining) return
    this.draining = true
    try {
      while (!this.stopped) {
        const queued = (await this.repository.listJobs())
          .filter((job) => job.kind === 'managed_sync' && job.status === 'queued')
          .sort(compareQueuedJobs)
        if (queued.length === 0) break
        const selected = new Map<string, JobRecord>()
        for (const job of queued) {
          if (!selected.has(job.contributionId)) selected.set(job.contributionId, job)
        }
        const results = await Promise.all([...selected.values()].map((job) => this.execute(job)))
        if (results.includes('deferred')) {
          await new Promise((resolve) => setTimeout(resolve, 250))
        }
      }
    } finally {
      this.draining = false
      if (!this.stopped) {
        const hasQueued = (await this.repository.listJobs()).some((job) => job.status === 'queued')
        if (hasQueued) this.wake()
      }
    }
  }

  private async execute(job: JobRecord): Promise<'done' | 'deferred'> {
    this.activeExecutions += 1
    try {
      const current = await this.repository.getJob(job.id)
      if (!current || current.status !== 'queued') return 'done'
      const descriptor = this.platformSync.descriptorForAccount(job.accountId)
      if (descriptor.pluginId !== job.pluginId || descriptor.contributionId !== job.contributionId) {
        await this.jobs.failQueued(job.id, 'ADAPTER_CHANGED', '账号适配器已变化，请重新发起同步')
        await this.repository.clearManagedSyncQueueState(job.accountId, this.now())
        return 'done'
      }
      await this.jobs.runPreparedManagedSync(job.id, () => this.platformSync.sync(job.accountId))
      return 'done'
    } catch (error) {
      const current = await this.repository.getJob(job.id)
      if (current?.status === 'queued' && (
        error instanceof AccountExecutionBusyError || error instanceof PlatformSyncBusyError
      )) return 'deferred'
      if (current?.status === 'queued') {
        markErrorReported(error, {
          scope: 'sync',
          context: {
            jobId: job.id,
            accountId: job.accountId,
            pluginId: job.pluginId,
            contributionId: job.contributionId,
            stage: '启动同步',
            attempt: job.attempt
          }
        })
        await this.jobs.failQueued(
          job.id,
          error instanceof SafeJobError ? error.code : 'SYNC_START_FAILED',
          safeMessage(error)
        )
        await this.repository.clearManagedSyncQueueState(job.accountId, this.now())
      }
      return 'done'
    } finally {
      this.activeExecutions -= 1
    }
  }

  private now(): string {
    const value = this.clock()
    if (!Number.isFinite(value.getTime())) throw new Error('SyncBatchService clock returned an invalid date')
    return value.toISOString()
  }

  private async serializeMutation<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.mutationChain
    let release!: () => void
    this.mutationChain = new Promise<void>((resolve) => { release = resolve })
    await previous.catch(() => undefined)
    try {
      return await action()
    } finally {
      release()
    }
  }
}

function compareQueuedJobs(left: JobRecord, right: JobRecord): number {
  const priority = (job: JobRecord): number => job.trigger === 'manual' || job.trigger === 'retry' ? 0 : 1
  return priority(left) - priority(right) || left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)
}

function safeMessage(error: unknown): string {
  const value = error instanceof Error ? error.message : '同步任务启动失败'
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500) || '同步任务启动失败'
}
