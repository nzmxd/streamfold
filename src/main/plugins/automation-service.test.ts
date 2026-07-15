import { describe, expect, it, vi } from 'vitest'
import type { Account } from '../../shared/contracts'
import type {
  PluginContributionState,
  PluginEventDelivery,
  PluginEventEnvelope,
  PluginGrant,
  PluginRunRecord,
  PluginSchedule
} from '../../shared/plugin-host-contracts'
import { AccountExecutionCoordinator } from '../services/account-execution-coordinator'
import {
  PluginAutomationService,
  RetryablePluginError,
  type PluginExecutionRequest,
  type PluginExecutor
} from './automation-service'

const initialTime = '2026-07-14T08:00:00.000Z'

describe('PluginAutomationService', () => {
  it('materializes an authorized event once and filters its fields before delivery', async () => {
    const account = createAccount('account-1', ['team-a'])
    const grant = createGrant({ dataScopes: ['content'], groupIds: ['team-a'] })
    const event = createEvent(account.id)
    const repository = new FakeAutomationRepository([account], grant)
    repository.events.push(event)
    const execute = vi.fn(async (_request: PluginExecutionRequest) => null)
    const service = createService(repository, eventContribution(), { execute })

    await service.tick()
    await service.tick()

    expect(repository.deliveries).toHaveLength(1)
    expect(repository.deliveries[0]).toMatchObject({ status: 'succeeded', attempt: 1 })
    expect(execute).toHaveBeenCalledOnce()
    const delivered = execute.mock.calls[0]![0].event!
    expect(delivered.data).toEqual({
      contents: [{ title: '保留标题' }]
    })
    expect(event.data).toMatchObject({
      alias: '本地别名',
      profile: { followers: 18 },
      contents: [{ snapshots: [{ likes: 3 }] }]
    })
  })

  it('honors Retry-After for retryable delivery failures and permanently fails ordinary errors', async () => {
    const account = createAccount('account-1')
    const grant = createGrant({ accountIds: [account.id], dataScopes: ['account', 'profile', 'content', 'metrics'] })
    const retryRepository = new FakeAutomationRepository([account], grant)
    retryRepository.events.push(createEvent(account.id))
    const retryExecutor: PluginExecutor = {
      execute: vi.fn(async () => {
        throw new RetryablePluginError('WEBHOOK_RETRYABLE_HTTP', 'Webhook 返回 HTTP 429', 120_000)
      })
    }
    await createService(retryRepository, eventContribution(), retryExecutor).tick()

    expect(retryRepository.deliveries[0]).toMatchObject({
      status: 'retry',
      attempt: 1,
      nextAttemptAt: '2026-07-14T08:02:00.000Z',
      errorCode: 'WEBHOOK_RETRYABLE_HTTP'
    })

    const permanentRepository = new FakeAutomationRepository([account], grant)
    permanentRepository.events.push(createEvent(account.id))
    const permanentExecutor: PluginExecutor = {
      execute: vi.fn(async () => { throw new Error('Webhook 返回 HTTP 400') })
    }
    await createService(permanentRepository, eventContribution(), permanentExecutor).tick()

    expect(permanentRepository.deliveries[0]).toMatchObject({
      status: 'failed',
      attempt: 1,
      nextAttemptAt: null,
      errorCode: 'PLUGIN_EXECUTION_FAILED',
      errorMessage: 'Webhook 返回 HTTP 400'
    })
  })

  it('coalesces missed schedule intervals and opens the circuit after three consecutive failures', async () => {
    const account = createAccount('account-1')
    const grant = createGrant({ accountIds: [account.id], permissions: ['scheduler.run'] })
    const repository = new FakeAutomationRepository([account], grant)
    repository.schedules.push(createSchedule(account.id))
    let now = new Date(initialTime)
    const executor: PluginExecutor = {
      execute: vi.fn(async () => { throw new Error('目标暂时不可用') })
    }
    const service = new PluginAutomationService(
      repository,
      { listContributions: () => [scheduledContribution()] },
      executor,
      30_000,
      () => now
    )

    await service.tick()
    expect(executor.execute).toHaveBeenCalledTimes(1)
    expect(repository.schedules[0]).toMatchObject({
      enabled: true,
      consecutiveFailures: 1,
      nextRunAt: '2026-07-14T08:05:00.000Z'
    })

    now = new Date('2026-07-14T08:05:00.000Z')
    await service.tick()
    now = new Date('2026-07-14T08:10:00.000Z')
    await service.tick()

    expect(executor.execute).toHaveBeenCalledTimes(3)
    expect(repository.schedules[0]).toMatchObject({
      enabled: false,
      consecutiveFailures: 3,
      nextRunAt: null,
      suspendedReason: '连续失败三次，自动计划已暂停'
    })
  })

  it('coalesces missed calendar occurrences into one run and advances from the current local day', async () => {
    const account = createAccount('account-calendar')
    const grant = createGrant({ accountIds: [account.id], permissions: ['scheduler.run'] })
    const repository = new FakeAutomationRepository([account], grant)
    const schedule = createSchedule(account.id)
    schedule.cadence = { type: 'daily', time: '09:00' }
    schedule.intervalMinutes = 24 * 60
    schedule.nextRunAt = new Date(2026, 6, 10, 9, 0, 0, 0).toISOString()
    repository.schedules.push(schedule)
    const now = new Date(2026, 6, 20, 10, 0, 0, 0)
    const executor = { execute: vi.fn(async () => null) }
    const service = new PluginAutomationService(
      repository,
      { listContributions: () => [scheduledContribution()] },
      executor,
      30_000,
      () => now
    )

    await service.tick()

    expect(executor.execute).toHaveBeenCalledOnce()
    const next = new Date(repository.schedules[0]!.nextRunAt!)
    expect([
      next.getFullYear(),
      next.getMonth() + 1,
      next.getDate(),
      next.getHours(),
      next.getMinutes()
    ]).toEqual([2026, 7, 21, 9, 0])
  })

  it('pauses new automatic work without blocking a later manual run', async () => {
    const account = createAccount('account-1')
    const repository = new FakeAutomationRepository([account], createGrant({ accountIds: [account.id], permissions: [] }))
    const executor = { execute: vi.fn(async () => null) }
    const service = createService(repository, actionContribution(), executor)

    service.setPaused(true)
    await service.tick()
    expect(executor.execute).not.toHaveBeenCalled()
    await service.runManual('example.plugin', 'example.action', account.id)
    expect(executor.execute).toHaveBeenCalledOnce()
  })

  it('serializes manual runs for the same account while leaving the first run intact', async () => {
    const account = createAccount('account-1')
    const repository = new FakeAutomationRepository([account], createGrant({ accountIds: [account.id], permissions: [] }))
    let release!: () => void
    const waiting = new Promise<void>((resolve) => { release = resolve })
    const started = vi.fn()
    const executor: PluginExecutor = {
      execute: vi.fn(async () => {
        started()
        await waiting
        return null
      })
    }
    const contribution = actionContribution()
    const service = createService(repository, contribution, executor)

    const first = service.runManual('example.plugin', contribution.contribution.id, account.id)
    await vi.waitFor(() => expect(started).toHaveBeenCalledOnce())
    await expect(service.runManual('example.plugin', contribution.contribution.id, account.id))
      .rejects.toMatchObject({ code: 'ACCOUNT_BUSY' })
    release()
    await expect(first).resolves.toMatchObject({ status: 'succeeded', accountId: account.id })

    expect(repository.runs.map((run) => run.status)).toEqual(['succeeded', 'failed'])
    expect(repository.runs[1]).toMatchObject({ errorCode: 'ACCOUNT_BUSY' })
  })

  it('shares the account lock with platform synchronization', async () => {
    const account = createAccount('account-1')
    const repository = new FakeAutomationRepository([account], createGrant({ accountIds: [account.id], permissions: [] }))
    const executor = { execute: vi.fn(async () => null) }
    const service = createService(repository, actionContribution(), executor)
    const coordinator = new AccountExecutionCoordinator()
    service.setAccountCoordinator(coordinator)
    let release!: () => void
    const platformSync = coordinator.run(account.id, async () => {
      await new Promise<void>((resolve) => { release = resolve })
    })

    await expect(service.runManual('example.plugin', 'example.action', account.id))
      .rejects.toMatchObject({ code: 'ACCOUNT_BUSY' })
    expect(executor.execute).not.toHaveBeenCalled()
    expect(repository.runs[0]).toMatchObject({ status: 'failed', errorCode: 'ACCOUNT_BUSY' })
    release()
    await platformSync
  })
})

class FakeAutomationRepository {
  readonly events: PluginEventEnvelope[] = []
  readonly deliveries: PluginEventDelivery[] = []
  readonly runs: PluginRunRecord[] = []
  readonly schedules: PluginSchedule[] = []

  constructor(
    private readonly accounts: Account[],
    private readonly grant: PluginGrant | null
  ) {}

  listAccounts(): Account[] { return structuredClone(this.accounts) }
  listPluginEvents(): PluginEventEnvelope[] { return structuredClone(this.events) }

  ensurePluginEventDelivery(eventId: string, pluginId: string, contributionId: string): PluginEventDelivery {
    const existing = this.deliveries.find((item) => item.event.id === eventId &&
      item.pluginId === pluginId && item.contributionId === contributionId)
    if (existing) return structuredClone(existing)
    const event = this.events.find((item) => item.id === eventId)!
    const delivery: PluginEventDelivery = {
      id: `delivery-${this.deliveries.length + 1}`,
      event: structuredClone(event),
      pluginId,
      contributionId,
      status: 'pending',
      attempt: 0,
      nextAttemptAt: initialTime,
      errorCode: '',
      errorMessage: '',
      createdAt: initialTime,
      updatedAt: initialTime
    }
    this.deliveries.push(delivery)
    return structuredClone(delivery)
  }

  listDuePluginDeliveries(now: string): PluginEventDelivery[] {
    return structuredClone(this.deliveries.filter((item) => (
      (item.status === 'pending' || item.status === 'retry') &&
      item.nextAttemptAt !== null && item.nextAttemptAt <= now
    )))
  }

  updatePluginDelivery(id: string, patch: Partial<PluginEventDelivery>): PluginEventDelivery {
    const delivery = this.deliveries.find((item) => item.id === id)!
    Object.assign(delivery, patch, { updatedAt: initialTime })
    return structuredClone(delivery)
  }

  createPluginRun(run: PluginRunRecord): PluginRunRecord {
    this.runs.push(structuredClone(run))
    return structuredClone(run)
  }

  updateExtensionRun(id: string, patch: Partial<PluginRunRecord>): PluginRunRecord {
    const run = this.runs.find((item) => item.id === id)!
    Object.assign(run, patch)
    return structuredClone(run)
  }

  listPluginSchedules(): PluginSchedule[] { return structuredClone(this.schedules) }

  updatePluginSchedule(id: string, patch: Partial<PluginSchedule>): PluginSchedule {
    const schedule = this.schedules.find((item) => item.id === id)!
    Object.assign(schedule, patch, { updatedAt: initialTime })
    return structuredClone(schedule)
  }

  getPluginGrant(pluginId: string, contributionId: string): PluginGrant | null {
    return this.grant?.pluginId === pluginId && this.grant.contributionId === contributionId
      ? structuredClone(this.grant)
      : null
  }
}

function createService(
  repository: FakeAutomationRepository,
  contribution: PluginContributionState,
  executor: PluginExecutor
): PluginAutomationService {
  return new PluginAutomationService(
    repository,
    { listContributions: () => [contribution] },
    executor,
    30_000,
    () => new Date(initialTime)
  )
}

function eventContribution(): PluginContributionState {
  return {
    pluginId: 'example.plugin',
    pluginName: 'Example',
    pluginVersion: '1.0.0',
    enabled: true,
    granted: true,
    suspendedReason: '',
    contribution: {
      id: 'example.events',
      kind: 'event.handler',
      name: 'Events',
      description: 'Handles events',
      entry: 'entries/events.js',
      runtime: 'quickjs',
      permissions: ['events.subscribe'],
      events: ['sync.completed.v1']
    }
  }
}

function actionContribution(): PluginContributionState {
  return {
    pluginId: 'example.plugin',
    pluginName: 'Example',
    pluginVersion: '1.0.0',
    enabled: true,
    granted: true,
    suspendedReason: '',
    contribution: {
      id: 'example.action',
      kind: 'action',
      name: 'Action',
      description: 'Runs an action',
      entry: 'entries/action.js',
      runtime: 'quickjs',
      permissions: [],
      placements: ['plugin-center']
    }
  }
}

function scheduledContribution(): PluginContributionState {
  return {
    pluginId: 'example.plugin',
    pluginName: 'Example',
    pluginVersion: '1.0.0',
    enabled: true,
    granted: true,
    suspendedReason: '',
    contribution: {
      id: 'example.schedule',
      kind: 'scheduled.task',
      name: 'Schedule',
      description: 'Runs on a schedule',
      entry: 'entries/schedule.js',
      runtime: 'quickjs',
      permissions: ['scheduler.run'],
      minimumIntervalMinutes: 5,
      defaultIntervalMinutes: 5
    }
  }
}

function createGrant(overrides: Partial<PluginGrant> = {}): PluginGrant {
  return {
    pluginId: 'example.plugin',
    contributionId: overrides.permissions?.includes('scheduler.run') ? 'example.schedule' :
      overrides.permissions?.length === 0 ? 'example.action' : 'example.events',
    permissions: ['events.subscribe'],
    accountIds: [],
    groupIds: [],
    dataScopes: [],
    networkOrigins: [],
    grantedAt: initialTime,
    updatedAt: initialTime,
    ...overrides
  }
}

function createEvent(accountId: string): PluginEventEnvelope<Record<string, unknown>> {
  return {
    id: 'event-1',
    type: 'sync.completed.v1',
    schemaVersion: 1,
    occurredAt: initialTime,
    source: { app: 'streamfold', pluginId: null },
    subject: { accountId, contentId: null },
    data: {
      alias: '本地别名',
      groupIds: ['team-a'],
      stats: { newContentCount: 1 },
      profile: { remoteName: '本人', followers: 18 },
      contents: [{ title: '保留标题', snapshots: [{ likes: 3 }] }]
    }
  }
}

function createSchedule(accountId: string): PluginSchedule {
  return {
    id: 'schedule-1',
    pluginId: 'example.plugin',
    contributionId: 'example.schedule',
    accountIds: [accountId],
    groupIds: [],
    cadence: { type: 'interval', intervalMinutes: 5 },
    intervalMinutes: 5,
    enabled: true,
    nextRunAt: '2026-07-01T00:00:00.000Z',
    lastRunAt: null,
    consecutiveFailures: 0,
    suspendedReason: '',
    createdAt: initialTime,
    updatedAt: initialTime
  }
}

function createAccount(id: string, groupIds: string[] = []): Account {
  return {
    id,
    platformId: 'example',
    adapterContributionId: null,
    alias: '本地别名',
    aliasCustomized: true,
    remoteName: '本人',
    remoteId: 'remote-1',
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
    ownershipConfirmedAt: initialTime,
    identityVerifiedAt: initialTime,
    note: '',
    tags: [],
    groupIds,
    sessionPartition: `persist:social:${id}`,
    syncMode: 'recent_20',
    isDefault: false,
    createdAt: initialTime,
    updatedAt: initialTime,
    lastSyncedAt: null
  }
}
