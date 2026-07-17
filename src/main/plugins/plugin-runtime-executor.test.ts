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
  X_PLATFORM_CONTRIBUTION_ID,
  X_PLUGIN_ID,
  xEntrySource,
  xPluginManifest
} from './builtin-x.test-fixture'
import {
  PluginPlatformSessionError,
  PluginRuntimeExecutor,
  type PluginRuntimeHost,
  type PluginRuntimeRepository
} from './plugin-runtime-executor'
import { PublicHttpsBroker } from './public-https-broker'
import { executeQuickJsContribution } from './quickjs-engine'
import { formatSandboxDiagnostic } from './sandbox-diagnostics'
import { PluginSupplyChainError } from './supply-chain-errors'
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
  ] as const)('classifies HTTP %s and retains a credential-redacted response body', async (
    status,
    retryAfter,
    retryable,
    delay
  ) => {
    const fixture = runtimeFixture({
      brokerRequest: vi.fn(async () => ({
        status,
        contentType: 'application/json',
        body: JSON.stringify({
          reason: 'service unavailable',
          requestId: `remote-${status}`,
          token: 'private-token',
          cookie: 'private-cookie'
        }),
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
    expect(error.message).not.toContain('service unavailable')
    const diagnostic = formatSandboxDiagnostic(error) ?? ''
    expect(diagnostic).toContain(`插件版本：${webhookPluginManifest.version}`)
    expect(diagnostic).toContain(`入口：${webhookContribution().contribution.entry}`)
    expect(diagnostic).toContain('执行方法：handle')
    expect(diagnostic).toContain('service unavailable')
    expect(diagnostic).toContain(`remote-${status}`)
    expect(diagnostic).not.toContain('private-token')
    expect(diagnostic).not.toContain('private-cookie')
  })

  it('retains a sanitized transport failure even when guest code converts it to HTTP 599', async () => {
    const fixture = runtimeFixture({
      brokerRequest: vi.fn(async () => {
        throw new Error(
          'connection refused by remote service https://hooks.example/events?token=private ' +
          'headers={Authorization: Bearer private-header}'
        )
      }),
      invoke: async (sandboxRequest, executor) => {
        try {
          await executor.hostCall({
            operation: 'network.https',
            payload: { url: 'https://hooks.example/events', method: 'POST', body: { safe: true } }
          }, {
            invocationId: sandboxRequest.invocationId,
            pluginId: sandboxRequest.pluginId,
            contributionId: sandboxRequest.contributionId
          })
        } catch {}
        return { status: 599, retryAfter: null }
      }
    })

    const error = await rejectionOf(() => fixture.executor.execute(executionRequest()))
    expect(error).toMatchObject({ code: 'WEBHOOK_RETRYABLE_HTTP' })
    const diagnostic = formatSandboxDiagnostic(error) ?? ''
    expect(diagnostic).toContain('connection refused by remote service')
    expect(diagnostic).not.toContain('private-header')
    expect(diagnostic).not.toContain('token=private')
    expect(diagnostic).not.toContain('hooks.example')
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

    const error = await rejectionOf(() => executor.execute(executionRequest()))

    expect(error).toBeInstanceOf(PluginSupplyChainError)
    expect(error).toMatchObject({
      code: 'PLUGIN_SANDBOX_PERMISSION_DENIED',
      message: '插件贡献点尚未授权或授权已失效'
    })
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

    const error = await rejectionOf(() => executor.execute({ ...executionRequest(), accountId: 'account-2' }))

    expect(error).not.toBeInstanceOf(PluginSupplyChainError)
    expect(error.message).toContain('未获准访问此账号')
    expect(entries.readEntry).not.toHaveBeenCalled()
    expect(sandbox.invoke).not.toHaveBeenCalled()
  })

  it('reports an ungranted network origin as a sandbox permission denial', async () => {
    const brokerRequest = vi.fn()
    const fixture = runtimeFixture({
      brokerRequest,
      invoke: async (sandboxRequest, executor) => executor.hostCall({
        operation: 'network.https',
        payload: { url: 'https://untrusted.example/events', method: 'POST', body: {} }
      }, {
        invocationId: sandboxRequest.invocationId,
        pluginId: sandboxRequest.pluginId,
        contributionId: sandboxRequest.contributionId
      })
    })

    const error = await rejectionOf(() => fixture.executor.execute(executionRequest()))

    expect(error).toMatchObject({
      code: 'PLUGIN_SANDBOX_PERMISSION_DENIED',
      message: '插件网络目标未获授权'
    })
    expect(brokerRequest).not.toHaveBeenCalled()
  })

  it('reports a disallowed host operation as a sandbox permission denial', async () => {
    const fixture = runtimeFixture({
      brokerRequest: vi.fn(),
      invoke: async (sandboxRequest, executor) => executor.hostCall({
        operation: 'data.read',
        payload: { resource: 'accounts', query: {} }
      }, {
        invocationId: sandboxRequest.invocationId,
        pluginId: sandboxRequest.pluginId,
        contributionId: sandboxRequest.contributionId
      })
    })

    const error = await rejectionOf(() => fixture.executor.execute(executionRequest()))

    expect(error).toMatchObject({
      code: 'PLUGIN_SANDBOX_PERMISSION_DENIED',
      message: '插件操作未获授权'
    })
  })

  it.each([
    ['profiles', {}, '插件未获准读取此类数据'],
    ['accounts', { accountId: 'account-2' }, '插件无权访问此账号']
  ] as const)('reports rejected %s data access as a sandbox permission denial', async (
    resource,
    query,
    message
  ) => {
    const permissions: PluginGrant['permissions'] = ['events.subscribe', 'accounts.read']
    const baseState = webhookContribution()
    const state: PluginContributionState = {
      ...baseState,
      contribution: { ...baseState.contribution, permissions }
    }
    const grant: PluginGrant = {
      ...webhookGrant(),
      permissions,
      dataScopes: ['account'],
      networkOrigins: []
    }
    let executor!: PluginRuntimeExecutor
    const sandbox = {
      invoke: vi.fn(async (request: SandboxInvocationRequest) => executor.hostCall({
        operation: 'data.read',
        payload: { resource, query }
      }, {
        invocationId: request.invocationId,
        pluginId: request.pluginId,
        contributionId: request.contributionId
      }))
    }
    executor = new PluginRuntimeExecutor(
      {
        ...runtimeHost(),
        listContributions: () => [state]
      },
      runtimeRepository(() => grant),
      { readEntry: async () => webhookEntrySource },
      sandbox,
      platformProxy()
    )

    const error = await rejectionOf(() => executor.execute(executionRequest()))

    expect(error).toMatchObject({ code: 'PLUGIN_SANDBOX_PERMISSION_DENIED', message })
  })
})

describe('PluginRuntimeExecutor platform diagnostics', () => {
  it.each([
    'PLUGIN_SANDBOX_PROTOCOL_INVALID',
    'PLUGIN_SANDBOX_PERMISSION_DENIED',
    'PLUGIN_SANDBOX_RESOURCE_LIMIT',
    'PLUGIN_SANDBOX_CRASHED',
    'PLUGIN_SANDBOX_FAILED'
  ] as const)('enriches %s without inventing plugin source frames', async (code) => {
    const originalMessage = `original ${code}`
    const originalCause = new Error(
      'plain cause mentioning streamfold:streamfold.webhook/streamfold.webhook.events.js:99:4 without a stack frame'
    )
    const fixture = runtimeFixture({
      brokerRequest: vi.fn(),
      invoke: async () => {
        throw new PluginSupplyChainError(code, originalMessage, { cause: originalCause })
      }
    })

    const error = await rejectionOf(() => fixture.executor.execute(executionRequest()))

    expect(error).toBeInstanceOf(PluginSupplyChainError)
    expect(error).toMatchObject({ code, message: originalMessage })
    expect(error.cause).toBeInstanceOf(AggregateError)
    expect((error.cause as AggregateError).errors).toContain(originalCause)
    const diagnostic = String(error.cause)
    expect(diagnostic).toContain(`插件：${WEBHOOK_PLUGIN_ID}`)
    expect(diagnostic).toContain(`插件版本：${webhookPluginManifest.version}`)
    expect(diagnostic).toContain(`贡献点：${WEBHOOK_EVENT_ID}`)
    expect(diagnostic).toContain(`入口：${webhookContribution().contribution.entry}`)
    expect(diagnostic).toContain('执行方法：handle')
    expect(diagnostic).not.toContain('插件函数：')
    expect(diagnostic).not.toContain('源码位置：')
    expect(diagnostic).not.toContain('插件调用链')
    expect(diagnostic).not.toContain('源码上下文')
  })

  it('keeps a trusted platform host failure as the fixed sandbox error cause', async () => {
    const contribution = xPluginManifest.contributions.find((item) => item.id === X_PLATFORM_CONTRIBUTION_ID)!
    const state: PluginContributionState = {
      pluginId: X_PLUGIN_ID,
      pluginName: xPluginManifest.name,
      pluginVersion: xPluginManifest.version,
      contribution,
      enabled: true,
      granted: true,
      suspendedReason: ''
    }
    const hostFailure = new Error('平台登录状态已失效：HTTP 401 response={"reason":"session expired"}')
    const guestFailure = new Error([
      'Error: X 数据无效：UserTweets.data.user.result 必须是对象',
      '    at fail (streamfold:streamfold.x/streamfold.x.platform.js:28:18)',
      '    at object (streamfold:streamfold.x/streamfold.x.platform.js:36:25)',
      '    at parseTimelineResponse (streamfold:streamfold.x/streamfold.x.platform.js:327:18)',
      '    at collect (streamfold:streamfold.x/streamfold.x.platform.js:417:24)'
    ].join('\n'))
    let executor!: PluginRuntimeExecutor
    const sandbox = {
      invoke: vi.fn(async (request: SandboxInvocationRequest) => {
        try {
          await executor.hostCall({
            operation: 'platform.captureJson',
            payload: { captureId: 'x.identity.settings', params: {}, limit: 1 }
          }, {
            invocationId: request.invocationId,
            pluginId: request.pluginId,
            contributionId: request.contributionId
          })
        } catch {
          throw new PluginSupplyChainError(
            'PLUGIN_SANDBOX_FAILED',
            '插件执行失败',
            {
              cause: new AggregateError(
                [hostFailure, guestFailure],
                '插件宿主操作失败：platform.captureJson'
              )
            }
          )
        }
        return {}
      })
    }
    executor = new PluginRuntimeExecutor(
      {
        listContributions: () => [state],
        getConfig: () => ({
          pluginId: X_PLUGIN_ID,
          contributionId: X_PLATFORM_CONTRIBUTION_ID,
          values: { manualCollectionIntervalMinutes: 5 },
          configuredSecrets: [],
          updatedAt: now
        }),
        getRuntimeSecrets: () => ({})
      },
      {
        getPluginGrant: () => ({
          pluginId: X_PLUGIN_ID,
          contributionId: X_PLATFORM_CONTRIBUTION_ID,
          permissions: ['platform.session-json'],
          accountIds: ['account-1'],
          groupIds: [],
          dataScopes: [],
          networkOrigins: [],
          grantedAt: now,
          updatedAt: now
        }),
        listAccounts: () => [{
          ...account('account-1'),
          platformId: 'x',
          adapterContributionId: X_PLATFORM_CONTRIBUTION_ID
        }],
        listContents: () => [],
        listAccountSnapshots: () => []
      },
      { readEntry: async () => xEntrySource },
      sandbox,
      {
        getJson: vi.fn(async (): Promise<JsonValue> => ({})),
        captureJson: vi.fn(async (): Promise<JsonValue> => { throw hostFailure })
      }
    )

    const error = await rejectionOf(() => executor.invoke(
      X_PLUGIN_ID,
      X_PLATFORM_CONTRIBUTION_ID,
      'readIdentity',
      'account-1',
      { expectedRemoteId: null }
    ))

    expect(error).toBeInstanceOf(PluginPlatformSessionError)
    expect(error).toMatchObject({ kind: 'expired', message: '平台登录状态已失效，请重新登录' })
    expect(error.message).not.toContain('sensitive guest failure text')
    const sandboxFailure = error.cause as PluginSupplyChainError
    expect(sandboxFailure).toMatchObject({ code: 'PLUGIN_SANDBOX_FAILED', message: '插件执行失败' })
    const pluginDiagnostic = formatSandboxDiagnostic(error) ?? ''
    expect(pluginDiagnostic).toContain('HTTP 401')
    expect(pluginDiagnostic).toContain(`插件版本：${xPluginManifest.version}`)
    expect(pluginDiagnostic).toContain('插件函数：parseTimelineResponse')
    expect(pluginDiagnostic).toContain('源码位置：entries/x.js:321:18')
    expect(pluginDiagnostic).toContain('1. fail @ entries/x.js:22:18')
    expect(pluginDiagnostic).toContain('2. object @ entries/x.js:30:25')
    expect(pluginDiagnostic).toContain('3. parseTimelineResponse @ entries/x.js:321:18')
    expect(pluginDiagnostic).not.toContain('源码位置：entries/x.js:22:18')
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
