import { describe, expect, it, vi } from 'vitest'
import type { Account } from '../../shared/contracts'
import type { JobBatchRecord, JobRecord, TaskQuery } from '../../shared/job-contracts'
import type { PluginRunRecord } from '../../shared/plugin-host-contracts'
import { TaskQueryService, type TaskQueryRepository } from './task-query-service'

describe('TaskQueryService', () => {
  it('projects jobs and plugin runs into a stable, paginated task list', async () => {
    const repository = createRepository({
      accounts: [
        account('account-xhs', 'xiaohongshu', '小红书主号'),
        account('account-zhihu', 'zhihu', '知乎主号')
      ],
      jobs: [
        job('job-z', {
          accountId: 'account-xhs',
          status: 'validating',
          progress: 20,
          createdAt: '2026-07-15T08:00:00.000Z'
        }),
        job('job-a', {
          accountId: 'account-zhihu',
          status: 'committing',
          createdAt: '2026-07-15T08:00:00.000Z'
        })
      ],
      pluginRuns: [
        pluginRun('run-schedule', {
          trigger: 'schedule',
          accountId: 'account-xhs',
          status: 'queued',
          createdAt: '2026-07-15T09:00:00.000Z',
          nextAttemptAt: '2026-07-15T09:05:00.000Z'
        }),
        pluginRun('run-event', {
          trigger: 'event',
          accountId: null,
          status: 'succeeded',
          createdAt: '2026-07-15T07:00:00.000Z'
        })
      ]
    })
    const service = new TaskQueryService(repository, { defaultLimit: 2 })

    const firstPage = await service.list()
    expect(firstPage).toMatchObject({ total: 4, offset: 0, limit: 2 })
    expect(firstPage.items.map(({ id }) => id)).toEqual(['run-schedule', 'job-a'])
    expect(firstPage.items[0]).toMatchObject({
      kind: 'plugin.schedule',
      trigger: 'scheduled',
      status: 'queued',
      accountAlias: '小红书主号',
      platformId: 'xiaohongshu',
      progress: null,
      stage: '等待运行',
      nextAttemptAt: '2026-07-15T09:05:00.000Z'
    })
    expect(firstPage.items[1]).toMatchObject({
      kind: 'account.sync',
      status: 'running',
      accountAlias: '知乎主号',
      platformId: 'zhihu'
    })

    const secondPage = await service.list({ offset: 2, limit: 10 })
    expect(secondPage.items.map(({ id }) => id)).toEqual(['job-z', 'run-event'])
    expect(secondPage.items[1]).toMatchObject({
      kind: 'plugin.event',
      trigger: 'event',
      accountId: null,
      accountAlias: '',
      platformId: null
    })
    expect(repository.listPluginRuns).toHaveBeenCalledWith(500)
  })

  it('supports every task filter, inclusive time bounds and visible-text search', async () => {
    const repository = createRepository({
      accounts: [
        account('account-xhs', 'xiaohongshu', '生活号'),
        account('account-zhihu', 'zhihu', '知识号')
      ],
      jobs: [
        job('job-manual', {
          batchId: 'batch-a',
          accountId: 'account-xhs',
          pluginId: 'builtin.xhs',
          contributionId: 'xhs.adapter',
          trigger: 'manual',
          status: 'succeeded',
          stage: '采集完成',
          createdAt: '2026-07-15T08:00:00.000Z'
        }),
        job('job-retry', {
          batchId: 'batch-b',
          accountId: 'account-zhihu',
          pluginId: 'builtin.zhihu',
          contributionId: 'zhihu.adapter',
          trigger: 'retry',
          status: 'failed',
          errorCode: 'LOGIN_REQUIRED',
          errorMessage: '请重新登录知乎',
          createdAt: '2026-07-15T10:00:00.000Z'
        })
      ],
      pluginRuns: [
        pluginRun('run-event', {
          accountId: 'account-xhs',
          pluginId: 'streamfold.webhook',
          contributionId: 'webhook.delivery',
          trigger: 'event',
          status: 'failed',
          errorMessage: '远端返回 500',
          createdAt: '2026-07-15T09:00:00.000Z'
        }),
        pluginRun('run-schedule', {
          accountId: null,
          pluginId: 'streamfold.webhook',
          contributionId: 'webhook.delivery',
          trigger: 'schedule',
          createdAt: '2026-07-16T09:00:00.000Z'
        })
      ]
    })
    const service = new TaskQueryService(repository)

    await expectIds(service, { batchId: 'batch-a' }, ['job-manual'])
    await expectIds(service, { kinds: ['plugin.event'] }, ['run-event'])
    await expectIds(service, { statuses: ['failed'] }, ['run-event'])
    await expectIds(service, { statuses: ['paused'] }, ['job-retry'])
    await expectIds(service, { triggers: ['retry'] }, ['job-retry'])
    await expectIds(service, { platformId: 'xiaohongshu' }, ['run-event', 'job-manual'])
    await expectIds(service, { accountId: 'account-zhihu' }, ['job-retry'])
    await expectIds(service, { pluginId: 'streamfold.webhook' }, ['run-schedule', 'run-event'])
    await expectIds(service, { contributionId: 'xhs.adapter' }, ['job-manual'])
    await expectIds(service, {
      createdFrom: '2026-07-15T08:00:00.000Z',
      createdTo: '2026-07-15T09:00:00.000Z'
    }, ['run-event', 'job-manual'])
    await expectIds(service, { search: '  知识号  ' }, ['job-retry'])
    await expectIds(service, { search: 'login_required' }, ['job-retry'])
    await expectIds(service, { search: '远端返回 500' }, ['run-event'])
    await expectIds(service, { search: 'WEBHOOK.DELIVERY' }, ['run-schedule', 'run-event'])
  })

  it('summarizes active, attention and local-day terminal task counts', async () => {
    const now = new Date(2026, 6, 15, 12, 0, 0)
    const at = (day: number, hour: number): string =>
      new Date(2026, 6, day, hour, 0, 0).toISOString()
    const repository = createRepository({
      jobs: [
        job('queued', { status: 'queued', createdAt: at(15, 8) }),
        job('running', { status: 'validating', createdAt: at(15, 9) }),
        job('success-today', {
          status: 'succeeded',
          createdAt: at(14, 9),
          finishedAt: at(15, 10)
        }),
        job('success-yesterday', {
          status: 'succeeded',
          createdAt: at(14, 8),
          finishedAt: at(14, 10)
        }),
        job('failed-today', {
          status: 'failed',
          createdAt: at(15, 9),
          finishedAt: at(15, 11)
        }),
        job('interrupted', {
          status: 'interrupted',
          createdAt: at(15, 7),
          finishedAt: at(15, 8)
        })
      ],
      pluginRuns: [
        pluginRun('plugin-failed', {
          status: 'failed',
          createdAt: at(15, 9),
          finishedAt: at(15, 10)
        })
      ]
    })
    const service = new TaskQueryService(repository, { clock: () => now })

    await expect(service.summary()).resolves.toEqual({
      queuedCount: 1,
      runningCount: 1,
      needsAttentionCount: 3,
      completedTodayCount: 1,
      failedTodayCount: 2,
      updatedAt: now.toISOString()
    })
    await expect(service.summary({ platformId: 'missing' })).resolves.toMatchObject({
      queuedCount: 0,
      runningCount: 0,
      needsAttentionCount: 0,
      completedTodayCount: 0,
      failedTodayCount: 0
    })
  })

  it('returns source records for cancel/retry routing and a renderer-safe single view', async () => {
    const storedJob = job('same-id', {
      accountId: 'account-xhs',
      result: { changed: 2 }
    })
    const repository = createRepository({
      accounts: [account('account-xhs', 'xiaohongshu', '主号')],
      jobs: [storedJob],
      pluginRuns: [pluginRun('same-id'), pluginRun('plugin-only')]
    })
    const service = new TaskQueryService(repository)

    await expect(service.get('same-id')).resolves.toMatchObject({
      id: 'same-id',
      kind: 'account.sync',
      accountAlias: '主号'
    })
    const source = await service.getSource('same-id')
    expect(source).toMatchObject({ source: 'job', record: { id: 'same-id' } })
    if (source?.source === 'job' && source.record.result) source.record.result.changed = 99
    expect(storedJob.result).toEqual({ changed: 2 })
    await expect(service.getSource('plugin-only')).resolves.toMatchObject({
      source: 'plugin-run',
      record: { id: 'plugin-only' }
    })
    await expect(service.get('missing')).resolves.toBeNull()
  })

  it('builds complete batch summaries and orders batches and their tasks stably', async () => {
    const repository = createRepository({
      batches: [
        batch('batch-old', '2026-07-14T08:00:00.000Z'),
        batch('batch-z', '2026-07-15T08:00:00.000Z'),
        batch('batch-a', '2026-07-15T08:00:00.000Z'),
        batch('batch-empty', '2026-07-13T08:00:00.000Z')
      ],
      jobs: [
        job('job-success', {
          batchId: 'batch-a',
          status: 'succeeded',
          createdAt: '2026-07-15T09:00:00.000Z'
        }),
        job('job-running', {
          batchId: 'batch-a',
          status: 'committing',
          createdAt: '2026-07-15T10:00:00.000Z'
        }),
        job('job-failed', { batchId: 'batch-a', status: 'failed' }),
        job('job-cancelled', { batchId: 'batch-a', status: 'cancelled' }),
        job('job-interrupted', { batchId: 'batch-a', status: 'interrupted' }),
        job('job-old', { batchId: 'batch-old', status: 'queued' }),
        job('job-orphan', { batchId: 'missing-batch', status: 'queued' })
      ],
      pluginRuns: [pluginRun('not-in-a-batch')]
    })
    const service = new TaskQueryService(repository)

    await expect(service.getBatch('batch-a')).resolves.toMatchObject({
      batch: { id: 'batch-a' },
      totalCount: 5,
      queuedCount: 0,
      runningCount: 1,
      succeededCount: 1,
      failedCount: 1,
      cancelledCount: 1,
      interruptedCount: 1,
      pausedCount: 0
    })
    const selected = await service.getBatch('batch-a')
    expect(selected?.tasks.map(({ id }) => id)).toEqual([
      'job-running',
      'job-success',
      'job-cancelled',
      'job-failed',
      'job-interrupted'
    ])
    await expect(service.getBatch('missing')).resolves.toBeNull()

    const batches = await service.listBatches()
    expect(batches.map(({ batch: { id } }) => id)).toEqual([
      'batch-a',
      'batch-z',
      'batch-old',
      'batch-empty'
    ])
    expect(batches.at(-1)).toMatchObject({ totalCount: 0, tasks: [] })
  })

  it('normalizes unsafe pagination values and enforces a configurable upper bound', async () => {
    const repository = createRepository({
      jobs: Array.from({ length: 8 }, (_, index) => job(`job-${index}`, {
        createdAt: new Date(Date.UTC(2026, 6, 15, index)).toISOString()
      }))
    })
    const service = new TaskQueryService(repository, { defaultLimit: 3, maxLimit: 4 })

    await expect(service.list({ offset: -2, limit: 999 })).resolves.toMatchObject({
      total: 8,
      offset: 0,
      limit: 4
    })
    await expect(service.list({ offset: 2.5, limit: 0 })).resolves.toMatchObject({
      total: 8,
      offset: 0,
      limit: 3
    })
  })
})

async function expectIds(
  service: TaskQueryService,
  query: TaskQuery,
  expected: string[]
): Promise<void> {
  const result = await service.list({ ...query, limit: 200 })
  expect(result.items.map(({ id }) => id)).toEqual(expected)
}

function createRepository(input: {
  jobs?: JobRecord[]
  batches?: JobBatchRecord[]
  pluginRuns?: PluginRunRecord[]
  accounts?: Account[]
} = {}) {
  const jobs = input.jobs ?? []
  const batches = input.batches ?? []
  const pluginRuns = input.pluginRuns ?? []
  const accounts = input.accounts ?? []
  return {
    listJobs: vi.fn(() => jobs),
    getJob: vi.fn((id: string) => jobs.find((value) => value.id === id) ?? null),
    listJobBatches: vi.fn(() => batches),
    getJobBatch: vi.fn((id: string) => batches.find((value) => value.id === id) ?? null),
    listPluginRuns: vi.fn((_limit?: number) => pluginRuns),
    getPluginRun: vi.fn((id: string) => pluginRuns.find((value) => value.id === id) ?? null),
    listAccounts: vi.fn(() => accounts)
  } satisfies TaskQueryRepository
}

function job(id: string, patch: Partial<JobRecord> = {}): JobRecord {
  return {
    id,
    batchId: null,
    kind: 'managed_sync',
    accountId: 'account-default',
    pluginId: 'builtin.platform',
    contributionId: 'builtin.platform.adapter',
    trigger: 'manual',
    status: 'queued',
    progress: 0,
    stage: '等待同步',
    attempt: 1,
    retryOfJobId: null,
    requestedSyncMode: 'recent_20',
    result: null,
    errorCode: '',
    errorMessage: '',
    createdAt: '2026-07-15T06:00:00.000Z',
    startedAt: null,
    finishedAt: null,
    ...patch
  }
}

function pluginRun(id: string, patch: Partial<PluginRunRecord> = {}): PluginRunRecord {
  return {
    id,
    pluginId: 'streamfold.webhook',
    contributionId: 'webhook.send',
    trigger: 'manual',
    status: 'queued',
    accountId: null,
    eventId: null,
    attempt: 1,
    startedAt: null,
    finishedAt: null,
    nextAttemptAt: null,
    errorCode: '',
    errorMessage: '',
    createdAt: '2026-07-15T06:00:00.000Z',
    ...patch
  }
}

function batch(id: string, createdAt: string): JobBatchRecord {
  return {
    id,
    trigger: 'manual',
    requestedScope: 'account_default',
    createdAt
  }
}

function account(id: string, platformId: string, alias: string): Account {
  return {
    id,
    platformId,
    alias
  } as Account
}
