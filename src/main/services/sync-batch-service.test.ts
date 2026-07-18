import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Account, SyncMode } from '../../shared/contracts'
import type {
  SessionApiIdentityCheckResult,
  SessionApiSyncResult
} from '../../shared/session-api-contracts'
import { SocialDatabase } from '../database'
import {
  PlatformSyncService,
  type SessionApiPlatformService
} from '../platform-sync-service'
import { JobService } from './job-service'
import { AccountExecutionCoordinator } from './account-execution-coordinator'
import { SyncBatchService } from './sync-batch-service'

describe('SyncBatchService', () => {
  let database: SocialDatabase
  let jobs: JobService
  let service: SyncBatchService | null

  beforeEach(() => {
    database = new SocialDatabase(':memory:')
    jobs = new JobService(database)
    service = null
  })

  afterEach(() => {
    service?.stop()
    database.close()
  })

  it('previews account and group selections without starting an ineligible account', async () => {
    const group = database.createGroup({ name: '重点账号', color: '#339cff' })
    const ready = managedAccount(database, 'xiaohongshu', 'recent_20', 'ready')
    const pending = database.createAccount({ platformId: 'zhihu', syncMode: 'profile_only' })
    database.updateAccount({ id: ready.id, groupIds: [group.id] })
    database.updateAccount({ id: pending.id, groupIds: [group.id] })
    service = createService(database, jobs)

    const preview = await service.preview({ groupIds: [group.id] })

    expect(preview.eligibleAccountIds).toEqual([ready.id])
    expect(preview.skippedAccountIds).toEqual([pending.id])
    expect(preview.accounts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        accountId: ready.id,
        status: 'ready',
        requestedSyncMode: 'recent_20'
      }),
      expect.objectContaining({ accountId: pending.id, status: 'login_required' })
    ]))
  })

  it('accepts a narrower temporary range but rejects a wider range than the account authorization', async () => {
    const account = managedAccount(database, 'xiaohongshu', 'recent_20', 'scope')
    service = createService(database, jobs)

    await expect(service.preview({
      accountIds: [account.id],
      requestedScope: 'profile_only'
    })).resolves.toMatchObject({
      eligibleAccountIds: [account.id],
      accounts: [expect.objectContaining({ requestedSyncMode: 'profile_only', status: 'ready' })]
    })
    await expect(service.preview({
      accountIds: [account.id],
      requestedScope: 'recent_100'
    })).resolves.toMatchObject({
      eligibleAccountIds: [],
      accounts: [expect.objectContaining({ status: 'scope_not_authorized' })]
    })
  })

  it('persists a batch atomically and safely cancels only its queued job', async () => {
    const account = managedAccount(database, 'xiaohongshu', 'profile_only', 'cancel')
    service = createService(database, jobs)

    const result = await service.enqueue({ accountIds: [account.id] })
    const queued = result.jobs[0]!

    expect(queued).toMatchObject({
      batchId: result.batch.id,
      status: 'queued',
      trigger: 'manual',
      requestedSyncMode: 'profile_only'
    })
    expect(database.getAccount(account.id)?.syncStatus).toBe('queued')
    await expect(service.cancel(queued.id)).resolves.toMatchObject({ status: 'cancelled' })
    expect(database.getAccount(account.id)?.syncStatus).toBe('idle')
  })

  it('serializes concurrent enqueue requests so an account gets only one active job', async () => {
    const account = managedAccount(database, 'xiaohongshu', 'profile_only', 'dedupe')
    service = createService(database, jobs)

    const results = await Promise.allSettled([
      service.enqueue({ accountIds: [account.id] }),
      service.enqueue({ accountIds: [account.id] })
    ])

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    expect(database.listJobs().filter((job) => job.accountId === account.id && job.status === 'queued'))
      .toHaveLength(1)
  })

  it('runs one job per adapter while allowing different adapters to progress in parallel', async () => {
    const first = managedAccount(database, 'xiaohongshu', 'profile_only', 'xhs-a')
    const second = managedAccount(database, 'xiaohongshu', 'profile_only', 'xhs-b')
    const third = managedAccount(database, 'zhihu', 'profile_only', 'zhihu-a')
    const activity = { current: 0, maximum: 0, byAdapter: new Map<string, number>() }
    service = createService(database, jobs, activity)
    service.start()

    const result = await service.enqueue({ accountIds: [first.id, second.id, third.id] })
    await waitFor(() => result.jobs.every((job) => database.getJob(job.id)?.status === 'succeeded'))

    expect(activity.maximum).toBeGreaterThanOrEqual(2)
    expect(activity.byAdapter.get('xiaohongshu-session-api.platform')).toBe(1)
    expect(activity.byAdapter.get('zhihu-session-api.platform')).toBe(1)
  })

  it('keeps a queued job pending while another account operation briefly owns its lock', async () => {
    const account = managedAccount(database, 'xiaohongshu', 'profile_only', 'deferred')
    const coordinator = new AccountExecutionCoordinator()
    service = createService(
      database,
      jobs,
      { current: 0, maximum: 0, byAdapter: new Map<string, number>() },
      coordinator
    )
    let release!: () => void
    const identityCheck = coordinator.run(account.id, async () => {
      await new Promise<void>((resolve) => { release = resolve })
    })
    service.start()

    const result = await service.enqueue({ accountIds: [account.id] })
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(database.getJob(result.jobs[0]!.id)?.status).toBe('queued')
    release()
    await identityCheck
    await waitFor(() => database.getJob(result.jobs[0]!.id)?.status === 'succeeded')
  })

  it('creates a new retry attempt without overwriting the failed record', async () => {
    const account = managedAccount(database, 'zhihu', 'profile_only', 'retry')
    service = createService(database, jobs)
    const original = database.createJob({
      kind: 'managed_sync',
      accountId: account.id,
      pluginId: 'zhihu-session-api',
      contributionId: 'zhihu-session-api.platform',
      status: 'failed',
      attempt: 2,
      requestedSyncMode: 'profile_only',
      errorCode: 'API_SYNC_FAILED',
      errorMessage: '暂时失败'
    })

    const retried = await service.retry(original.id)

    expect(retried.jobs[0]).toMatchObject({
      status: 'queued',
      trigger: 'retry',
      attempt: 3,
      retryOfJobId: original.id
    })
    expect(database.getJob(original.id)).toMatchObject({ status: 'failed', attempt: 2 })
  })
})

function createService(
  database: SocialDatabase,
  jobs: JobService,
  activity = { current: 0, maximum: 0, byAdapter: new Map<string, number>() },
  coordinator?: AccountExecutionCoordinator
): SyncBatchService {
  const xiaohongshu = adapter('xiaohongshu-session-api', 'xiaohongshu-session-api.platform', jobs, activity)
  const zhihu = adapter('zhihu-session-api', 'zhihu-session-api.platform', jobs, activity)
  const router = new PlatformSyncService({
    repository: database,
    coordinator,
    adapters: {
      'xiaohongshu-session-api.platform': xiaohongshu,
      'zhihu-session-api.platform': zhihu
    }
  })
  return new SyncBatchService(database, router, jobs)
}

function adapter(
  pluginId: string,
  contributionId: string,
  jobs: JobService,
  activity: { current: number; maximum: number; byAdapter: Map<string, number> }
): SessionApiPlatformService {
  let active = 0
  return {
    pluginId,
    contributionId,
    verifyIdentity: vi.fn(async (accountId) => identity(accountId)),
    confirmIdentity: vi.fn(async (input) => identity(input.accountId)),
    sync: vi.fn(async (accountId) => {
      active += 1
      activity.current += 1
      activity.maximum = Math.max(activity.maximum, activity.current)
      activity.byAdapter.set(contributionId, Math.max(activity.byAdapter.get(contributionId) ?? 0, active))
      try {
        let job = await jobs.createManagedSync(accountId, pluginId, contributionId)
        await new Promise((resolve) => setTimeout(resolve, 15))
        job = await jobs.transition(job, 'committing', { progress: 85, stage: '保存同步数据' })
        job = await jobs.transition(job, 'succeeded', {
          progress: 100,
          stage: '只读同步完成',
          finishedAt: new Date().toISOString()
        })
        return syncResult(accountId, job)
      } finally {
        active -= 1
        activity.current -= 1
      }
    }),
    isAccountActive: vi.fn(() => active > 0),
    invalidatePreviews: vi.fn()
  }
}

function managedAccount(
  database: SocialDatabase,
  platformId: string,
  syncMode: Exclude<SyncMode, 'disabled'>,
  suffix: string
): Account {
  const created = database.createAccount({ platformId, syncMode })
  database.applyManagedIdentity(created.id, {
    remoteId: `remote-${suffix}`,
    remoteName: `账号 ${suffix}`
  }, '2026-07-15T00:00:00.000Z')
  return database.updateAccount({ id: created.id, syncEnabled: true })
}

function identity(accountId: string): SessionApiIdentityCheckResult {
  return {
    accountId,
    status: 'verified',
    remoteId: `remote-${accountId}`,
    remoteName: '本人账号',
    confirmationToken: null,
    confirmationExpiresAt: null,
    verifiedAt: '2026-07-15T00:00:00.000Z',
    message: '当前账号已核验。'
  }
}

function syncResult(accountId: string, job: SessionApiSyncResult['job']): SessionApiSyncResult {
  return {
    accountId,
    mode: 'profile_only',
    capturedAt: '2026-07-15T00:00:00.000Z',
    profile: {
      remoteId: `remote-${accountId}`,
      remoteName: '本人账号',
      avatarAvailable: false,
      followers: null,
      following: null,
      bio: ''
    },
    coverage: {
      requestedContentCount: 0,
      actualContentCount: 0,
      paginationEnded: true
    },
    contentCount: 0,
    stats: {
      newContentCount: 0,
      updatedContentCount: 0,
      snapshotCount: 0,
      skippedSnapshotCount: 0
    },
    job,
    message: '同步完成'
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('等待任务完成超时')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
