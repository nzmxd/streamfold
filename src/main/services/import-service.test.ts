import { describe, expect, it } from 'vitest'
import type { JobRecord } from '../../shared/job-contracts'
import { SafeImportError } from '../plugins/errors'
import type {
  ImportCommitMetadata,
  ImportCommitStats,
  NormalizedImportPayload
} from '../plugins/types'
import {
  ImportService,
  MAX_IMPORT_FILE_BYTES,
  PREVIEW_TTL_MS,
  type ImportFileSystem,
  type ImportRepository,
  type NativeOpenDialog,
  type PluginRunRecord
} from './import-service'
import {
  JobService,
  type CreateJobRecord,
  type JobRepository
} from './job-service'

class MemoryJobRepository implements JobRepository {
  readonly jobs = new Map<string, JobRecord>()
  readonly statusHistory: JobRecord['status'][] = []

  listJobs(): JobRecord[] {
    return [...this.jobs.values()].map((job) => ({ ...job }))
  }

  getJob(id: string): JobRecord | null {
    return this.jobs.get(id) ?? null
  }

  createJob(job: CreateJobRecord): JobRecord {
    const created = { ...job }
    this.jobs.set(job.id, created)
    this.statusHistory.push(created.status)
    return { ...created }
  }

  updateJob(
    id: string,
    patch: Partial<Omit<JobRecord, 'id'>>,
    expectedStatuses?: readonly JobRecord['status'][]
  ): JobRecord {
    const current = this.jobs.get(id)
    if (!current) throw new Error('missing job')
    if (expectedStatuses && !expectedStatuses.includes(current.status)) throw new Error('job state changed')
    const updated: JobRecord = { ...current, ...patch }
    this.jobs.set(id, updated)
    this.statusHistory.push(updated.status)
    return { ...updated }
  }
}

class MemoryImportRepository implements ImportRepository {
  enabled = true
  accountIds = new Set(['account-1', 'account-2'])
  commitError: unknown = null
  runRecordError: unknown = null
  commitMetadata: ImportCommitMetadata | null = null
  committedPayload: NormalizedImportPayload | null = null
  readonly runs: PluginRunRecord[] = []

  accountExists(accountId: string): boolean {
    return this.accountIds.has(accountId)
  }

  isPluginEnabled(): boolean {
    return this.enabled
  }

  commitImport(payload: NormalizedImportPayload, metadata: ImportCommitMetadata): ImportCommitStats {
    this.committedPayload = payload
    this.commitMetadata = metadata
    if (this.commitError) throw this.commitError
    return {
      newContentCount: payload.contents.length,
      updatedContentCount: 0,
      snapshotCount: payload.contents.reduce((count, content) => count + content.snapshots.length, 0),
      skippedSnapshotCount: 0
    }
  }

  recordPluginRun(record: PluginRunRecord): void {
    if (this.runRecordError) throw this.runRecordError
    this.runs.push({ ...record })
  }
}

interface Harness {
  service: ImportService
  jobs: JobService
  jobRepository: MemoryJobRepository
  importRepository: MemoryImportRepository
  advance(milliseconds: number): void
}

function createHarness(overrides: {
  source?: string
  selectedPath?: string
  size?: number
} = {}): Harness {
  let nowMs = Date.parse('2026-07-13T08:00:00.000Z')
  const clock = (): Date => new Date(nowMs)
  const selectedPath = overrides.selectedPath ?? '/private-folder/social-export.json'
  const bytes = new TextEncoder().encode(overrides.source ?? JSON.stringify({
    account: { remote_id: 'owner-1', remote_name: '本人账号' },
    contents: [{
      remote_id: 'post-1',
      type: 'post',
      title: '标题',
      url: 'https://example.com/posts/1',
      views: 10
    }]
  }))
  const dialog: NativeOpenDialog = {
    async showOpenDialog() {
      return { canceled: false, filePaths: [selectedPath] }
    }
  }
  const fileSystem: ImportFileSystem = {
    async stat() {
      return { size: overrides.size ?? bytes.byteLength, isFile: () => true }
    },
    async readFile() {
      return bytes
    }
  }
  const jobRepository = new MemoryJobRepository()
  const importRepository = new MemoryImportRepository()
  const jobs = new JobService(jobRepository, { clock, createId: () => 'job-1' })
  const service = new ImportService({
    dialog,
    fileSystem,
    repository: importRepository,
    jobs,
    clock,
    createToken: () => 'preview-token-1'
  })
  return {
    service,
    jobs,
    jobRepository,
    importRepository,
    advance(milliseconds) {
      nowMs += milliseconds
    }
  }
}

describe('ImportService', () => {
  it('keeps the full path private and commits only basename/hash metadata', async () => {
    const harness = createHarness()
    const preview = await harness.service.preview('account-1')
    expect(preview).not.toBeNull()
    expect(preview?.fileName).toBe('social-export.json')
    expect(preview?.fileHash).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(preview)).not.toContain('private-folder')

    const result = await harness.service.commit({
      token: preview!.token,
      accountId: 'account-1',
      confirmOwnership: true
    })

    expect(result.job.status).toBe('succeeded')
    expect(harness.jobRepository.statusHistory).toEqual(['validating', 'committing', 'succeeded'])
    expect(harness.importRepository.commitMetadata).toMatchObject({
      accountId: 'account-1',
      pluginId: 'generic-file-import',
      fileName: 'social-export.json',
      fileHash: preview?.fileHash,
      confirmOwnership: true
    })
    expect(JSON.stringify(harness.importRepository.commitMetadata)).not.toContain('private-folder')
    expect(harness.importRepository.runs[0]).toMatchObject({ status: 'succeeded' })
  })

  it('binds a preview token to its account', async () => {
    const harness = createHarness()
    const preview = await harness.service.preview('account-1')
    await expect(harness.service.commit({
      token: preview!.token,
      accountId: 'account-2',
      confirmOwnership: true
    })).rejects.toMatchObject({ code: 'PREVIEW_ACCOUNT_MISMATCH' })

    await expect(harness.service.commit({
      token: preview!.token,
      accountId: 'account-1',
      confirmOwnership: true
    })).resolves.toMatchObject({ job: { status: 'succeeded' } })
  })

  it('expires preview tokens after five minutes', async () => {
    const harness = createHarness()
    const preview = await harness.service.preview('account-1')
    harness.advance(PREVIEW_TTL_MS + 1)
    await expect(harness.service.commit({
      token: preview!.token,
      accountId: 'account-1',
      confirmOwnership: true
    })).rejects.toMatchObject({ code: 'PREVIEW_EXPIRED' })
  })

  it('rejects reuse of a committed preview token', async () => {
    const harness = createHarness()
    const preview = await harness.service.preview('account-1')
    const input = { token: preview!.token, accountId: 'account-1', confirmOwnership: true }
    await harness.service.commit(input)
    await expect(harness.service.commit(input)).rejects.toMatchObject({ code: 'PREVIEW_TOKEN_USED' })
    expect(harness.importRepository.runs).toHaveLength(1)
  })

  it('requires ownership confirmation and an enabled plugin without consuming the preview', async () => {
    const harness = createHarness()
    const preview = await harness.service.preview('account-1')
    await expect(harness.service.commit({
      token: preview!.token,
      accountId: 'account-1',
      confirmOwnership: false
    })).rejects.toMatchObject({ code: 'OWNERSHIP_CONFIRMATION_REQUIRED' })

    harness.importRepository.enabled = false
    await expect(harness.service.commit({
      token: preview!.token,
      accountId: 'account-1',
      confirmOwnership: true
    })).rejects.toMatchObject({ code: 'PLUGIN_DISABLED' })

    harness.importRepository.enabled = true
    await expect(harness.service.commit({
      token: preview!.token,
      accountId: 'account-1',
      confirmOwnership: true
    })).resolves.toMatchObject({ job: { status: 'succeeded' } })
  })

  it('persists a failed job and plugin run, then rethrows the same safe error', async () => {
    const harness = createHarness()
    const preview = await harness.service.preview('account-1')
    const failure = new SafeImportError('DATABASE_BUSY', '本地数据库繁忙，请重试')
    harness.importRepository.commitError = failure

    let received: unknown
    try {
      await harness.service.commit({
        token: preview!.token,
        accountId: 'account-1',
        confirmOwnership: true
      })
    } catch (error) {
      received = error
    }
    expect(received).toBe(failure)
    expect(harness.jobRepository.statusHistory).toEqual(['validating', 'committing', 'failed'])
    expect((await harness.jobs.list())[0]).toMatchObject({
      status: 'failed',
      errorCode: 'DATABASE_BUSY',
      errorMessage: '本地数据库繁忙，请重试'
    })
    expect(harness.importRepository.runs).toEqual([
      expect.objectContaining({
        status: 'failed',
        errorCode: 'DATABASE_BUSY',
        errorMessage: '本地数据库繁忙，请重试'
      })
    ])
  })

  it('does not misreport a durable import when secondary run statistics fail', async () => {
    const harness = createHarness()
    const preview = await harness.service.preview('account-1')
    harness.importRepository.runRecordError = new Error('statistics unavailable')

    await expect(harness.service.commit({
      token: preview!.token,
      accountId: 'account-1',
      confirmOwnership: true
    })).resolves.toMatchObject({ job: { status: 'succeeded' }, newContentCount: 1 })
    expect((await harness.jobs.list())[0]?.status).toBe('succeeded')
  })

  it('rejects files over 10 MB before reading them', async () => {
    const harness = createHarness({ size: MAX_IMPORT_FILE_BYTES + 1 })
    await expect(harness.service.preview('account-1')).rejects.toMatchObject({
      code: 'IMPORT_FILE_TOO_LARGE'
    })
  })
})

describe('JobService', () => {
  it('lists jobs, emits changes and only cancels queued/validating jobs', async () => {
    const repository = new MemoryJobRepository()
    const jobs = new JobService(repository, {
      clock: () => new Date('2026-07-13T08:00:00.000Z'),
      createId: () => 'job-1'
    })
    const statuses: string[] = []
    const unsubscribe = jobs.onChanged((job) => statuses.push(job.status))
    const validating = await jobs.createValidating('account-1', 'generic-file-import')
    const cancelled = await jobs.cancel(validating.id)
    unsubscribe()

    expect(cancelled.status).toBe('cancelled')
    expect(statuses).toEqual(['validating', 'cancelled'])
    expect(await jobs.list()).toHaveLength(1)
    await expect(jobs.cancel(cancelled.id)).rejects.toMatchObject({ code: 'JOB_NOT_CANCELLABLE' })
  })
})
