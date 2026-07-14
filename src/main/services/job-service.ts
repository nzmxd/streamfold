import { randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import type {
  JobRecord,
  JobStatus,
  RequestedSyncMode,
  TaskTrigger
} from '../../shared/job-contracts'
import { SafeJobError } from '../plugins/errors'

export type MaybePromise<T> = T | Promise<T>
export type JobChangedListener = (job: JobRecord) => void

export interface CreateJobRecord {
  id: string
  batchId: string | null
  kind: JobRecord['kind']
  accountId: string
  pluginId: string
  contributionId: string
  trigger: TaskTrigger
  status: JobStatus
  progress: number
  stage: string
  attempt: number
  retryOfJobId: string | null
  requestedSyncMode: RequestedSyncMode | null
  result: Record<string, unknown> | null
  errorCode: string
  errorMessage: string
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
}

export interface JobRepository {
  listJobs(): MaybePromise<JobRecord[]>
  getJob(id: string): MaybePromise<JobRecord | null>
  createJob(job: CreateJobRecord): MaybePromise<JobRecord>
  updateJob(
    id: string,
    patch: Partial<Omit<JobRecord, 'id'>>,
    /** Implementations should enforce this as a compare-and-swap in the same transaction. */
    expectedStatuses?: readonly JobStatus[]
  ): MaybePromise<JobRecord>
}

export interface JobServiceOptions {
  clock?: () => Date
  createId?: () => string
}

const allowedTransitions: Readonly<Record<JobStatus, readonly JobStatus[]>> = {
  queued: ['validating', 'failed', 'cancelled'],
  validating: ['committing', 'failed'],
  committing: ['succeeded', 'failed'],
  succeeded: [],
  failed: [],
  cancelled: [],
  interrupted: []
}

export class JobService {
  private readonly listeners = new Set<JobChangedListener>()
  private readonly execution = new AsyncLocalStorage<{
    jobId: string
    requestedSyncMode: RequestedSyncMode
  }>()
  private readonly clock: () => Date
  private readonly createId: () => string

  constructor(
    private readonly repository: JobRepository,
    options: JobServiceOptions = {}
  ) {
    this.clock = options.clock ?? (() => new Date())
    this.createId = options.createId ?? randomUUID
  }

  async list(): Promise<JobRecord[]> {
    const jobs = await this.repository.listJobs()
    return jobs.map(cloneJob)
  }

  async hasPendingForAccount(accountId: string): Promise<boolean> {
    const jobs = await this.repository.listJobs()
    return jobs.some((job) => job.accountId === accountId &&
      (job.status === 'queued' || job.status === 'validating' || job.status === 'committing'))
  }

  async refresh(id: string): Promise<JobRecord> {
    const job = await this.repository.getJob(id)
    if (!job) throw new SafeJobError('JOB_NOT_FOUND', '任务不存在')
    this.emit(job)
    return cloneJob(job)
  }

  /** Emits a job that was finalized atomically by a repository transaction. */
  publishPersisted(job: JobRecord): JobRecord {
    this.emit(job)
    return cloneJob(job)
  }

  async cancel(id: string): Promise<JobRecord> {
    const job = await this.repository.getJob(id)
    if (!job) throw new SafeJobError('JOB_NOT_FOUND', '任务不存在')
    if (job.status !== 'queued') {
      throw new SafeJobError('JOB_NOT_CANCELLABLE', '只能取消尚未开始的排队任务')
    }
    return this.transition(job, 'cancelled', {
      stage: '已取消',
      finishedAt: this.nowIso()
    })
  }

  onChanged(listener: JobChangedListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async createManagedSync(
    accountId: string,
    pluginId: string,
    contributionId = ''
  ): Promise<JobRecord> {
    const prepared = this.execution.getStore()
    if (prepared) {
      const job = await this.repository.getJob(prepared.jobId)
      if (!job || job.status !== 'queued' || job.kind !== 'managed_sync' ||
        job.accountId !== accountId || job.pluginId !== pluginId ||
        (contributionId && job.contributionId !== contributionId)) {
        throw new SafeJobError('PREPARED_JOB_MISMATCH', '排队任务与当前同步请求不一致')
      }
      return await this.transition(job, 'validating', {
        progress: 10,
        stage: '复验当前登录身份',
        startedAt: this.nowIso(),
        finishedAt: null,
        errorCode: '',
        errorMessage: ''
      })
    }
    return this.createActive(accountId, pluginId, contributionId, 'managed_sync', '复验当前登录身份')
  }

  /** Runs an adapter with an already persisted queued job bound to the async call chain. */
  async runPreparedManagedSync<T>(jobId: string, action: () => Promise<T>): Promise<T> {
    const job = await this.repository.getJob(jobId)
    if (!job) throw new SafeJobError('JOB_NOT_FOUND', '任务不存在')
    if (job.kind !== 'managed_sync' || job.status !== 'queued' || !job.requestedSyncMode) {
      throw new SafeJobError('JOB_NOT_RUNNABLE', '任务已不在可执行的排队状态')
    }
    return await this.execution.run({
      jobId: job.id,
      requestedSyncMode: job.requestedSyncMode
    }, action)
  }

  requestedSyncMode(fallback: RequestedSyncMode): RequestedSyncMode {
    return this.execution.getStore()?.requestedSyncMode ?? fallback
  }

  async failQueued(
    id: string,
    errorCode: string,
    errorMessage: string,
    stage = '同步未开始'
  ): Promise<JobRecord> {
    const job = await this.repository.getJob(id)
    if (!job) throw new SafeJobError('JOB_NOT_FOUND', '任务不存在')
    if (job.status !== 'queued') return cloneJob(job)
    return await this.transition(job, 'failed', {
      progress: 100,
      stage,
      errorCode: errorCode.slice(0, 80),
      errorMessage: errorMessage.slice(0, 500),
      finishedAt: this.nowIso()
    })
  }

  private async createActive(
    accountId: string,
    pluginId: string,
    contributionId: string,
    kind: JobRecord['kind'],
    stage: string
  ): Promise<JobRecord> {
    const now = this.nowIso()
    const job = await this.repository.createJob({
      id: this.createId(),
      batchId: null,
      kind,
      accountId,
      pluginId,
      contributionId,
      trigger: 'manual',
      status: 'validating',
      progress: 10,
      stage,
      attempt: 1,
      retryOfJobId: null,
      requestedSyncMode: null,
      result: null,
      errorCode: '',
      errorMessage: '',
      createdAt: now,
      startedAt: now,
      finishedAt: null
    })
    this.emit(job)
    return cloneJob(job)
  }

  async transition(
    job: JobRecord,
    status: JobStatus,
    patch: Partial<Omit<JobRecord, 'id' | 'status'>> = {}
  ): Promise<JobRecord> {
    if (!allowedTransitions[job.status].includes(status)) {
      throw new SafeJobError('INVALID_JOB_TRANSITION', '任务状态已变更，请刷新后重试')
    }
    const updated = await this.repository.updateJob(job.id, { ...patch, status }, [job.status])
    this.emit(updated)
    return cloneJob(updated)
  }

  private nowIso(): string {
    const value = this.clock()
    if (!Number.isFinite(value.getTime())) throw new Error('JobService clock returned an invalid date')
    return value.toISOString()
  }

  private emit(job: JobRecord): void {
    for (const listener of this.listeners) {
      try {
        listener(cloneJob(job))
      } catch {
        // A renderer notification failure must never change a persisted job result.
      }
    }
  }
}

function cloneJob(job: JobRecord): JobRecord {
  return {
    ...job,
    result: job.result ? { ...job.result } : null
  }
}
