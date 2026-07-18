import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Account } from '../../shared/contracts'
import type { JobRecord, JobStatus } from '../../shared/job-contracts'
import type { PluginContributionState } from '../../shared/plugin-host-contracts'
import { registerManifestPlatforms } from '../platforms'
import type { JobService } from '../services/job-service'
import type { PluginHostService } from './plugin-host-service'
import type { PluginRuntimeExecutor } from './plugin-runtime-executor'
import { SandboxPlatformAdapter } from './sandbox-platform-adapter'
import { PluginSupplyChainError } from './supply-chain-errors'

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
  it('maps opaque sandbox identity failures to a fixed actionable message', async () => {
    const repository = repositoryFixture()
    const runtime = {
      invoke: vi.fn(async () => {
        throw new PluginSupplyChainError('PLUGIN_SANDBOX_FAILED', '插件执行失败')
      })
    }
    const adapter = createAdapter(repository, runtime, jobsFixture())

    await expect(adapter.verifyIdentity('account-1')).rejects.toMatchObject({
      code: 'PLUGIN_ADAPTER_IDENTITY_FAILED',
      message: '平台身份核验未完成，请确认已经登录并等待页面加载完成；若持续失败，请停止重试并更新归页。'
    })
  })

  it('maps only official X identity stage envelopes to fixed host-owned errors', async () => {
    const cases = [
      ['X_IDENTITY_SETTINGS_EMPTY', 'PLUGIN_ADAPTER_IDENTITY_SETTINGS_EMPTY', '未捕获到 X 当前登录账号设置'],
      ['X_IDENTITY_CURRENT_PROFILE_EMPTY', 'PLUGIN_ADAPTER_IDENTITY_PROFILE_EMPTY', '未捕获到当前账号资料'],
      ['X_IDENTITY_RESPONSE_INVALID', 'PLUGIN_ADAPTER_IDENTITY_RESPONSE_INVALID', '身份资料结构暂不受支持'],
      ['X_IDENTITY_STABLE_ID_VERIFY_FAILED', 'PLUGIN_ADAPTER_IDENTITY_STABLE_ID_FAILED', '稳定账号 ID 复核失败']
    ] as const

    for (const [guestCode, hostCode, message] of cases) {
      const repository = repositoryFixture()
      const adapter = createAdapter(
        repository,
        runtimeSequence([{ __streamfoldFailure: guestCode }]),
        jobsFixture(),
        undefined,
        60,
        { pluginId: 'streamfold.x', contributionId: 'streamfold.x.platform' }
      )

      await expect(adapter.verifyIdentity('account-1')).rejects.toMatchObject({
        code: hostCode,
        message: expect.stringContaining(message)
      })
      expect(repository.applyManagedIdentity).not.toHaveBeenCalled()
    }
  })

  it('treats empty official X background stages as pending without weakening explicit verification', async () => {
    const runtime = runtimeSequence([{ __streamfoldFailure: 'X_IDENTITY_SETTINGS_EMPTY' }])
    const adapter = createAdapter(
      repositoryFixture(),
      runtime,
      jobsFixture(),
      undefined,
      60,
      { pluginId: 'streamfold.x', contributionId: 'streamfold.x.platform' }
    )

    await expect(adapter.discoverIdentity('account-1')).resolves.toMatchObject({
      status: 'capture_pending',
      confirmationToken: null,
      message: '正在后台监听 X 登录账号设置。'
    })
    expect(runtime.invoke).toHaveBeenCalledWith(
      'streamfold.x',
      'streamfold.x.platform',
      'readIdentity',
      'account-1',
      { expectedRemoteId: null },
      false,
      'background-cache'
    )
  })

  it('rejects malformed or unknown official X envelopes without leaking guest text', async () => {
    const guestText = 'sensitive guest or upstream response body'
    const values = [
      { __streamfoldFailure: 'X_IDENTITY_SETTINGS_EMPTY', raw: guestText },
      { __streamfoldFailure: guestText }
    ]

    for (const value of values) {
      const adapter = createAdapter(
        repositoryFixture(),
        runtimeSequence([value]),
        jobsFixture(),
        undefined,
        60,
        { pluginId: 'streamfold.x', contributionId: 'streamfold.x.platform' }
      )
      let failure: unknown
      try {
        await adapter.verifyIdentity('account-1')
      } catch (error) {
        failure = error
      }
      expect(failure).toMatchObject({ code: 'PLUGIN_ADAPTER_IDENTITY_FAILED' })
      expect(failure).toBeInstanceOf(Error)
      expect((failure as Error).message).not.toContain(guestText)
    }
  })

  it('uses the same official X stage mapping for unbound adapter probes', async () => {
    const runtime = runtimeSequence([{ __streamfoldFailure: 'X_IDENTITY_CURRENT_PROFILE_EMPTY' }])
    const adapter = createAdapter(
      repositoryFixture(),
      runtime,
      jobsFixture(),
      undefined,
      60,
      { pluginId: 'streamfold.x', contributionId: 'streamfold.x.platform' }
    )

    await expect(adapter.probeIdentity('account-1')).rejects.toMatchObject({
      code: 'PLUGIN_ADAPTER_IDENTITY_PROFILE_EMPTY'
    })
    expect(runtime.invoke).toHaveBeenCalledWith(
      'streamfold.x',
      'streamfold.x.platform',
      'readIdentity',
      'account-1',
      { expectedRemoteId: null },
      true
    )
  })

  it('does not trust an X stage envelope outside the exact official contribution pair', async () => {
    const identities = [
      { pluginId: 'example.plugin', contributionId: 'example.adapter' },
      { pluginId: 'streamfold.x', contributionId: 'example.adapter' },
      { pluginId: 'example.plugin', contributionId: 'streamfold.x.platform' }
    ]
    for (const identity of identities) {
      const adapter = createAdapter(
        repositoryFixture(),
        runtimeSequence([{ __streamfoldFailure: 'X_IDENTITY_SETTINGS_EMPTY' }]),
        jobsFixture(),
        undefined,
        60,
        identity
      )
      let failure: unknown
      try {
        await adapter.verifyIdentity('account-1')
      } catch (error) {
        failure = error
      }

      expect(failure).toBeInstanceOf(Error)
      expect(failure).not.toMatchObject({ code: 'PLUGIN_ADAPTER_IDENTITY_SETTINGS_EMPTY' })
    }
  })

  it('marks a bound account mismatch from the adapter observed login identity', async () => {
    const repository = repositoryFixture()
    repository.applyManagedIdentity.mockReturnValue({
      ...createAccount(),
      status: 'paused',
      connectionStatus: 'mismatch',
      syncEnabled: false
    })
    const adapter = createAdapter(repository, runtimeSequence([identity('other-owner')]), jobsFixture())

    await expect(adapter.verifyIdentity('account-1')).resolves.toMatchObject({
      status: 'identity_mismatch',
      remoteId: 'other-owner',
      message: '当前账号与已绑定账号不一致，已停止同步。'
    })
    expect(repository.applyManagedIdentity).toHaveBeenCalledWith(
      'account-1',
      expect.objectContaining({ remoteId: 'other-owner' }),
      now
    )
  })

  it('passes the expected stable identity into probes and collection', async () => {
    const repository = repositoryFixture()
    repository.commitManagedSync.mockReturnValue(managedSyncCommitResult())
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

  it('persists a trusted identity failure code when synchronization stops before collection', async () => {
    const repository = repositoryFixture()
    const jobs = jobsFixture()
    const runtime = runtimeSequence([{ __streamfoldFailure: 'X_IDENTITY_STABLE_ID_VERIFY_FAILED' }])
    const adapter = createAdapter(
      repository,
      runtime,
      jobs,
      undefined,
      60,
      { pluginId: 'streamfold.x', contributionId: 'streamfold.x.platform' }
    )

    await expect(adapter.sync('account-1')).rejects.toMatchObject({
      code: 'PLUGIN_ADAPTER_IDENTITY_STABLE_ID_FAILED'
    })
    expect(runtime.invoke).toHaveBeenCalledOnce()
    expect(repository.commitManagedSync).not.toHaveBeenCalled()
    expect(repository.markManagedIdentityMismatch).not.toHaveBeenCalled()
    expect(jobs.transition).toHaveBeenLastCalledWith(
      expect.anything(),
      'failed',
      expect.objectContaining({ errorCode: 'PLUGIN_ADAPTER_IDENTITY_STABLE_ID_FAILED' })
    )
  })

  it('does not trust a generic error with a forged synchronization code', async () => {
    const repository = repositoryFixture()
    const jobs = jobsFixture()
    const forged = Object.assign(new Error('fake failure'), {
      code: 'PLUGIN_ADAPTER_IDENTITY_STABLE_ID_FAILED'
    })
    const runtime = { invoke: vi.fn(async () => { throw forged }) }
    const adapter = createAdapter(repository, runtime, jobs)

    await expect(adapter.sync('account-1')).rejects.toBe(forged)
    expect(jobs.transition).toHaveBeenLastCalledWith(
      expect.anything(),
      'failed',
      expect.objectContaining({ errorCode: 'PLUGIN_ADAPTER_FAILED' })
    )
  })

  it('enforces the configured platform collection interval before invoking the plugin', async () => {
    const repository = repositoryFixture()
    const account = createAccount()
    account.lastSyncedAt = new Date(Date.parse(now) - 5 * 60_000).toISOString()
    repository.getAccount.mockImplementation((id: string) => id === account.id ? structuredClone(account) : null)
    const runtime = runtimeSequence([])
    const adapter = createAdapter(repository, runtime, jobsFixture(), undefined, 10 * 60)

    await expect(adapter.sync(account.id)).rejects.toThrow('请在 300 秒后重试')
    expect(runtime.invoke).not.toHaveBeenCalled()
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

  it('returns plugin warnings to the foreground sync result', async () => {
    const repository = repositoryFixture()
    repository.commitManagedSync.mockReturnValue(managedSyncCommitResult([
      '平台本次只返回可见内容。'
    ]))
    const payload = dataset('stable-owner')
    payload.warnings = ['平台本次只返回可见内容。']
    const adapter = createAdapter(repository, runtimeSequence([
      identity('stable-owner'),
      payload,
      identity('stable-owner')
    ]), jobsFixture())

    await expect(adapter.sync('account-1')).resolves.toMatchObject({
      warnings: ['平台本次只返回可见内容。'],
      message: '已同步账号资料和 1 条内容。 有 1 项提示：平台本次只返回可见内容。'
    })
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
    repository.commitManagedSync.mockReturnValue(managedSyncCommitResult())
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
    repository.commitManagedSync.mockReturnValue(managedSyncCommitResult())
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
    repository.commitManagedSync.mockReturnValue(managedSyncCommitResult())
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
  runtime: { invoke: ReturnType<typeof vi.fn> },
  jobs: ReturnType<typeof jobsFixture>,
  avatars?: { cacheAvatar(accountId: string, sourceUrl: string): Promise<{ cacheKey: string; mime: string } | null> },
  collectionIntervalSeconds = 60,
  identity: { pluginId: string; contributionId: string } = {
    pluginId: 'example.plugin',
    contributionId: 'example.adapter'
  }
): SandboxPlatformAdapter {
  const state = adapterState()
  state.pluginId = identity.pluginId
  state.contribution.id = identity.contributionId
  if (identity.contributionId !== 'example.adapter') {
    const account = repository.getAccount('account-1')
    repository.getAccount.mockImplementation((id: string) => (
      account && id === account.id ? { ...account, adapterContributionId: identity.contributionId } : null
    ))
  }
  return new SandboxPlatformAdapter(
    identity.pluginId,
    identity.contributionId,
    'example-platform',
    repository,
    {
      listContributions: () => [state],
      platformCollectionIntervalSeconds: () => collectionIntervalSeconds
    } as unknown as PluginHostService,
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
    coverage: {
      requestedContentCount: 20,
      actualContentCount: 1,
      paginationEnded: true
    },
    warnings: []
  }
}

function managedSyncCommitResult(warnings: string[] = []) {
  return {
    stats: { newContentCount: 1, updatedContentCount: 0, snapshotCount: 1, skippedSnapshotCount: 0 },
    coverage: { requestedContentCount: 20, actualContentCount: 1, paginationEnded: true },
    warnings,
    job: {
      ...jobRecord(),
      status: warnings.length > 0 ? 'succeeded_with_warnings' : 'succeeded',
      progress: 100,
      finishedAt: now
    }
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
