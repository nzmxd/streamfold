import { randomUUID } from 'node:crypto'
import type { JobRecord, JobStatus } from '../../shared/job-contracts'
import { SafeJobError } from '../plugins/errors'

export type MaybePromise<T> = T | Promise<T>
export type JobChangedListener = (job: JobRecord) => void

export interface CreateJobRecord {
  id: string
  kind: JobRecord['kind']
  accountId: string
  pluginId: string
  status: JobStatus
  progress: number
  stage: string
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
  queued: ['validating', 'cancelled'],
  validating: ['committing', 'failed', 'cancelled'],
  committing: ['succeeded', 'failed'],
  succeeded: [],
  failed: [],
  cancelled: [],
  interrupted: []
}

export class JobService {
  private readonly listeners = new Set<JobChangedListener>()
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
    if (job.status !== 'queued' && job.status !== 'validating') {
      throw new SafeJobError('JOB_NOT_CANCELLABLE', '只能取消等待或校验中的任务')
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

  async createManagedSync(accountId: string, pluginId: string): Promise<JobRecord> {
    return this.createActive(accountId, pluginId, 'managed_sync', '复验当前登录身份')
  }

  private async createActive(
    accountId: string,
    pluginId: string,
    kind: JobRecord['kind'],
    stage: string
  ): Promise<JobRecord> {
    const now = this.nowIso()
    const job = await this.repository.createJob({
      id: this.createId(),
      kind,
      accountId,
      pluginId,
      status: 'validating',
      progress: 10,
      stage,
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
