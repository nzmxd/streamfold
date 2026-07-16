import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Account } from '../../shared/contracts'
import type { JobRecord, JobStatus } from '../../shared/job-contracts'
import type { PluginContributionState } from '../../shared/plugin-host-contracts'
import { registerManifestPlatforms } from '../platforms'
import type { JobService } from '../services/job-service'
import type { PluginHostService } from './plugin-host-service'
import type { PluginRuntimeExecutor } from './plugin-runtime-executor'
import { SandboxPlatformAdapter } from './sandbox-platform-adapter'

const now = '2026-07-14T08:00:00.000Z'

beforeEach(() => {
  registerManifestPlatforms([{
    id: 'example-platform',
    name: 'Example',
    shortName: 'EX',
    loginUrl: 'https://example.com/login',
    homeUrl: 'https://example.com/',
    officialHosts: ['example.com'],
    contentUrls: [{
      remoteIdTemplate: '{id}',
      origin: 'https://example.com',
      pathTemplate: '/posts/{id}'
    }],
    riskNote: 'Use official API.'
  }])
})

describe('SandboxPlatformAdapter synchronization orchestration', () => {
  it('passes the expected stable identity into probes and collection', async () => {
    const repository = repositoryFixture()
    repository.commitManagedSync.mockReturnValue({
      stats: { newContentCount: 1, updatedContentCount: 0, snapshotCount: 1, skippedSnapshotCount: 0 },
      job: { ...jobRecord(), status: 'succeeded', progress: 100, finishedAt: now }
    })
    const runtime = runtimeSequence([
      identity('stable-owner'),
      dataset('stable-owner'),
      identity('stable-owner')
    ])
    const adapter = createAdapter(repository, runtime, jobsFixture())

    await adapter.sync('account-1')

    expect(runtime.invoke).toHaveBeenNthCalledWith(
      1,
      'example.plugin',
      'example.adapter',
      'readIdentity',
      'account-1',
      { expectedRemoteId: 'stable-owner' }
    )
    expect(runtime.invoke).toHaveBeenNthCalledWith(
      2,
      'example.plugin',
      'example.adapter',
      'collect',
      'account-1',
      { scope: 'recent_20', boundRemoteId: 'stable-owner' }
    )
    expect(runtime.invoke).toHaveBeenNthCalledWith(
      3,
      'example.plugin',
      'example.adapter',
      'readIdentity',
      'account-1',
      { expectedRemoteId: 'stable-owner' }
    )
  })

  it('rechecks identity after collection and refuses to commit a changed login', async () => {
    const repository = repositoryFixture()
    const runtime = runtimeSequence([
      identity('stable-owner'),
      dataset('stable-owner'),
      identity('other-owner')
    ])
    const jobs = jobsFixture()
    const adapter = createAdapter(repository, runtime, jobs)

    await expect(adapter.sync('account-1')).rejects.toThrow('同步期间平台登录身份发生变化')

    expect(repository.commitManagedSync).not.toHaveBeenCalled()
    expect(repository.markManagedSyncFailed).toHaveBeenCalledWith(
      'account-1',
      '同步期间平台登录身份发生变化',
      now
    )
    expect(jobs.transition).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'validating' }),
      'failed',
      expect.objectContaining({ errorCode: 'PLUGIN_ADAPTER_FAILED' })
    )
  })

  it('marks the run failed and never publishes partial state when the atomic commit rolls back', async () => {
    const repository = repositoryFixture()
    repository.commitManagedSync.mockImplementation(() => { throw new Error('SQLite transaction rolled back') })
    const runtime = runtimeSequence([
      identity('stable-owner'),
      dataset('stable-owner'),
      identity('stable-owner')
    ])
    const jobs = jobsFixture()
    const adapter = createAdapter(repository, runtime, jobs)

    await expect(adapter.sync('account-1')).rejects.toThrow('SQLite transaction rolled back')

    expect(repository.commitManagedSync).toHaveBeenCalledOnce()
    expect(repository.markManagedSyncFailed).toHaveBeenCalledWith(
      'account-1',
      'SQLite transaction rolled back',
      now
    )
    expect(jobs.publishPersisted).not.toHaveBeenCalled()
    expect(jobs.transition).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ id: 'job-1', status: 'validating' }),
      'committing',
      expect.objectContaining({ progress: 85 })
    )
    expect(jobs.transition).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ id: 'job-1', status: 'committing' }),
      'failed',
      expect.objectContaining({
        errorCode: 'PLUGIN_ADAPTER_FAILED',
        errorMessage: 'SQLite transaction rolled back'
      })
    )
  })

  it('rejects a dataset whose profile belongs to another account before commit', async () => {
    const repository = repositoryFixture()
    const runtime = runtimeSequence([
      identity('stable-owner'),
      dataset('different-owner'),
      identity('stable-owner')
    ])
    const adapter = createAdapter(repository, runtime, jobsFixture())

    await expect(adapter.sync('account-1')).rejects.toThrow('插件数据集身份与已绑定账号不一致')
    expect(repository.commitManagedSync).not.toHaveBeenCalled()
  })

  it('caches a declared remote avatar and commits only the local cache reference', async () => {
    const repository = repositoryFixture()
    repository.commitManagedSync.mockReturnValue({
      stats: { newContentCount: 1, updatedContentCount: 0, snapshotCount: 1, skippedSnapshotCount: 0 },
      job: { ...jobRecord(), status: 'succeeded', progress: 100, finishedAt: now }
    })
    const runtime = runtimeSequence([
      identity('stable-owner'),
      dataset('stable-owner', 'https://example.com/avatar/owner.webp'),
      identity('stable-owner')
    ])
    const avatars = {
      cacheAvatar: vi.fn(async () => ({ cacheKey: `${'a'.repeat(64)}.webp`, mime: 'image/webp' }))
    }
    const adapter = createAdapter(repository, runtime, jobsFixture(), avatars)

    await expect(adapter.sync('account-1')).resolves.toMatchObject({
      profile: { avatarAvailable: true }
    })

    expect(avatars.cacheAvatar).toHaveBeenCalledWith(
      'account-1',
      'https://example.com/avatar/owner.webp'
    )
    const committed = repository.commitManagedSync.mock.calls[0]![0]
    expect(committed.profile).toMatchObject({
      avatarCacheKey: `${'a'.repeat(64)}.webp`,
      avatarMime: 'image/webp'
    })
    expect(committed.profile).not.toHaveProperty('avatarUrl')
  })

  it('accepts declared dynamic metrics while keeping decimal ratios intact', async () => {
    const repository = repositoryFixture()
    repository.commitManagedSync.mockReturnValue({
      stats: { newContentCount: 1, updatedContentCount: 0, snapshotCount: 1, skippedSnapshotCount: 0 },
      job: { ...jobRecord(), status: 'succeeded', progress: 100, finishedAt: now }
    })
    const payload = dataset('stable-owner')
    payload.contentMetricDefinitions = [{
      id: 'cover_click_rate', label: '封面点击率', valueKind: 'ratio', unit: 'ratio',
      group: 'reach', sortOrder: 1, measurementKind: 'gauge', standardMetricId: null
    }]
    const firstContent = (payload.contents as Array<Record<string, unknown>>)[0]!
    const firstSnapshot = (firstContent.snapshots as Array<Record<string, unknown>>)[0]!
    firstSnapshot.metrics = { cover_click_rate: 0.174 }
    const runtime = runtimeSequence([identity('stable-owner'), payload, identity('stable-owner')])
    const adapter = createAdapter(repository, runtime, jobsFixture())

    await adapter.sync('account-1')

    expect(repository.commitManagedSync).toHaveBeenCalledWith(
      expect.objectContaining({
        contentMetricDefinitions: [expect.objectContaining({
          id: 'cover_click_rate', measurementKind: 'gauge', standardMetricId: null
        })],
        contents: [expect.objectContaining({
          snapshots: [expect.objectContaining({ metrics: { cover_click_rate: 0.174 } })]
        })]
      }),
      expect.any(Object)
    )
  })

  it('accepts account period metrics with status, null values and negative deltas', async () => {
    const repository = repositoryFixture()
    repository.commitManagedSync.mockReturnValue({
      stats: { newContentCount: 1, updatedContentCount: 0, snapshotCount: 1, skippedSnapshotCount: 0 },
      job: { ...jobRecord(), status: 'succeeded', progress: 100, finishedAt: now }
    })
    const payload = dataset('stable-owner')
    payload.accountMetricDefinitions = [
      {
        id: 'positive_interaction_rate', label: '正向互动率', valueKind: 'ratio', unit: 'ratio',
        group: 'engagement', sortOrder: 1
      },
      {
        id: 'follower_conversion', label: '关注者转化', valueKind: 'count', unit: 'count',
        group: 'conversion', sortOrder: 2
      }
    ]
    payload.accountMetricSnapshots = [{
      period: 'daily',
      periodStart: '2026-07-13',
      periodEnd: '2026-07-13',
      status: 'insufficient_level',
      metrics: { positive_interaction_rate: null, follower_conversion: -1 },
      capturedAt: now
    }]
    const runtime = runtimeSequence([identity('stable-owner'), payload, identity('stable-owner')])
    const adapter = createAdapter(repository, runtime, jobsFixture())

    await adapter.sync('account-1')

    expect(repository.commitManagedSync).toHaveBeenCalledWith(
      expect.objectContaining({
        accountMetricDefinitions: [
          expect.objectContaining({ id: 'positive_interaction_rate' }),
          expect.objectContaining({ id: 'follower_conversion' })
        ],
        accountMetricSnapshots: [expect.objectContaining({
          period: 'daily',
          status: 'insufficient_level',
          metrics: { positive_interaction_rate: null, follower_conversion: -1 }
        })]
      }),
      expect.any(Object)
    )
  })

  it('rejects undeclared measurement semantics and standard mappings before commit', async () => {
    const repository = repositoryFixture()
    const invalidMeasurement = dataset('stable-owner')
    invalidMeasurement.contentMetricDefinitions = [{
      id: 'views', label: '浏览', valueKind: 'count', unit: 'count', group: 'reach',
      sortOrder: 1, measurementKind: 'counter', standardMetricId: 'views'
    }]
    const first = createAdapter(
      repository,
      runtimeSequence([identity('stable-owner'), invalidMeasurement]),
      jobsFixture()
    )
    await expect(first.sync('account-1')).rejects.toThrow('测量语义无效')

    const invalidMapping = dataset('stable-owner')
    invalidMapping.contentMetricDefinitions = [{
      id: 'views', label: '浏览', valueKind: 'count', unit: 'count', group: 'reach',
      sortOrder: 1, measurementKind: 'cumulative', standardMetricId: 'impressions'
    }]
    const second = createAdapter(
      repository,
      runtimeSequence([identity('stable-owner'), invalidMapping]),
      jobsFixture()
    )
    await expect(second.sync('account-1')).rejects.toThrow('标准内容指标无效')
    expect(repository.commitManagedSync).not.toHaveBeenCalled()
  })
})

function createAdapter(
  repository: ReturnType<typeof repositoryFixture>,
  runtime: ReturnType<typeof runtimeSequence>,
  jobs: ReturnType<typeof jobsFixture>,
  avatars?: { cacheAvatar(accountId: string, sourceUrl: string): Promise<{ cacheKey: string; mime: string } | null> }
): SandboxPlatformAdapter {
  return new SandboxPlatformAdapter(
    'example.plugin',
    'example.adapter',
    'example-platform',
    repository,
    { listContributions: () => [adapterState()] } as unknown as PluginHostService,
    { invoke: runtime.invoke } as unknown as PluginRuntimeExecutor,
    jobs as unknown as JobService,
    () => new Date(now),
    avatars
  )
}

function repositoryFixture() {
  const account = createAccount()
  return {
    getAccount: vi.fn((id: string) => id === account.id ? structuredClone(account) : null),
    applyManagedIdentity: vi.fn(),
    markManagedIdentityMismatch: vi.fn(),
    markManagedSyncStarted: vi.fn(() => structuredClone(account)),
    markManagedSyncFailed: vi.fn(() => structuredClone(account)),
    applyManagedProbeStatus: vi.fn(() => structuredClone(account)),
    commitManagedSync: vi.fn()
  }
}

function runtimeSequence(values: Record<string, unknown>[]) {
  const queue = [...values]
  return {
    invoke: vi.fn(async () => {
      const value = queue.shift()
      if (!value) throw new Error('unexpected runtime invocation')
      return structuredClone(value)
    })
  }
}

function jobsFixture() {
  const transition = vi.fn(async (job: JobRecord, status: JobStatus, patch: Partial<JobRecord>) => ({
    ...job,
    ...patch,
    status
  }))
  return {
    createManagedSync: vi.fn(async () => jobRecord()),
    requestedSyncMode: vi.fn((fallback: 'profile_only' | 'recent_20' | 'recent_100') => fallback),
    transition,
    publishPersisted: vi.fn((job: JobRecord) => job)
  }
}

function identity(remoteId: string): Record<string, unknown> {
  return {
    remoteId,
    remoteName: remoteId === 'stable-owner' ? '本人账号' : '其他账号',
    profile: {
      followers: 12,
      following: 3,
      contentCount: 1,
      viewsTotal: 100
    }
  }
}

function dataset(remoteId: string, avatarUrl = ''): Record<string, unknown> {
  return {
    capturedAt: now,
    profile: {
      remoteId,
      remoteName: '本人账号',
      avatarUrl,
      followers: 12,
      following: 3,
      contentCount: 1,
      viewsTotal: 100
    },
    contents: [{
      remoteId: 'post-1',
      type: 'article',
      title: '测试文章',
      bodyExcerpt: '摘要',
      url: 'https://example.com/posts/post-1',
      publishedAt: '2026-07-13T08:00:00.000Z',
      snapshots: [{
        views: 100,
        likes: 8,
        comments: 2,
        shares: 1,
        favorites: 3,
        capturedAt: now
      }]
    }],
    warnings: []
  }
}

function adapterState(): PluginContributionState {
  return {
    pluginId: 'example.plugin',
    pluginName: 'Example',
    pluginVersion: '1.0.0',
    enabled: true,
    granted: true,
    suspendedReason: '',
    contribution: {
      id: 'example.adapter',
      kind: 'platform.adapter',
      name: 'Example adapter',
      description: 'Reads API data',
      entry: 'entries/adapter.js',
      runtime: 'quickjs',
      permissions: ['platform.session-json'],
      platform: {
        id: 'example-platform',
        name: 'Example',
        shortName: 'EX',
        loginUrl: 'https://example.com/login',
        homeUrl: 'https://example.com/',
        navigationHosts: ['example.com'],
        imageHosts: ['example.com'],
        contentUrls: [{
          remoteIdTemplate: '{id}',
          origin: 'https://example.com',
          pathTemplate: '/posts/{id}'
        }],
        riskNote: 'Use official API.'
      },
      endpoints: [],
      captures: [],
      minimumIntervalSeconds: 60,
      recommendedSyncIntervalHours: 24
    }
  }
}

function createAccount(): Account {
  return {
    id: 'account-1',
    platformId: 'example-platform',
    adapterContributionId: 'example.adapter',
    alias: '本人账号',
    aliasCustomized: false,
    remoteName: '本人账号',
    remoteId: 'stable-owner',
    avatarUrl: '',
    bio: '',
    creatorLevel: null,
    latestSnapshot: null,
    status: 'ready',
    connectionStatus: 'ready',
    ownershipStatus: 'plugin_verified',
    syncEnabled: true,
    syncStatus: 'idle',
    cooldownUntil: null,
    lastSyncError: '',
    ownershipConfirmedAt: now,
    identityVerifiedAt: now,
    note: '',
    tags: [],
    groupIds: [],
    sessionPartition: 'persist:social:account-1',
    syncMode: 'recent_20',
    isDefault: false,
    createdAt: now,
    updatedAt: now,
    lastSyncedAt: null
  }
}

function jobRecord(): JobRecord {
  return {
    id: 'job-1',
    batchId: null,
    kind: 'managed_sync',
    accountId: 'account-1',
    pluginId: 'example.plugin',
    contributionId: 'example.platform',
    trigger: 'manual',
    status: 'validating',
    progress: 20,
    stage: '读取平台数据',
    attempt: 1,
    retryOfJobId: null,
    requestedSyncMode: 'profile_only',
    result: null,
    errorCode: '',
    errorMessage: '',
    createdAt: now,
    startedAt: now,
    finishedAt: null
  }
}
