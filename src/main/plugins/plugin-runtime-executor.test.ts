import { createHmac } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Account } from '../../shared/contracts'
import type {
  PluginContributionState,
  PluginEventEnvelope,
  PluginGrant
} from '../../shared/plugin-host-contracts'
import { RetryablePluginError, type PluginExecutionRequest } from './automation-service'
import {
  WEBHOOK_EVENT_ID,
  WEBHOOK_PLUGIN_ID,
  webhookEntrySource,
  webhookPluginManifest
} from './builtin-webhook.test-fixture'
import {
  PluginRuntimeExecutor,
  type PluginRuntimeHost,
  type PluginRuntimeRepository
} from './plugin-runtime-executor'
import { PublicHttpsBroker } from './public-https-broker'
import { executeQuickJsContribution } from './quickjs-engine'
import {
  DEFAULT_SANDBOX_LIMITS,
  type JsonObject,
  type JsonValue,
  type SandboxInvocationRequest
} from './sandbox-protocol'

const now = '2026-07-14T08:00:00.000Z'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('official Webhook contribution', () => {
  it('builds a versioned envelope and applies configured top-level field filtering inside QuickJS', async () => {
    const calls: Array<{ operation: string; payload: JsonObject }> = []
    const event = webhookEvent()
    const result = await executeQuickJsContribution({
      protocolVersion: 1,
      type: 'invoke',
      invocationId: 'invoke_webhook_filter',
      pluginId: WEBHOOK_PLUGIN_ID,
      contributionId: WEBHOOK_EVENT_ID,
      entrySource: webhookEntrySource,
      method: 'handle',
      input: event as unknown as JsonValue,
      context: {
        pluginId: WEBHOOK_PLUGIN_ID,
        contributionId: WEBHOOK_EVENT_ID,
        accountId: 'account-1',
        config: { url: 'https://hooks.example/events', fields: ['profile'] }
      },
      allowedOperations: ['network.https'],
      limits: { ...DEFAULT_SANDBOX_LIMITS }
    }, async (operation, payload) => {
      calls.push({ operation, payload })
      return { status: 204, contentType: '', body: '', retryAfter: null }
    })

    expect(result).toEqual({ status: 204, retryAfter: null })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      operation: 'network.https',
      payload: {
        url: 'https://hooks.example/events',
        method: 'POST',
        body: {
          eventId: 'event-1',
          type: 'sync.completed.v1',
          schemaVersion: 1,
          subject: { accountId: 'account-1', contentId: null },
          data: { profile: { remoteName: '本人', followers: 12 } }
        }
      }
    })
  }, 20_000)

  it('injects credentials, HMAC and stable delivery headers only in the host broker', async () => {
    const time = Date.parse(now)
    vi.spyOn(Date, 'now').mockReturnValue(time)
    const requestBody: JsonValue = { eventId: 'event-1', data: { profile: { remoteName: '本人' } } }
    const brokerRequest = vi.fn(async () => ({
      status: 204,
      contentType: '',
      body: '',
      retryAfter: null
    }))
    const fixture = runtimeFixture({
      config: { url: 'https://hooks.example/events', authType: 'bearer' },
      secrets: { authToken: 'private-token', hmacSecret: '0123456789abcdef' },
      brokerRequest,
      invoke: async (sandboxRequest, executor) => executor.hostCall({
        operation: 'network.https',
        payload: {
          url: 'https://hooks.example/events',
          method: 'POST',
          body: requestBody
        }
      }, {
        invocationId: sandboxRequest.invocationId,
        pluginId: sandboxRequest.pluginId,
        contributionId: sandboxRequest.contributionId
      })
    })

    await expect(fixture.executor.execute(executionRequest())).resolves.toMatchObject({ status: 204 })
    const [brokerInput] = brokerRequest.mock.calls[0] as unknown as [{ headers: Record<string, string> }]
    const headers = brokerInput.headers
    const timestamp = String(Math.floor(time / 1_000))
    expect(headers).toMatchObject({
      Authorization: 'Bearer private-token',
      'X-Streamfold-Event-Id': 'event-1',
      'X-Streamfold-Delivery-Id': 'delivery-1',
      'X-Streamfold-Timestamp': timestamp,
      'Idempotency-Key': 'delivery-1'
    })
    expect(headers['X-Streamfold-Signature']).toBe(`sha256=${createHmac('sha256', '0123456789abcdef')
      .update(`${timestamp}.${JSON.stringify(requestBody)}`).digest('hex')}`)
    expect(fixture.sandboxRequests[0]!.context).not.toHaveProperty('authToken')
    expect(fixture.sandboxRequests[0]!.context).not.toHaveProperty('hmacSecret')
  })

  it.each([
    [429, '120', true, 120_000],
    [503, null, true, null],
    [400, null, false, null]
  ] as const)('classifies HTTP %s without exposing response bodies', async (status, retryAfter, retryable, delay) => {
    const fixture = runtimeFixture({
      brokerRequest: vi.fn(async () => ({
        status,
        contentType: 'text/plain',
        body: 'sensitive remote response',
        retryAfter
      })),
      invoke: async (sandboxRequest, executor) => executor.hostCall({
        operation: 'network.https',
        payload: { url: 'https://hooks.example/events', method: 'POST', body: { safe: true } }
      }, {
        invocationId: sandboxRequest.invocationId,
        pluginId: sandboxRequest.pluginId,
        contributionId: sandboxRequest.contributionId
      })
    })

    const error = await rejectionOf(() => fixture.executor.execute(executionRequest()))
    if (retryable) {
      expect(error).toBeInstanceOf(RetryablePluginError)
      expect(error).toMatchObject({ code: 'WEBHOOK_RETRYABLE_HTTP', retryAfterMs: delay })
    } else {
      expect(error).not.toBeInstanceOf(RetryablePluginError)
    }
    expect(error.message).toContain(String(status))
    expect(error.message).not.toContain('sensitive remote response')
  })
})

describe('PluginRuntimeExecutor authorization', () => {
  it('revalidates the grant during every host call and terminates a revoked invocation', async () => {
    let grant: PluginGrant | null = webhookGrant()
    let executor!: PluginRuntimeExecutor
    const sandbox = {
      invoke: vi.fn(async (request: SandboxInvocationRequest) => {
        grant = null
        return await executor.hostCall({
          operation: 'network.https',
          payload: { url: 'https://hooks.example/events', method: 'POST', body: {} }
        }, {
          invocationId: request.invocationId,
          pluginId: request.pluginId,
          contributionId: request.contributionId
        })
      })
    }
    executor = new PluginRuntimeExecutor(
      runtimeHost(),
      runtimeRepository(() => grant),
      { readEntry: async () => webhookEntrySource },
      sandbox,
      platformProxy()
    )

    await expect(executor.execute(executionRequest())).rejects.toThrow('授权')
    expect(sandbox.invoke).toHaveBeenCalledOnce()
  })

  it('rejects an account outside the grant before reading or launching plugin code', async () => {
    const entries = { readEntry: vi.fn(async () => webhookEntrySource) }
    const sandbox = { invoke: vi.fn(async () => null) }
    const executor = new PluginRuntimeExecutor(
      runtimeHost(),
      runtimeRepository(() => webhookGrant()),
      entries,
      sandbox,
      platformProxy()
    )

    await expect(executor.execute({ ...executionRequest(), accountId: 'account-2' }))
      .rejects.toThrow('未获准访问此账号')
    expect(entries.readEntry).not.toHaveBeenCalled()
    expect(sandbox.invoke).not.toHaveBeenCalled()
  })
})

interface RuntimeFixtureOptions {
  config?: Record<string, unknown>
  secrets?: Record<string, string>
  brokerRequest: ReturnType<typeof vi.fn>
  invoke(
    request: SandboxInvocationRequest,
    executor: PluginRuntimeExecutor
  ): Promise<JsonValue>
}

function runtimeFixture(options: RuntimeFixtureOptions) {
  const sandboxRequests: SandboxInvocationRequest[] = []
  let executor!: PluginRuntimeExecutor
  const sandbox = {
    invoke: vi.fn(async (request: SandboxInvocationRequest) => {
      sandboxRequests.push(structuredClone(request))
      return await options.invoke(request, executor)
    })
  }
  const host = runtimeHost(options.config, options.secrets)
  const broker = { request: options.brokerRequest } as unknown as PublicHttpsBroker
  executor = new PluginRuntimeExecutor(
    host,
    runtimeRepository(() => webhookGrant()),
    { readEntry: async () => webhookEntrySource },
    sandbox,
    platformProxy(),
    broker
  )
  return { executor, sandboxRequests }
}

function runtimeHost(
  config: Record<string, unknown> = { url: 'https://hooks.example/events' },
  secrets: Record<string, string> = {}
): PluginRuntimeHost {
  return {
    listContributions: () => [webhookContribution()],
    getConfig: () => ({
      pluginId: WEBHOOK_PLUGIN_ID,
      contributionId: WEBHOOK_EVENT_ID,
      values: structuredClone(config),
      configuredSecrets: Object.keys(secrets),
      updatedAt: now
    }),
    getRuntimeSecrets: () => ({ ...secrets })
  }
}

function runtimeRepository(grant: () => PluginGrant | null): PluginRuntimeRepository {
  return {
    getPluginGrant: () => grant(),
    listAccounts: () => [account('account-1')],
    listContents: () => [],
    listAccountSnapshots: () => []
  }
}

function platformProxy() {
  return {
    getJson: vi.fn(async (): Promise<JsonValue> => ({})),
    captureJson: vi.fn(async (): Promise<JsonValue> => [])
  }
}

function webhookContribution(): PluginContributionState {
  const contribution = webhookPluginManifest.contributions.find((item) => item.id === WEBHOOK_EVENT_ID)!
  return {
    pluginId: WEBHOOK_PLUGIN_ID,
    pluginName: webhookPluginManifest.name,
    pluginVersion: webhookPluginManifest.version,
    contribution,
    enabled: true,
    granted: true,
    suspendedReason: ''
  }
}

function webhookGrant(): PluginGrant {
  return {
    pluginId: WEBHOOK_PLUGIN_ID,
    contributionId: WEBHOOK_EVENT_ID,
    permissions: ['events.subscribe', 'network.https'],
    accountIds: ['account-1'],
    groupIds: [],
    dataScopes: ['profile'],
    networkOrigins: ['https://hooks.example'],
    grantedAt: now,
    updatedAt: now
  }
}

function executionRequest(): PluginExecutionRequest {
  return {
    pluginId: WEBHOOK_PLUGIN_ID,
    contributionId: WEBHOOK_EVENT_ID,
    trigger: 'event',
    accountId: 'account-1',
    event: webhookEvent(),
    deliveryId: 'delivery-1'
  }
}

function webhookEvent(): PluginEventEnvelope<Record<string, unknown>> {
  return {
    id: 'event-1',
    type: 'sync.completed.v1',
    schemaVersion: 1,
    occurredAt: now,
    source: { app: 'streamfold', pluginId: null },
    subject: { accountId: 'account-1', contentId: null },
    data: {
      account: { alias: '本地别名' },
      profile: { remoteName: '本人', followers: 12 },
      contents: [{ title: '文章' }]
    }
  }
}

function account(id: string): Account {
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
    ownershipConfirmedAt: now,
    identityVerifiedAt: now,
    note: '',
    tags: [],
    groupIds: [],
    sessionPartition: `persist:social:${id}`,
    syncMode: 'recent_20',
    isDefault: false,
    createdAt: now,
    updatedAt: now,
    lastSyncedAt: null
  }
}

async function rejectionOf(action: () => Promise<unknown>): Promise<Error> {
  try {
    await action()
    throw new Error('expected action to reject')
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
}
