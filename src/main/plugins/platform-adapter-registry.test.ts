import { describe, expect, it, vi } from 'vitest'
import type { Account } from '../../shared/contracts'
import type { PluginContributionState } from '../../shared/plugin-host-contracts'
import type { PlatformSyncService } from '../platform-sync-service'
import type { JobService } from '../services/job-service'
import { PlatformAdapterRegistryService } from './platform-adapter-registry'
import type { PluginHostService } from './plugin-host-service'
import type { PluginRuntimeExecutor } from './plugin-runtime-executor'

const now = '2026-07-14T08:00:00.000Z'

describe('PlatformAdapterRegistryService', () => {
  it('registers a manifest adapter and atomically switches only after stable identity verification', async () => {
    const account = createAccount()
    const setAccountAdapterContribution = vi.fn((accountId: string, contributionId: string) => ({
      ...account,
      id: accountId,
      adapterContributionId: contributionId
    }))
    const repository = repositoryFixture(account, setAccountAdapterContribution)
    const invoke = vi.fn(async () => ({ remoteId: 'stable-owner', remoteName: '本人账号' }))
    const registerAdapter = vi.fn(() => vi.fn())
    const service = registryFixture(repository, invoke, registerAdapter)

    service.reconcile()
    expect(registerAdapter).toHaveBeenCalledWith('example.adapter.v2', expect.any(Object))
    expect(service.listForAccount(account.id)).toEqual([expect.objectContaining({
      contributionId: 'example.adapter.v2',
      platformId: 'example-platform',
      selected: false,
      available: true
    })])

    await expect(service.switchAdapter(account.id, 'example.adapter.v2')).resolves.toMatchObject({
      adapterContributionId: 'example.adapter.v2'
    })
    expect(invoke).toHaveBeenCalledWith(
      'example.plugin',
      'example.adapter.v2',
      'readIdentity',
      account.id,
      { expectedRemoteId: 'stable-owner' },
      true
    )
    expect(setAccountAdapterContribution).toHaveBeenCalledWith(
      account.id,
      'example.adapter.v2',
      'builtin.adapter.v1'
    )
  })

  it('keeps the original binding when the candidate reports another identity', async () => {
    const account = createAccount()
    const setAccountAdapterContribution = vi.fn()
    const repository = repositoryFixture(account, setAccountAdapterContribution)
    const service = registryFixture(
      repository,
      vi.fn(async () => ({ remoteId: 'different-owner', remoteName: '其他账号' })),
      vi.fn(() => vi.fn())
    )
    service.reconcile()

    await expect(service.switchAdapter(account.id, 'example.adapter.v2'))
      .rejects.toThrow('账号身份与当前绑定身份不一致')
    expect(setAccountAdapterContribution).not.toHaveBeenCalled()
    expect(repository.getAccount(account.id)).toMatchObject({ adapterContributionId: 'builtin.adapter.v1' })
  })

  it('does not probe or switch while the account has an active synchronization', async () => {
    const account = createAccount()
    const invoke = vi.fn(async () => ({ remoteId: 'stable-owner', remoteName: '本人账号' }))
    const repository = repositoryFixture(account, vi.fn())
    const service = registryFixture(repository, invoke, vi.fn(() => vi.fn()), true)
    service.reconcile()

    await expect(service.switchAdapter(account.id, 'example.adapter.v2')).rejects.toThrow('正在同步')
    expect(invoke).not.toHaveBeenCalled()
  })

  it('does not switch while the account is waiting in the durable queue', async () => {
    const account = createAccount()
    const invoke = vi.fn(async () => ({ remoteId: 'stable-owner', remoteName: '本人账号' }))
    const repository = repositoryFixture(account, vi.fn())
    const service = registryFixture(repository, invoke, vi.fn(() => vi.fn()), false, true)
    service.reconcile()

    await expect(service.switchAdapter(account.id, 'example.adapter.v2')).rejects.toThrow('等待队列')
    expect(invoke).not.toHaveBeenCalled()
  })

  it('unregisters removed contributions during reconciliation', () => {
    const account = createAccount()
    let states: PluginContributionState[] = [adapterContribution()]
    const unregister = vi.fn()
    const host = { listContributions: () => states }
    const router = {
      registerAdapter: vi.fn(() => unregister),
      isAccountActive: vi.fn(() => false)
    }
    const service = new PlatformAdapterRegistryService(
      repositoryFixture(account, vi.fn()) as unknown as ConstructorParameters<typeof PlatformAdapterRegistryService>[0],
      host as unknown as PluginHostService,
      { invoke: vi.fn() } as unknown as PluginRuntimeExecutor,
      {} as JobService,
      router as unknown as PlatformSyncService
    )
    service.reconcile()
    states = []
    service.reconcile()

    expect(unregister).toHaveBeenCalledOnce()
  })
})

function registryFixture(
  repository: ReturnType<typeof repositoryFixture>,
  invoke: ReturnType<typeof vi.fn>,
  registerAdapter: ReturnType<typeof vi.fn>,
  active = false,
  pending = false
): PlatformAdapterRegistryService {
  return new PlatformAdapterRegistryService(
    repository as unknown as ConstructorParameters<typeof PlatformAdapterRegistryService>[0],
    { listContributions: () => [adapterContribution()] } as unknown as PluginHostService,
    { invoke } as unknown as PluginRuntimeExecutor,
    { hasPendingForAccount: vi.fn(async () => pending) } as unknown as JobService,
    {
      registerAdapter,
      isAccountActive: vi.fn(() => active)
    } as unknown as PlatformSyncService
  )
}

function repositoryFixture(
  account: Account,
  setAccountAdapterContribution: ReturnType<typeof vi.fn>
) {
  let current = structuredClone(account)
  setAccountAdapterContribution.mockImplementation((accountId: string, contributionId: string) => {
    current = { ...current, id: accountId, adapterContributionId: contributionId }
    return structuredClone(current)
  })
  return {
    getAccount: (id: string) => id === current.id ? structuredClone(current) : null,
    setAccountAdapterContribution,
    applyManagedIdentity: vi.fn(),
    markManagedIdentityMismatch: vi.fn(),
    markManagedSyncStarted: vi.fn(),
    markManagedSyncFailed: vi.fn(),
    commitManagedSync: vi.fn()
  }
}

function adapterContribution(): PluginContributionState {
  return {
    pluginId: 'example.plugin',
    pluginName: 'Example',
    pluginVersion: '1.0.0',
    enabled: true,
    granted: true,
    suspendedReason: '',
    contribution: {
      id: 'example.adapter.v2',
      kind: 'platform.adapter',
      name: 'Example adapter',
      description: 'Reads the example platform API',
      entry: 'entries/adapter.js',
      runtime: 'quickjs',
      permissions: ['platform.session-json'],
      platform: {
        id: 'example-platform',
        name: 'Example Platform',
        shortName: 'EX',
        loginUrl: 'https://example.com/login',
        homeUrl: 'https://example.com/',
        navigationHosts: ['example.com'],
        imageHosts: ['images.example.com'],
        contentUrls: [{
          remoteIdTemplate: '{id}',
          origin: 'https://example.com',
          pathTemplate: '/posts/{id}'
        }],
        riskNote: 'Use the official account API.'
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
    adapterContributionId: 'builtin.adapter.v1',
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
