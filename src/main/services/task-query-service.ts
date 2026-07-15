import type { Account } from '../../shared/contracts'
import type {
  JobBatchRecord,
  JobRecord,
  MarkTaskHandledInput,
  TaskAttentionResolutionRecord,
  TaskBatchView,
  TaskKind,
  TaskListResult,
  TaskQuery,
  TaskStatus,
  TaskSummary,
  TaskTrigger,
  TaskView
} from '../../shared/job-contracts'
import type { PluginRunRecord } from '../../shared/plugin-host-contracts'

type MaybePromise<T> = T | Promise<T>

export interface TaskQueryRepository {
  listJobs(): MaybePromise<JobRecord[]>
  getJob(id: string): MaybePromise<JobRecord | null>
  listJobBatches(): MaybePromise<JobBatchRecord[]>
  getJobBatch(id: string): MaybePromise<JobBatchRecord | null>
  listPluginRuns(limit?: number): MaybePromise<PluginRunRecord[]>
  getPluginRun(id: string): MaybePromise<PluginRunRecord | null>
  listAccounts(): MaybePromise<Account[]>
  listTaskAttentionResolutions(): MaybePromise<TaskAttentionResolutionRecord[]>
  markTaskAttentionHandled(
    source: TaskAttentionResolutionRecord['source'],
    taskId: string,
    resolvedAt: string
  ): MaybePromise<TaskAttentionResolutionRecord>
}

export type TaskBackingSource =
  | { source: 'job'; record: JobRecord }
  | { source: 'plugin-run'; record: PluginRunRecord }

export interface TaskQueryServiceOptions {
  clock?: () => Date
  defaultLimit?: number
  maxLimit?: number
  pluginRunReadLimit?: number
}

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200
const PLUGIN_RUN_READ_LIMIT = 500
const pausedJobErrorCodes = new Set([
  'AUTH_REQUIRED',
  'LOGIN_REQUIRED',
  'IDENTITY_MISMATCH',
  'RISK_CONTROL',
  'RATE_LIMITED',
  'HTTP_429',
  'CHALLENGE',
  'SESSION_EXPIRED',
  'PLUGIN_SESSION_EXPIRED'
])

const pluginRunStages: Readonly<Record<PluginRunRecord['status'], string>> = {
  queued: '等待运行',
  running: '正在运行',
  succeeded: '运行完成',
  failed: '运行失败',
  cancelled: '已取消',
  interrupted: '运行中断'
}

/**
 * Read-only projection over managed account sync jobs and generic plugin runs.
 *
 * The underlying stores intentionally remain independent. This service gives IPC and
 * renderer code one stable task model without granting either layer database access.
 */
export class TaskQueryService {
  private readonly clock: () => Date
  private readonly defaultLimit: number
  private readonly maxLimit: number
  private readonly pluginRunReadLimit: number

  constructor(
    private readonly repository: TaskQueryRepository,
    options: TaskQueryServiceOptions = {}
  ) {
    this.clock = options.clock ?? (() => new Date())
    this.maxLimit = positiveInteger(options.maxLimit, MAX_LIMIT)
    this.defaultLimit = Math.min(
      positiveInteger(options.defaultLimit, DEFAULT_LIMIT),
      this.maxLimit
    )
    this.pluginRunReadLimit = positiveInteger(
      options.pluginRunReadLimit,
      PLUGIN_RUN_READ_LIMIT
    )
  }

  async list(query: TaskQuery = {}): Promise<TaskListResult> {
    const tasks = applyQuery(await this.loadTasks(), query)
    const offset = nonNegativeInteger(query.offset, 0)
    const limit = Math.min(positiveInteger(query.limit, this.defaultLimit), this.maxLimit)

    return {
      items: tasks.slice(offset, offset + limit),
      total: tasks.length,
      offset,
      limit
    }
  }

  async get(id: string): Promise<TaskView | null> {
    const source = await this.getSource(id)
    return source ? this.projectSource(source) : null
  }

  /** Resolves the backing record for mutation services such as cancel and retry. */
  async getSource(id: string): Promise<TaskBackingSource | null> {
    const job = await this.repository.getJob(id)
    if (job) return { source: 'job', record: cloneJob(job) }
    const run = await this.repository.getPluginRun(id)
    return run ? { source: 'plugin-run', record: { ...run } } : null
  }

  async markHandled(input: MarkTaskHandledInput): Promise<TaskView> {
    const record = input.source === 'job'
      ? await this.repository.getJob(input.taskId)
      : await this.repository.getPluginRun(input.taskId)
    if (!record) throw new Error('任务不存在')
    const task = await this.projectSource(input.source === 'job'
      ? { source: 'job', record: record as JobRecord }
      : { source: 'plugin-run', record: record as PluginRunRecord })
    if (task.attentionState === 'handled') return task
    if (task.attentionState === 'superseded') throw new Error('该任务已由后续成功任务解决')
    if (task.attentionState !== 'pending') throw new Error('该任务不需要处理')

    const resolvedAt = this.now().toISOString()
    await this.repository.markTaskAttentionHandled(input.source, input.taskId, resolvedAt)
    return {
      ...task,
      attentionState: 'handled',
      attentionResolvedAt: resolvedAt,
      attentionSupersededByTaskId: null
    }
  }

  async summary(query: TaskQuery = {}): Promise<TaskSummary> {
    const tasks = applyQuery(await this.loadTasks(), withoutPagination(query))
    const now = this.now()
    const startOfToday = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate()
    ).getTime()
    const startOfTomorrow = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() + 1
    ).getTime()
    const finishedToday = (task: TaskView): boolean => {
      const value = Date.parse(task.finishedAt ?? task.createdAt)
      return Number.isFinite(value) && value >= startOfToday && value < startOfTomorrow
    }

    return {
      queuedCount: tasks.filter((task) => task.status === 'queued').length,
      runningCount: tasks.filter((task) => task.status === 'running').length,
      needsAttentionCount: tasks.filter((task) => task.attentionState === 'pending').length,
      completedTodayCount: tasks.filter((task) =>
        task.status === 'succeeded' && finishedToday(task)
      ).length,
      failedTodayCount: tasks.filter((task) =>
        task.status === 'failed' && finishedToday(task)
      ).length,
      updatedAt: now.toISOString()
    }
  }

  async getBatch(id: string): Promise<TaskBatchView | null> {
    const [batch, jobs, accounts, resolutions] = await Promise.all([
      this.repository.getJobBatch(id),
      this.repository.listJobs(),
      this.repository.listAccounts(),
      this.repository.listTaskAttentionResolutions()
    ])
    if (!batch) return null
    const accountsById = indexAccounts(accounts)
    const tasks = applyAttentionState(
      jobs.map((job) => mapJob(job, accountsById)),
      resolutions
    ).filter((task) => task.batchId === id)
      .sort(compareTasks)
    return buildBatchView(batch, tasks)
  }

  async listBatches(): Promise<TaskBatchView[]> {
    const [batches, jobs, accounts, resolutions] = await Promise.all([
      this.repository.listJobBatches(),
      this.repository.listJobs(),
      this.repository.listAccounts(),
      this.repository.listTaskAttentionResolutions()
    ])
    const accountsById = indexAccounts(accounts)
    const tasksByBatch = new Map<string, TaskView[]>()
    const projectedJobs = applyAttentionState(
      jobs.map((job) => mapJob(job, accountsById)),
      resolutions
    )
    for (const task of projectedJobs) {
      if (!task.batchId) continue
      const tasks = tasksByBatch.get(task.batchId) ?? []
      tasks.push(task)
      tasksByBatch.set(task.batchId, tasks)
    }

    return [...batches]
      .sort(compareBatches)
      .map((batch) => buildBatchView(
        batch,
        (tasksByBatch.get(batch.id) ?? []).sort(compareTasks)
      ))
  }

  private async loadTasks(): Promise<TaskView[]> {
    const [jobs, pluginRuns, accounts, resolutions] = await Promise.all([
      this.repository.listJobs(),
      this.repository.listPluginRuns(this.pluginRunReadLimit),
      this.repository.listAccounts(),
      this.repository.listTaskAttentionResolutions()
    ])
    const accountsById = indexAccounts(accounts)
    return applyAttentionState([
      ...jobs.map((job) => mapJob(job, accountsById)),
      ...pluginRuns.map((run) => mapPluginRun(run, accountsById))
    ], resolutions).sort(compareTasks)
  }

  private async projectSource(source: TaskBackingSource): Promise<TaskView> {
    const [jobs, pluginRuns, accounts, resolutions] = await Promise.all([
      this.repository.listJobs(),
      this.repository.listPluginRuns(this.pluginRunReadLimit),
      this.repository.listAccounts(),
      this.repository.listTaskAttentionResolutions()
    ])
    const accountsById = indexAccounts(accounts)
    const target = source.source === 'job'
      ? mapJob(source.record, accountsById)
      : mapPluginRun(source.record, accountsById)
    const tasks = [
      ...jobs.map((job) => mapJob(job, accountsById)),
      ...pluginRuns.map((run) => mapPluginRun(run, accountsById))
    ]
    if (!tasks.some((task) => task.source === target.source && task.id === target.id)) {
      tasks.push(target)
    }
    return applyAttentionState(tasks, resolutions).find((task) => (
      task.source === target.source && task.id === target.id
    ))!
  }

  private now(): Date {
    const now = this.clock()
    if (!Number.isFinite(now.getTime())) {
      throw new Error('TaskQueryService clock returned an invalid date')
    }
    return now
  }
}

function mapJob(job: JobRecord, accountsById: ReadonlyMap<string, Account>): TaskView {
  const account = accountsById.get(job.accountId)
  return {
    id: job.id,
    source: 'job',
    batchId: job.batchId,
    kind: 'account.sync',
    trigger: job.trigger,
    status: mapJobStatus(job, account),
    accountId: job.accountId,
    accountAlias: account?.alias || account?.remoteName || '',
    platformId: account?.platformId ?? null,
    pluginId: job.pluginId || null,
    contributionId: job.contributionId || null,
    progress: job.progress,
    stage: job.stage,
    attempt: job.attempt,
    errorCode: job.errorCode,
    errorMessage: job.errorMessage,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    nextAttemptAt: null,
    attentionState: null,
    attentionResolvedAt: null,
    attentionSupersededByTaskId: null
  }
}

function mapPluginRun(
  run: PluginRunRecord,
  accountsById: ReadonlyMap<string, Account>
): TaskView {
  const account = run.accountId ? accountsById.get(run.accountId) : undefined
  return {
    id: run.id,
    source: 'plugin-run',
    batchId: null,
    kind: mapPluginRunKind(run.trigger),
    trigger: mapPluginTrigger(run.trigger),
    status: run.status,
    accountId: run.accountId,
    accountAlias: account?.alias || account?.remoteName || '',
    platformId: account?.platformId ?? null,
    pluginId: run.pluginId,
    contributionId: run.contributionId,
    progress: null,
    stage: pluginRunStages[run.status],
    attempt: run.attempt,
    errorCode: run.errorCode,
    errorMessage: run.errorMessage,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    nextAttemptAt: run.nextAttemptAt,
    attentionState: null,
    attentionResolvedAt: null,
    attentionSupersededByTaskId: null
  }
}

function applyAttentionState(
  tasks: readonly TaskView[],
  resolutions: readonly TaskAttentionResolutionRecord[]
): TaskView[] {
  const handledByTask = new Map(resolutions.map((resolution) => [
    `${resolution.source}\n${resolution.taskId}`,
    resolution
  ]))
  const latestSuccessByAction = new Map<string, TaskView>()
  for (const task of tasks) {
    if (task.status !== 'succeeded') continue
    const key = logicalActionKey(task)
    const current = latestSuccessByAction.get(key)
    if (!current || sortableTime(task.createdAt) > sortableTime(current.createdAt)) {
      latestSuccessByAction.set(key, task)
    }
  }

  return tasks.map((task) => {
    if (!isAttentionStatus(task.status)) return { ...task }
    const handled = handledByTask.get(`${task.source}\n${task.id}`)
    if (handled) {
      return {
        ...task,
        attentionState: 'handled',
        attentionResolvedAt: handled.resolvedAt,
        attentionSupersededByTaskId: null
      }
    }
    const success = latestSuccessByAction.get(logicalActionKey(task))
    if (success && sortableTime(success.createdAt) > sortableTime(task.createdAt)) {
      return {
        ...task,
        attentionState: 'superseded',
        attentionResolvedAt: success.finishedAt ?? success.createdAt,
        attentionSupersededByTaskId: success.id
      }
    }
    return {
      ...task,
      attentionState: 'pending',
      attentionResolvedAt: null,
      attentionSupersededByTaskId: null
    }
  })
}

function isAttentionStatus(status: TaskStatus): boolean {
  return status === 'failed' || status === 'interrupted' || status === 'paused'
}

function logicalActionKey(task: TaskView): string {
  return JSON.stringify([task.kind, task.accountId, task.pluginId, task.contributionId])
}

function mapJobStatus(job: JobRecord, account: Account | undefined): TaskStatus {
  if (job.status === 'validating' || job.status === 'committing') return 'running'
  if (job.status === 'failed' && (
    pausedJobErrorCodes.has(job.errorCode) ||
    (job.errorCode === 'PLUGIN_ADAPTER_FAILED' && account && (
      account.connectionStatus === 'expired' ||
      account.connectionStatus === 'mismatch' ||
      account.status === 'cooldown'
    ))
  )) return 'paused'
  return job.status
}

function mapPluginRunKind(trigger: PluginRunRecord['trigger']): TaskKind {
  if (trigger === 'event') return 'plugin.event'
  if (trigger === 'schedule') return 'plugin.schedule'
  return 'plugin.action'
}

function mapPluginTrigger(trigger: PluginRunRecord['trigger']): TaskTrigger {
  return trigger === 'schedule' ? 'scheduled' : trigger
}

function applyQuery(tasks: readonly TaskView[], query: TaskQuery): TaskView[] {
  const kinds = query.kinds?.length ? new Set(query.kinds) : null
  const statuses = query.statuses?.length ? new Set(query.statuses) : null
  const triggers = query.triggers?.length ? new Set(query.triggers) : null
  const createdFrom = parseOptionalDate(query.createdFrom)
  const createdTo = parseOptionalDate(query.createdTo)
  const search = query.search?.trim().toLocaleLowerCase() ?? ''

  return tasks.filter((task) => {
    if (query.batchId !== undefined && task.batchId !== query.batchId) return false
    if (kinds && !kinds.has(task.kind)) return false
    if (statuses && !statuses.has(task.status)) return false
    if (triggers && !triggers.has(task.trigger)) return false
    if (query.platformId !== undefined && task.platformId !== query.platformId) return false
    if (query.accountId !== undefined && task.accountId !== query.accountId) return false
    if (query.pluginId !== undefined && task.pluginId !== query.pluginId) return false
    if (query.contributionId !== undefined && task.contributionId !== query.contributionId) return false
    if (query.attention === 'pending' && task.attentionState !== 'pending') return false
    if (query.attention === 'resolved' && (
      task.attentionState !== 'handled' && task.attentionState !== 'superseded'
    )) return false

    const createdAt = Date.parse(task.createdAt)
    if (createdFrom !== null && (!Number.isFinite(createdAt) || createdAt < createdFrom)) return false
    if (createdTo !== null && (!Number.isFinite(createdAt) || createdAt > createdTo)) return false
    if (search && !taskSearchText(task).includes(search)) return false
    return true
  })
}

function taskSearchText(task: TaskView): string {
  return [
    task.id,
    task.batchId,
    task.kind,
    task.trigger,
    task.status,
    task.accountId,
    task.accountAlias,
    task.platformId,
    task.pluginId,
    task.contributionId,
    task.stage,
    task.errorCode,
    task.errorMessage,
    task.attentionState
  ].filter((value): value is string => Boolean(value)).join('\n').toLocaleLowerCase()
}

function buildBatchView(batch: JobBatchRecord, tasks: TaskView[]): TaskBatchView {
  const count = (status: TaskStatus): number =>
    tasks.filter((task) => task.status === status).length
  return {
    batch: { ...batch },
    tasks: [...tasks],
    totalCount: tasks.length,
    queuedCount: count('queued'),
    runningCount: count('running'),
    succeededCount: count('succeeded'),
    failedCount: count('failed'),
    cancelledCount: count('cancelled'),
    interruptedCount: count('interrupted'),
    pausedCount: count('paused'),
    needsAttentionCount: tasks.filter((task) => task.attentionState === 'pending').length
  }
}

function compareTasks(left: TaskView, right: TaskView): number {
  const timeDifference = sortableTime(right.createdAt) - sortableTime(left.createdAt)
  if (timeDifference !== 0) return timeDifference
  const idDifference = compareText(left.id, right.id)
  return idDifference !== 0 ? idDifference : compareText(left.kind, right.kind)
}

function compareBatches(left: JobBatchRecord, right: JobBatchRecord): number {
  const timeDifference = sortableTime(right.createdAt) - sortableTime(left.createdAt)
  return timeDifference !== 0 ? timeDifference : compareText(left.id, right.id)
}

function compareText(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function sortableTime(value: string): number {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function parseOptionalDate(value: string | undefined): number | null {
  if (value === undefined) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function indexAccounts(accounts: readonly Account[]): ReadonlyMap<string, Account> {
  return new Map(accounts.map((account) => [account.id, account]))
}

function withoutPagination(query: TaskQuery): TaskQuery {
  const { offset: _offset, limit: _limit, ...filters } = query
  return filters
}

function nonNegativeInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && value !== undefined && value >= 0 ? value : fallback
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && value !== undefined && value > 0 ? value : fallback
}

function cloneJob(job: JobRecord): JobRecord {
  return {
    ...job,
    result: job.result ? { ...job.result } : null
  }
}
