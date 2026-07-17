import { createHmac, randomUUID } from 'node:crypto'
import type { Account } from '../../shared/contracts'
import type { ContentSummary } from '../../shared/content-contracts'
import type {
  PluginConfigView,
  PluginContribution,
  PluginContributionState,
  PluginEventEnvelope,
  PluginGrant,
  PlatformCapturePolicy
} from '../../shared/plugin-host-contracts'
import { RetryablePluginError, type PluginExecutionRequest, type PluginExecutor } from './automation-service'
import { PublicHttpsBroker } from './public-https-broker'
import { formatSandboxDiagnostic, sanitizeSandboxDiagnostic } from './sandbox-diagnostics'
import { normalizePluginNetworkError, pluginNetworkResponseError } from './network-diagnostics'
import {
  DEFAULT_SANDBOX_LIMITS,
  type JsonObject,
  type JsonValue,
  type SandboxHostCallMessage,
  type SandboxHostOperation
} from './sandbox-protocol'
import type { SandboxHostCallHandler, UtilityProcessSandboxManager } from './utility-process-manager'
import {
  PluginSupplyChainError,
  isPluginSupplyChainError,
  type PluginSupplyChainErrorCode
} from './supply-chain-errors'

export interface PluginEntrySource {
  readEntry(pluginId: string, version: string, entry: string): Promise<string>
}

export interface PluginRuntimeHost {
  listContributions(): PluginContributionState[]
  getConfig(pluginId: string, contributionId: string): PluginConfigView
  getRuntimeSecrets(pluginId: string, contributionId: string): Record<string, string>
}

export interface PluginRuntimeRepository {
  getPluginGrant(pluginId: string, contributionId: string): PluginGrant | null
  listAccounts(): Account[]
  listContents(query?: { accountId?: string; limit?: number }): ContentSummary[]
  listAccountSnapshots(accountId?: string): unknown[]
}

export interface PlatformJsonProxy {
  getJson(input: {
    pluginId: string
    contribution: Extract<PluginContribution, { kind: 'platform.adapter' }>
    accountId: string
    endpointId: string
    params: JsonObject
  }): Promise<JsonValue>
  captureJson(input: {
    pluginId: string
    pluginVersion: string
    contribution: Extract<PluginContribution, { kind: 'platform.adapter' }>
    accountId: string
    captureId: string
    params: JsonObject
    limit?: number
    policy: PlatformCapturePolicy
  }): Promise<JsonValue>
}

export interface BuiltinContributionExecutor {
  execute(request: PluginExecutionRequest, contribution: PluginContribution): Promise<Record<string, unknown> | null>
}

interface ActiveInvocation {
  request: PluginExecutionRequest
  contribution: PluginContributionState
  grant: PluginGrant
  allowUnboundAdapter: boolean
  capturePolicy: PlatformCapturePolicy
  recentHostResponses: Array<{ operation: SandboxHostOperation; diagnostic: Error }>
}

export class PluginPlatformSessionError extends Error {
  constructor(readonly kind: 'expired' | 'risk', options?: ErrorOptions) {
    super(
      kind === 'expired' ? '平台登录状态已失效，请重新登录' : '平台请求暂时受限，请稍后重试',
      options
    )
    this.name = 'PluginPlatformSessionError'
  }
}

/**
 * Executes every untrusted contribution in a one-shot Utility Process and
 * revalidates its grant on every host call. No package path, Session, secret or
 * database object is ever included in the guest context.
 */
export class PluginRuntimeExecutor implements PluginExecutor {
  private readonly active = new Map<string, ActiveInvocation>()
  readonly hostCall: SandboxHostCallHandler

  constructor(
    private readonly host: PluginRuntimeHost,
    private readonly repository: PluginRuntimeRepository,
    private readonly entries: PluginEntrySource,
    private readonly sandbox: Pick<UtilityProcessSandboxManager, 'invoke'> & Partial<Pick<UtilityProcessSandboxManager, 'terminatePlugin'>>,
    private readonly platform: PlatformJsonProxy,
    private readonly https = new PublicHttpsBroker(),
    private readonly builtin?: BuiltinContributionExecutor
  ) {
    this.hostCall = (call, identity) => this.handleHostCall(call, identity)
  }

  terminatePlugin(pluginId: string): void {
    this.sandbox.terminatePlugin?.(pluginId)
    for (const [invocationId, active] of this.active) {
      if (active.request.pluginId === pluginId) this.active.delete(invocationId)
    }
  }

  async execute(request: PluginExecutionRequest): Promise<Record<string, unknown> | null> {
    const state = this.requireContribution(request.pluginId, request.contributionId)
    const grant = this.requireGrant(request.pluginId, request.contributionId, state.contribution)
    if (request.accountId && !accountAllowed(request.accountId, grant, this.repository.listAccounts())) {
      throw new Error('插件未获准访问此账号')
    }
    if (state.contribution.kind === 'platform.adapter') {
      const account = request.accountId
        ? this.repository.listAccounts().find((item) => item.id === request.accountId)
        : null
      if (!account || account.adapterContributionId !== state.contribution.id) {
        throw new Error('平台适配器未绑定此账号')
      }
      if (!this.builtin) throw new Error('平台宿主执行器不可用')
      return await this.builtin.execute(request, state.contribution)
    }
    if (state.contribution.runtime === 'builtin') {
      if (!this.builtin) throw new Error('内置贡献点执行器不可用')
      return await this.builtin.execute(request, state.contribution)
    }

    const invocationId = randomUUID()
    const config = this.host.getConfig(request.pluginId, request.contributionId)
    const entrySource = await this.entries.readEntry(
      request.pluginId,
      state.pluginVersion,
      state.contribution.entry
    )
    const invocation: ActiveInvocation = {
      request,
      contribution: state,
      grant,
      allowUnboundAdapter: false,
      capturePolicy: 'fresh',
      recentHostResponses: []
    }
    this.active.set(invocationId, invocation)
    try {
      const value = await this.sandbox.invoke({
        protocolVersion: 1,
        type: 'invoke',
        invocationId,
        pluginId: request.pluginId,
        contributionId: request.contributionId,
        entrySource,
        method: contributionMethod(state.contribution, request.trigger),
        input: invocationInput(request),
        context: {
          pluginId: request.pluginId,
          contributionId: request.contributionId,
          trigger: request.trigger,
          accountId: request.accountId,
          event: request.event as JsonValue,
          deliveryId: request.deliveryId ?? null,
          config: config.values as JsonObject
        },
        allowedOperations: allowedOperations(state.contribution, grant),
        limits: DEFAULT_SANDBOX_LIMITS
      })
      if (value === null) return null
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('插件结果必须是 JSON 对象或 null')
      }
      validateWebhookResult(request.pluginId, value as Record<string, JsonValue>)
      return value as Record<string, unknown>
    } catch (error) {
      const detailed = enrichPluginExecutionFailure(error, {
        pluginId: request.pluginId,
        pluginVersion: state.pluginVersion,
        contributionId: request.contributionId,
        entry: state.contribution.entry,
        method: contributionMethod(state.contribution, request.trigger),
        entrySource
      })
      throw attachRecentHostResponses(detailed, invocation.recentHostResponses)
    } finally {
      this.active.delete(invocationId)
    }
  }

  async invoke(
    pluginId: string,
    contributionId: string,
    method: 'readIdentity' | 'collect',
    accountId: string,
    input: JsonObject,
    allowUnboundAdapter = false,
    capturePolicy: PlatformCapturePolicy = 'fresh'
  ): Promise<Record<string, unknown>> {
    const state = this.requireContribution(pluginId, contributionId)
    if (state.contribution.kind !== 'platform.adapter') throw new Error('贡献点不是平台适配器')
    if (state.contribution.runtime === 'builtin') throw new Error('内置平台适配器由可信宿主执行')
    const grant = this.requireGrant(pluginId, contributionId, state.contribution)
    if (!accountAllowed(accountId, grant, this.repository.listAccounts())) throw new Error('插件未获准访问此账号')
    const invocationId = randomUUID()
    const request: PluginExecutionRequest = {
      pluginId,
      contributionId,
      trigger: 'manual',
      accountId,
      event: null,
      deliveryId: null
    }
    const config = this.host.getConfig(pluginId, contributionId)
    const entrySource = await this.entries.readEntry(pluginId, state.pluginVersion, state.contribution.entry)
    const invocation: ActiveInvocation = {
      request,
      contribution: state,
      grant,
      allowUnboundAdapter,
      capturePolicy,
      recentHostResponses: []
    }
    this.active.set(invocationId, invocation)
    try {
      const value = await this.sandbox.invoke({
        protocolVersion: 1,
        type: 'invoke',
        invocationId,
        pluginId,
        contributionId,
        entrySource,
        method,
        input,
        context: {
          pluginId,
          contributionId,
          accountId,
          config: config.values as JsonObject
        },
        allowedOperations: allowedOperations(state.contribution, grant),
        limits: DEFAULT_SANDBOX_LIMITS
      })
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('平台适配器返回结果无效')
      return value as Record<string, unknown>
    } catch (error) {
      const detailed = enrichPluginExecutionFailure(error, {
        pluginId,
        pluginVersion: state.pluginVersion,
        contributionId,
        entry: state.contribution.entry,
        method,
        entrySource
      })
      const sessionIssue = platformSessionIssue(detailed)
      const diagnosed = attachRecentHostResponses(detailed, invocation.recentHostResponses)
      if (sessionIssue) {
        throw new PluginPlatformSessionError(sessionIssue, { cause: diagnosed })
      }
      throw diagnosed
    } finally {
      this.active.delete(invocationId)
    }
  }

  private async handleHostCall(
    call: Pick<SandboxHostCallMessage, 'operation' | 'payload'>,
    identity: { invocationId: string; pluginId: string; contributionId: string }
  ): Promise<JsonValue> {
    const active = this.active.get(identity.invocationId)
    if (!active || active.request.pluginId !== identity.pluginId ||
      active.request.contributionId !== identity.contributionId) {
      throw new PluginSupplyChainError('PLUGIN_SANDBOX_PROTOCOL_INVALID', '插件调用上下文已失效')
    }

    const state = this.requireContribution(identity.pluginId, identity.contributionId, true)
    const grant = this.requireGrant(identity.pluginId, identity.contributionId, state.contribution, true)
    if (!allowedOperations(state.contribution, grant).includes(call.operation)) {
      throw sandboxPermissionDenied('插件操作未获授权')
    }
    let value: JsonValue
    if (call.operation === 'network.https') {
      value = await this.networkCall(active, grant, call.payload)
    } else if (call.operation === 'data.read') {
      value = this.readData(active, grant, call.payload)
    } else {
      if (state.contribution.kind !== 'platform.adapter' || !active.request.accountId) {
        throw sandboxPermissionDenied('平台 Session 操作只允许已绑定的平台适配器')
      }
      const account = this.repository.listAccounts().find((item) => item.id === active.request.accountId)
      if (!account || (!active.allowUnboundAdapter && account.adapterContributionId !== state.contribution.id)) {
        throw sandboxPermissionDenied('平台适配器未绑定此账号')
      }
      if (!accountAllowed(active.request.accountId, grant, this.repository.listAccounts())) {
        throw sandboxPermissionDenied('平台适配器无权访问此账号')
      }
      if (call.operation === 'platform.getJson') {
        value = await this.platform.getJson({
          pluginId: identity.pluginId,
          contribution: state.contribution,
          accountId: active.request.accountId,
          endpointId: String(call.payload.endpointId),
          params: (call.payload.params ?? {}) as JsonObject
        })
      } else {
        value = await this.platform.captureJson({
          pluginId: identity.pluginId,
          pluginVersion: state.pluginVersion,
          contribution: state.contribution,
          accountId: active.request.accountId,
          captureId: String(call.payload.captureId),
          params: (call.payload.params ?? {}) as JsonObject,
          ...(typeof call.payload.limit === 'number' ? { limit: call.payload.limit } : {}),
          policy: active.capturePolicy
        })
      }
    }
    rememberHostResponse(active, call.operation, value)
    return value
  }

  private async networkCall(active: ActiveInvocation, grant: PluginGrant, payload: JsonObject): Promise<JsonValue> {
    const target = new URL(String(payload.url))
    if (!grant.networkOrigins.includes(target.origin)) throw sandboxPermissionDenied('插件网络目标未获授权')
    const headers = stringHeaders(payload.headers)
    const body = payload.body
    if (active.request.pluginId === 'streamfold.webhook') {
      this.injectWebhookCredentials(active, headers, body)
    }
    let response
    try {
      response = await this.https.request({
        url: target.href,
        method: payload.method === 'GET' ? 'GET' : 'POST',
        headers,
        ...(body === undefined ? {} : { jsonBody: body }),
        ...(typeof payload.timeoutMs === 'number' ? { timeoutMs: payload.timeoutMs } : {})
      })
    } catch (error) {
      const diagnostic = normalizePluginNetworkError(error, '插件 HTTPS 请求失败')
      active.recentHostResponses.push({ operation: 'network.https', diagnostic })
      if (active.recentHostResponses.length > 3) active.recentHostResponses.shift()
      throw diagnostic
    }
    return {
      status: response.status,
      contentType: response.contentType,
      body: response.body,
      retryAfter: response.retryAfter
    }
  }

  private injectWebhookCredentials(active: ActiveInvocation, headers: Record<string, string>, body: JsonValue | undefined): void {
    const config = this.host.getConfig(active.request.pluginId, active.request.contributionId).values
    const secrets = this.host.getRuntimeSecrets(active.request.pluginId, active.request.contributionId)
    if (config.authType === 'bearer' && secrets.authToken) headers.Authorization = `Bearer ${secrets.authToken}`
    if (config.authType === 'api-key' && secrets.authToken) {
      const name = typeof config.apiKeyHeader === 'string' ? config.apiKeyHeader : 'X-Api-Key'
      if (!/^[A-Za-z0-9-]{1,64}$/.test(name)) throw new Error('Webhook API Key 请求头名称无效')
      headers[name] = secrets.authToken
    }
    const timestamp = Math.floor(Date.now() / 1_000).toString()
    const eventId = active.request.event?.id ?? active.request.deliveryId ?? 'manual'
    const deliveryId = active.request.deliveryId ?? active.request.event?.id ?? randomUUID()
    headers['X-Streamfold-Event-Id'] = eventId
    headers['X-Streamfold-Delivery-Id'] = deliveryId
    headers['X-Streamfold-Timestamp'] = timestamp
    headers['Idempotency-Key'] = deliveryId
    if (secrets.hmacSecret) {
      const serialized = JSON.stringify(body ?? null)
      headers['X-Streamfold-Signature'] = `sha256=${createHmac('sha256', secrets.hmacSecret)
        .update(`${timestamp}.${serialized}`).digest('hex')}`
    }
  }

  private readData(active: ActiveInvocation, grant: PluginGrant, payload: JsonObject): JsonValue {
    const resource = String(payload.resource)
    const query = (payload.query ?? {}) as JsonObject
    const access = dataResourceAccess(resource)
    if (!active.contribution.contribution.permissions.includes(access.permission) ||
      !grant.permissions.includes(access.permission) || !grant.dataScopes.includes(access.scope)) {
      throw sandboxPermissionDenied('插件未获准读取此类数据')
    }
    if (Object.keys(query).some((key) => key !== 'accountId' && key !== 'limit')) {
      throw new Error('插件数据查询包含未知参数')
    }
    const requestedAccount = typeof query.accountId === 'string' ? query.accountId : active.request.accountId
    const allAccounts = this.repository.listAccounts()
    if (requestedAccount && !accountAllowed(requestedAccount, grant, allAccounts)) {
      throw sandboxPermissionDenied('插件无权访问此账号')
    }
    const accounts = allAccounts.filter((account) => (
      (!requestedAccount || account.id === requestedAccount) && accountAllowed(account.id, grant, allAccounts)
    ))
    if (resource === 'accounts' || resource === 'profiles') {
      return accounts.map((account) => sanitizeAccount(account, resource === 'profiles', grant)) as JsonValue
    }
    if (resource === 'contents') {
      const limit = integerLimit(query.limit, 100)
      return accounts.flatMap((account) => this.repository.listContents({ accountId: account.id, limit })
        .map((content) => sanitizeContent(content, grant))).slice(0, limit) as JsonValue
    }
    return accounts.flatMap((account) => this.repository.listAccountSnapshots(account.id)
      .map((snapshot) => ({ accountId: account.id, snapshot }))).slice(0, integerLimit(query.limit, 100)) as JsonValue
  }

  private requireContribution(
    pluginId: string,
    contributionId: string,
    sandboxHostCall = false
  ): PluginContributionState {
    const state = this.host.listContributions().find((item) => (
      item.pluginId === pluginId && item.contribution.id === contributionId
    ))
    if (!state?.enabled || state.suspendedReason) {
      if (sandboxHostCall) throw sandboxPermissionDenied('插件贡献点未启用')
      throw new Error('插件贡献点未启用')
    }
    return state
  }

  private requireGrant(
    pluginId: string,
    contributionId: string,
    contribution: PluginContribution,
    sandboxHostCall = false
  ): PluginGrant {
    const grant = this.repository.getPluginGrant(pluginId, contributionId)
    if (!grant || grant.permissions.some((permission) => !contribution.permissions.includes(permission))) {
      if (sandboxHostCall) throw sandboxPermissionDenied('插件贡献点尚未授权或授权已失效')
      throw new Error('插件贡献点尚未授权或授权已失效')
    }
    return grant
  }
}

interface PluginExecutionDiagnosticContext {
  pluginId: string
  pluginVersion: string
  contributionId: string
  entry: string
  method: string
  entrySource: string
}

function enrichPluginExecutionFailure(
  error: unknown,
  context: PluginExecutionDiagnosticContext
): unknown {
  if (!(error instanceof Error)) return error
  const sandboxFailure = isDiagnosableSandboxError(error)
  const diagnostic = formatSandboxDiagnostic(error)
  const location = diagnostic ? pluginEntryLocation(diagnostic, context) : null
  const sourceExcerpt = location ? pluginSourceExcerpt(context.entrySource, location.entryLine) : ''
  const details = sanitizeSandboxDiagnostic([
    `插件：${context.pluginId}`,
    `插件版本：${context.pluginVersion}`,
    `贡献点：${context.contributionId}`,
    `入口：${context.entry}`,
    `执行方法：${context.method}`,
    ...(location ? [
      ...(location.functionName ? [`插件函数：${location.functionName}`] : []),
      `源码位置：${context.entry}:${location.entryLine}:${location.column}`,
      `沙箱位置：${location.sandboxLocation}`,
      `插件调用链\n${location.frames.map((frame, index) => (
        `${index + 1}. ${frame.functionName || '<anonymous>'} @ ${context.entry}:${frame.entryLine}:${frame.column}`
      )).join('\n')}`
    ] : []),
    ...(sourceExcerpt ? [`源码上下文\n${sourceExcerpt}`] : []),
    ...(diagnostic ? [`${sandboxFailure ? '沙箱错误' : '执行错误'}\n${diagnostic}`] : [])
  ].join('\n\n'))
  if (!details) return error
  if (sandboxFailure) {
    const cause = executionDiagnosticCause(error.cause, details)
    return new PluginSupplyChainError(error.code, error.message, { cause })
  }
  const diagnosticCause = new Error(details)
  diagnosticCause.name = 'PluginExecutionDiagnostic'
  const originalCause = ownDataProperty(error, 'cause')
  const cause = originalCause === undefined
    ? diagnosticCause
    : new AggregateError([originalCause, diagnosticCause], '插件执行诊断')
  Object.defineProperty(error, 'cause', {
    value: cause,
    configurable: true,
    enumerable: false,
    writable: true
  })
  return error
}

function attachRecentHostResponses(
  error: unknown,
  responses: ActiveInvocation['recentHostResponses']
): unknown {
  if (!(error instanceof Error) || responses.length === 0) return error
  const existingCause = ownDataProperty(error, 'cause')
  const causes = [
    ...(existingCause === undefined ? [] : [existingCause]),
    ...responses.map((response) => response.diagnostic)
  ]
  const cause = causes.length === 1
    ? causes[0]
    : new AggregateError(causes, '插件执行前的最近宿主响应')
  Object.defineProperty(error, 'cause', {
    value: cause,
    configurable: true,
    enumerable: false,
    writable: true
  })
  return error
}

function rememberHostResponse(
  active: ActiveInvocation,
  operation: SandboxHostOperation,
  value: JsonValue
): void {
  let status: unknown = null
  let contentType: unknown = 'application/json'
  let body = ''
  if (operation === 'network.https' && value && typeof value === 'object' && !Array.isArray(value)) {
    status = value.status
    contentType = value.contentType
    body = typeof value.body === 'string' ? value.body : JSON.stringify(value)
  } else {
    body = JSON.stringify(value)
  }
  active.recentHostResponses.push({
    operation,
    diagnostic: pluginNetworkResponseError(`插件宿主响应快照：${operation}`, {
      status,
      contentType,
      body
    })
  })
  if (active.recentHostResponses.length > 3) active.recentHostResponses.shift()
}

function platformSessionIssue(error: unknown): 'expired' | 'risk' | null {
  const queue: unknown[] = [error]
  const visited = new Set<object>()
  for (let index = 0; index < queue.length && index < 32; index += 1) {
    const current = queue[index]
    if (!current || (typeof current !== 'object' && typeof current !== 'function')) continue
    if (visited.has(current as object)) continue
    visited.add(current as object)
    const message = ownDataProperty(current, 'message')
    if (typeof message === 'string') {
      if (message.includes('平台登录状态已失效')) return 'expired'
      if (message.includes('平台请求暂时受限')) return 'risk'
    }
    const cause = ownDataProperty(current, 'cause')
    if (cause !== undefined) queue.push(cause)
    const errors = ownDataProperty(current, 'errors')
    if (Array.isArray(errors)) queue.push(...errors.slice(0, 8))
  }
  return null
}

function ownDataProperty(value: unknown, key: string): unknown {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) return undefined
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor && 'value' in descriptor ? descriptor.value : undefined
  } catch {
    return undefined
  }
}

function executionDiagnosticCause(originalCause: unknown, details: string): Error {
  if (originalCause !== undefined) return new AggregateError([originalCause], details)
  const cause = new Error(details)
  cause.name = 'PluginExecutionDiagnostic'
  return cause
}

const DIAGNOSABLE_SANDBOX_CODES: ReadonlySet<PluginSupplyChainErrorCode> = new Set([
  'PLUGIN_SANDBOX_PROTOCOL_INVALID',
  'PLUGIN_SANDBOX_PERMISSION_DENIED',
  'PLUGIN_SANDBOX_RESOURCE_LIMIT',
  'PLUGIN_SANDBOX_CRASHED',
  'PLUGIN_SANDBOX_FAILED'
])

function isDiagnosableSandboxError(error: unknown): error is PluginSupplyChainError {
  return isPluginSupplyChainError(error) && DIAGNOSABLE_SANDBOX_CODES.has(error.code)
}

function sandboxPermissionDenied(message: string): PluginSupplyChainError {
  return new PluginSupplyChainError('PLUGIN_SANDBOX_PERMISSION_DENIED', message)
}

function pluginEntryLocation(
  diagnostic: string,
  context: Pick<PluginExecutionDiagnosticContext, 'pluginId' | 'contributionId'>
): {
  entryLine: number
  column: number
  functionName: string
  sandboxLocation: string
  frames: Array<{ entryLine: number; column: number; functionName: string }>
} | null {
  const filename = `streamfold:${context.pluginId}/${context.contributionId}.js`
  const escapedFilename = escapeRegExp(filename)
  const stackFramePattern = new RegExp(
    `(?:^|\\n)\\s*at\\s+(?:(.*?)\\s+\\()?${escapedFilename}:(\\d+):(\\d+)\\)?`,
    'g'
  )
  const parsedFrames = [...diagnostic.matchAll(stackFramePattern)].map((match) => ({
    functionName: normalizePluginFunctionName(match[1] ?? ''),
    generatedLine: Number(match[2]),
    column: Number(match[3])
  })).filter((frame) => (
    Number.isSafeInteger(frame.generatedLine) && Number.isSafeInteger(frame.column)
  ))
  const frames = parsedFrames.filter((frame, index) => (
    parsedFrames.findIndex((candidate) => (
      candidate.functionName === frame.functionName &&
      candidate.generatedLine === frame.generatedLine &&
      candidate.column === frame.column
    )) === index
  )).slice(0, 6)
  if (frames.length === 0) return null
  const frame = frames.find((candidate) => !isGenericFailureFrame(candidate.functionName)) ?? frames[0]
  const generatedLine = frame?.generatedLine
  const column = frame?.column
  if (generatedLine === undefined || column === undefined ||
    !Number.isSafeInteger(generatedLine) || !Number.isSafeInteger(column)) return null
  return {
    entryLine: Math.max(1, generatedLine - 6),
    column: Math.max(1, column),
    functionName: frame?.functionName ?? '',
    sandboxLocation: `${filename}:${generatedLine}:${column}`,
    frames: frames.map((candidate) => ({
      entryLine: Math.max(1, candidate.generatedLine - 6),
      column: Math.max(1, candidate.column),
      functionName: candidate.functionName
    }))
  }
}

function normalizePluginFunctionName(value: string): string {
  return value.trim().replace(/^(?:async|new)\s+/u, '')
}

function isGenericFailureFrame(functionName: string): boolean {
  const leaf = functionName.split('.').at(-1)?.replace(/^\[as\s+|\]$/gu, '') ?? ''
  return /^(?:assert.*|array|boolean|count|date|exactKeys|fail|failure|handle|id|integer|invalid|invariant|malformed|number|object|optionalString|panic|raise|record|required|string|text|throwError|url|value)$/iu.test(leaf)
}

function pluginSourceExcerpt(source: string, targetLine: number): string {
  const lines = source.split(/\r?\n/)
  if (targetLine < 1 || targetLine > lines.length) return ''
  const start = Math.max(1, targetLine - 2)
  const end = Math.min(lines.length, targetLine + 2)
  const width = String(end).length
  return lines.slice(start - 1, end).map((line, index) => {
    const lineNumber = start + index
    return `${lineNumber === targetLine ? '>' : ' '} ${String(lineNumber).padStart(width, ' ')} | ${line}`
  }).join('\n')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function dataResourceAccess(resource: string): {
  permission: Extract<PluginGrant['permissions'][number], 'accounts.read' | 'profiles.read' | 'contents.read' | 'metrics.read'>
  scope: PluginGrant['dataScopes'][number]
} {
  if (resource === 'accounts') return { permission: 'accounts.read', scope: 'account' }
  if (resource === 'profiles') return { permission: 'profiles.read', scope: 'profile' }
  if (resource === 'contents') return { permission: 'contents.read', scope: 'content' }
  if (resource === 'metrics') return { permission: 'metrics.read', scope: 'metrics' }
  throw new Error('插件请求了未知数据类型')
}

function contributionMethod(contribution: PluginContribution, trigger: PluginExecutionRequest['trigger']): string {
  if (contribution.kind === 'event.handler') return 'handle'
  if (contribution.kind === 'platform.adapter') return trigger === 'manual' ? 'collect' : 'collect'
  return 'run'
}

function invocationInput(request: PluginExecutionRequest): JsonValue {
  return request.event ? structuredClone(request.event) as unknown as JsonValue : { accountId: request.accountId }
}

function allowedOperations(contribution: PluginContribution, grant: PluginGrant): SandboxHostOperation[] {
  const allowed = new Set(grant.permissions.filter((permission) => contribution.permissions.includes(permission)))
  const operations: SandboxHostOperation[] = []
  if (allowed.has('platform.session-json') && contribution.kind === 'platform.adapter') {
    operations.push('platform.getJson', 'platform.captureJson')
  }
  if ([...allowed].some((permission) => permission === 'accounts.read' || permission === 'profiles.read' ||
    permission === 'contents.read' || permission === 'metrics.read')) operations.push('data.read')
  if (allowed.has('network.https')) operations.push('network.https')
  return operations
}

function accountAllowed(accountId: string, grant: PluginGrant, accounts: Account[]): boolean {
  if (grant.accountIds.includes(accountId)) return true
  return accounts.some((account) => account.id === accountId &&
    account.groupIds.some((groupId) => grant.groupIds.includes(groupId)))
}

function stringHeaders(value: JsonValue | undefined): Record<string, string> {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('插件请求头无效')
  const result: Record<string, string> = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') throw new Error('插件请求头无效')
    result[key] = item
  }
  return result
}

function sanitizeAccount(account: Account, profile: boolean, grant: PluginGrant): JsonObject {
  const base: JsonObject = {
    id: account.id,
    platformId: account.platformId,
    remoteId: account.remoteId,
    remoteName: account.remoteName
  }
  if (grant.dataScopes.includes('account')) {
    base.alias = account.alias
    base.groupIds = account.groupIds
    base.tags = account.tags
  }
  if (profile && grant.dataScopes.includes('profile')) {
    base.bio = account.bio
    base.avatarUrl = account.avatarUrl
    base.creatorLevel = account.creatorLevel
  }
  if (grant.dataScopes.includes('metrics')) base.latestSnapshot = account.latestSnapshot as JsonValue
  return base
}

function sanitizeContent(content: ContentSummary, grant: PluginGrant): JsonObject {
  const result: JsonObject = {
    id: content.id,
    accountId: content.accountId,
    platformId: content.platformId,
    remoteId: content.remoteId,
    type: content.type,
    title: content.title,
    bodyExcerpt: content.bodyExcerpt,
    url: content.url,
    publishedAt: content.publishedAt
  }
  if (grant.dataScopes.includes('account')) result.accountAlias = content.accountAlias
  if (grant.dataScopes.includes('content')) {
    result.note = content.note
    result.tags = content.tags
  }
  if (grant.dataScopes.includes('metrics')) result.latestSnapshot = content.latestSnapshot as JsonValue
  return result
}

function integerLimit(value: JsonValue | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value)
    ? Math.max(1, Math.min(100, value))
    : fallback
}

function validateWebhookResult(pluginId: string, value: Record<string, JsonValue>): void {
  if (pluginId !== 'streamfold.webhook' || typeof value.status !== 'number') return
  const status = value.status
  if (status >= 200 && status < 300) return
  if (status === 408 || status === 425 || status === 429 || status >= 500) {
    throw new RetryablePluginError('WEBHOOK_RETRYABLE_HTTP', `Webhook 返回 HTTP ${status}`, retryAfterMs(value.retryAfter))
  }
  throw new Error(`Webhook 返回 HTTP ${status}`)
}

function retryAfterMs(value: JsonValue | undefined): number | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1_000, 24 * 60 * 60 * 1_000)
  const date = Date.parse(value)
  return Number.isFinite(date) ? Math.max(0, Math.min(date - Date.now(), 24 * 60 * 60 * 1_000)) : null
}
