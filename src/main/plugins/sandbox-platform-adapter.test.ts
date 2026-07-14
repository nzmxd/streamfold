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
    kind: 'managed_sync',
    accountId: 'account-1',
    pluginId: 'example.plugin',
    status: 'validating',
    progress: 20,
    stage: '读取平台数据',
    result: null,
    errorCode: '',
    errorMessage: '',
    createdAt: now,
    startedAt: now,
    finishedAt: null
  }
}
