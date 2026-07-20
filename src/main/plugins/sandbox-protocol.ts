import { PluginSupplyChainError } from './supply-chain-errors'

export type JsonPrimitive = null | boolean | number | string
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }
export type JsonObject = { [key: string]: JsonValue }

export const sandboxHostOperations = [
  'platform.getJson',
  'platform.captureJson',
  'data.read',
  'network.https'
] as const
export type SandboxHostOperation = (typeof sandboxHostOperations)[number]

export const DEFAULT_SANDBOX_LIMITS: SandboxLimits = Object.freeze({
  memoryBytes: 64 * 1024 * 1024,
  cpuTimeoutMs: 5_000,
  totalTimeoutMs: 120_000,
  maxRpcBytes: 2 * 1024 * 1024
})

export const MAX_SANDBOX_ENTRY_BYTES = 2 * 1024 * 1024
const MAX_JSON_DEPTH = 32
const MAX_JSON_ENTRIES = 10_000
// Platform captures are host-mediated, manifest- and byte-bounded JSON. Real
// GraphQL timelines can be dense across a full 2 MiB RPC, so allow 256K object
// keys plus array items while retaining a separate cap for pathological shapes.
// Non-platform host operations and guest-controlled RPC remain on the lower
// MAX_JSON_ENTRIES budget.
export const MAX_SANDBOX_PLATFORM_RESPONSE_ENTRIES = 256 * 1024
const IDENTIFIER = /^[a-z0-9](?:[a-z0-9._-]{1,126}[a-z0-9])?$/
const INVOCATION_ID = /^[A-Za-z0-9_-]{8,128}$/
const METHOD = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/

export interface SandboxLimits {
  memoryBytes: number
  cpuTimeoutMs: number
  totalTimeoutMs: number
  maxRpcBytes: number
}

export interface SandboxInvocationRequest {
  protocolVersion: 1
  type: 'invoke'
  invocationId: string
  pluginId: string
  contributionId: string
  entrySource: string
  method: string
  input: JsonValue
  context: JsonObject
  allowedOperations: SandboxHostOperation[]
  limits: SandboxLimits
}

export interface SandboxReadyMessage {
  protocolVersion: 1
  type: 'ready'
}

export interface SandboxHostCallMessage {
  protocolVersion: 1
  type: 'host-call'
  invocationId: string
  callId: string
  operation: SandboxHostOperation
  payload: JsonObject
}

export interface SandboxHostResultMessage {
  protocolVersion: 1
  type: 'host-result'
  invocationId: string
  callId: string
  ok: boolean
  value?: JsonValue
  error?: SandboxErrorPayload
}

export interface SandboxResultMessage {
  protocolVersion: 1
  type: 'result'
  invocationId: string
  value: JsonValue
}

export interface SandboxErrorMessage {
  protocolVersion: 1
  type: 'error'
  invocationId: string
  error: SandboxErrorPayload
}

export interface SandboxErrorPayload {
  code: string
  message: string
  details?: string
  originCallId?: string
}

export type SandboxParentToChildMessage = SandboxInvocationRequest | SandboxHostResultMessage
export type SandboxChildToParentMessage =
  | SandboxReadyMessage
  | SandboxHostCallMessage
  | SandboxResultMessage
  | SandboxErrorMessage

export function parseSandboxInvocationRequest(value: unknown): SandboxInvocationRequest {
  const record = objectValue(value)
  exactKeys(record, [
    'protocolVersion', 'type', 'invocationId', 'pluginId', 'contributionId', 'entrySource',
    'method', 'input', 'context', 'allowedOperations', 'limits'
  ])
  if (record.protocolVersion !== 1 || record.type !== 'invoke') invalidProtocol()
  const invocationId = invocationIdentifier(record.invocationId)
  const pluginId = identifier(record.pluginId)
  const contributionId = identifier(record.contributionId)
  if (typeof record.entrySource !== 'string' || record.entrySource.length === 0 ||
      Buffer.byteLength(record.entrySource, 'utf8') > MAX_SANDBOX_ENTRY_BYTES || record.entrySource.includes('\0')) {
    invalidProtocol()
  }
  if (typeof record.method !== 'string' || !METHOD.test(record.method)) invalidProtocol()
  assertJsonValue(record.input)
  const context = objectValue(record.context) as JsonObject
  assertJsonValue(context)
  if (!Array.isArray(record.allowedOperations)) invalidProtocol()
  const allowedOperations = record.allowedOperations.map((operation) => {
    if (typeof operation !== 'string' || !sandboxHostOperations.includes(operation as SandboxHostOperation)) invalidProtocol()
    return operation as SandboxHostOperation
  })
  if (new Set(allowedOperations).size !== allowedOperations.length) invalidProtocol()
  const limits = parseLimits(record.limits)
  return {
    protocolVersion: 1,
    type: 'invoke',
    invocationId,
    pluginId,
    contributionId,
    entrySource: record.entrySource,
    method: record.method,
    input: record.input as JsonValue,
    context,
    allowedOperations,
    limits
  }
}

export function parseSandboxChildMessage(value: unknown): SandboxChildToParentMessage {
  const record = objectValue(value)
  if (record.protocolVersion !== 1 || typeof record.type !== 'string') invalidProtocol()
  if (record.type === 'ready') {
    exactKeys(record, ['protocolVersion', 'type'])
    return { protocolVersion: 1, type: 'ready' }
  }
  if (record.type === 'host-call') {
    exactKeys(record, ['protocolVersion', 'type', 'invocationId', 'callId', 'operation', 'payload'])
    const operation = hostOperation(record.operation)
    const payload = objectValue(record.payload) as JsonObject
    assertHostCallPayload(operation, payload)
    return {
      protocolVersion: 1,
      type: 'host-call',
      invocationId: invocationIdentifier(record.invocationId),
      callId: invocationIdentifier(record.callId),
      operation,
      payload
    }
  }
  if (record.type === 'result') {
    exactKeys(record, ['protocolVersion', 'type', 'invocationId', 'value'])
    assertJsonValue(record.value)
    return {
      protocolVersion: 1,
      type: 'result',
      invocationId: invocationIdentifier(record.invocationId),
      value: record.value as JsonValue
    }
  }
  if (record.type === 'error') {
    exactKeys(record, ['protocolVersion', 'type', 'invocationId', 'error'])
    return {
      protocolVersion: 1,
      type: 'error',
      invocationId: invocationIdentifier(record.invocationId),
      error: parseErrorPayload(record.error)
    }
  }
  invalidProtocol()
}

export function parseSandboxHostResult(value: unknown): SandboxHostResultMessage {
  const record = objectValue(value)
  exactKeys(record, ['protocolVersion', 'type', 'invocationId', 'callId', 'ok', 'value', 'error'])
  if (record.protocolVersion !== 1 || record.type !== 'host-result' || typeof record.ok !== 'boolean') invalidProtocol()
  const base = {
    protocolVersion: 1 as const,
    type: 'host-result' as const,
    invocationId: invocationIdentifier(record.invocationId),
    callId: invocationIdentifier(record.callId)
  }
  if (record.ok) {
    if (record.error !== undefined || record.value === undefined) invalidProtocol()
    assertPlatformResponseJsonValue(record.value)
    return { ...base, ok: true, value: record.value as JsonValue }
  }
  if (record.value !== undefined || record.error === undefined) invalidProtocol()
  return { ...base, ok: false, error: parseErrorPayload(record.error) }
}

export function assertHostCallPayload(operation: SandboxHostOperation, payload: JsonObject): void {
  assertJsonValue(payload)
  if (operation === 'platform.getJson') {
    exactKeys(payload, ['endpointId', 'params'])
    identifier(payload.endpointId)
    if (payload.params !== undefined) objectValue(payload.params)
    return
  }
  if (operation === 'platform.captureJson') {
    exactKeys(payload, ['captureId', 'params', 'limit'])
    identifier(payload.captureId)
    if (payload.params !== undefined) objectValue(payload.params)
    if (payload.limit !== undefined && (!Number.isSafeInteger(payload.limit) || (payload.limit as number) < 1 || (payload.limit as number) > 100)) {
      invalidProtocol()
    }
    return
  }
  if (operation === 'data.read') {
    exactKeys(payload, ['resource', 'query'])
    if (!['accounts', 'profiles', 'contents', 'metrics'].includes(String(payload.resource))) invalidProtocol()
    if (payload.query !== undefined) objectValue(payload.query)
    return
  }
  exactKeys(payload, ['url', 'method', 'headers', 'body', 'timeoutMs'])
  validateOutboundUrl(payload.url)
  if (payload.method !== 'GET' && payload.method !== 'POST') invalidProtocol()
  if (payload.method === 'GET' && payload.body !== undefined) invalidProtocol()
  if (payload.headers !== undefined) validateOutboundHeaders(payload.headers)
  if (payload.body !== undefined) assertJsonValue(payload.body)
  if (payload.timeoutMs !== undefined &&
      (!Number.isSafeInteger(payload.timeoutMs) || (payload.timeoutMs as number) < 1_000 || (payload.timeoutMs as number) > 30_000)) {
    invalidProtocol()
  }
}

export function jsonByteLength(value: JsonValue | JsonObject): number {
  assertJsonValue(value)
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

export function assertJsonValue(value: unknown): asserts value is JsonValue {
  assertJsonValueWithin(value, MAX_JSON_ENTRIES, invalidProtocol)
}

export function hostResponseJsonByteLength(
  operation: SandboxHostOperation,
  value: JsonValue | JsonObject
): number {
  if (operation !== 'platform.getJson' && operation !== 'platform.captureJson') {
    return jsonByteLength(value)
  }
  assertPlatformResponseJsonValue(value)
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

function assertPlatformResponseJsonValue(value: unknown): asserts value is JsonValue {
  assertJsonValueWithin(value, MAX_SANDBOX_PLATFORM_RESPONSE_ENTRIES, hostResponseLimitExceeded)
}

function assertJsonValueWithin(
  value: unknown,
  maximumEntries: number,
  limitExceeded: () => never
): asserts value is JsonValue {
  const state = { entries: 0, seen: new Set<object>(), maximumEntries, limitExceeded }
  visitJson(value, 0, state)
}

function visitJson(
  value: unknown,
  depth: number,
  state: {
    entries: number
    seen: Set<object>
    maximumEntries: number
    limitExceeded: () => never
  }
): void {
  if (depth > MAX_JSON_DEPTH) state.limitExceeded()
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalidProtocol()
    return
  }
  if (!value || typeof value !== 'object') invalidProtocol()
  if (state.seen.has(value)) invalidProtocol()
  state.seen.add(value)
  try {
    const prototype = Object.getPrototypeOf(value)
    if (Array.isArray(value)) {
      if (prototype !== Array.prototype) invalidProtocol()
      if (value.length > state.maximumEntries - state.entries) state.limitExceeded()
      const ownKeys = Reflect.ownKeys(value)
      if (ownKeys.length !== value.length + 1 || ownKeys.some((key) => {
        if (key === 'length') return false
        if (typeof key !== 'string' || !/^(?:0|[1-9]\d*)$/.test(key)) return true
        const index = Number(key)
        return !Number.isSafeInteger(index) || index >= value.length || String(index) !== key
      })) invalidProtocol()
      state.entries += value.length
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        if (!descriptor?.enumerable || !('value' in descriptor)) invalidProtocol()
        visitJson(descriptor.value, depth + 1, state)
      }
      return
    }
    if (prototype !== Object.prototype && prototype !== null) invalidProtocol()
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') invalidProtocol()
      state.entries += 1
      if (state.entries > state.maximumEntries) state.limitExceeded()
      if (key.length > 256 || /[\u0000-\u001f\u007f]/u.test(key)) invalidProtocol()
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor?.enumerable || !('value' in descriptor)) invalidProtocol()
      visitJson(descriptor.value, depth + 1, state)
    }
  } finally {
    state.seen.delete(value)
  }
}

function parseLimits(value: unknown): SandboxLimits {
  const record = objectValue(value)
  exactKeys(record, ['memoryBytes', 'cpuTimeoutMs', 'totalTimeoutMs', 'maxRpcBytes'])
  const memoryBytes = boundedInteger(record.memoryBytes, 8 * 1024 * 1024, DEFAULT_SANDBOX_LIMITS.memoryBytes)
  const cpuTimeoutMs = boundedInteger(record.cpuTimeoutMs, 10, DEFAULT_SANDBOX_LIMITS.cpuTimeoutMs)
  const totalTimeoutMs = boundedInteger(record.totalTimeoutMs, cpuTimeoutMs, DEFAULT_SANDBOX_LIMITS.totalTimeoutMs)
  const maxRpcBytes = boundedInteger(record.maxRpcBytes, 1_024, DEFAULT_SANDBOX_LIMITS.maxRpcBytes)
  return { memoryBytes, cpuTimeoutMs, totalTimeoutMs, maxRpcBytes }
}

function validateOutboundUrl(value: unknown): void {
  if (typeof value !== 'string' || value.length > 2_048) invalidProtocol()
  let url: URL
  try {
    url = new URL(value)
  } catch {
    invalidProtocol()
  }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.hash) invalidProtocol()
}

function validateOutboundHeaders(value: unknown): void {
  const headers = objectValue(value)
  const forbidden = new Set(['authorization', 'cookie', 'proxy-authorization', 'host', 'connection', 'content-length'])
  if (Object.keys(headers).length > 32) invalidProtocol()
  for (const [name, headerValue] of Object.entries(headers)) {
    if (!/^[a-z0-9-]{1,64}$/.test(name) || forbidden.has(name) || typeof headerValue !== 'string' ||
        headerValue.length > 2_048 || /[\r\n\0]/.test(headerValue)) invalidProtocol()
  }
}

function parseErrorPayload(value: unknown): SandboxErrorPayload {
  const record = objectValue(value)
  exactKeys(record, ['code', 'message', 'details', 'originCallId'])
  if (typeof record.code !== 'string' || !/^[A-Z][A-Z0-9_]{2,63}$/.test(record.code) ||
      typeof record.message !== 'string' || record.message.length === 0 || record.message.length > 300 ||
      /[\u0000-\u001f\u007f]/u.test(record.message)) invalidProtocol()
  if (record.details !== undefined && (typeof record.details !== 'string' ||
      record.details.length === 0 || record.details.length > 16_000 || /\0/u.test(record.details))) invalidProtocol()
  return {
    code: record.code,
    message: record.message,
    ...(typeof record.details === 'string' ? { details: record.details } : {}),
    ...(record.originCallId === undefined
      ? {}
      : { originCallId: invocationIdentifier(record.originCallId) })
  }
}

function hostOperation(value: unknown): SandboxHostOperation {
  if (typeof value !== 'string' || !sandboxHostOperations.includes(value as SandboxHostOperation)) invalidProtocol()
  return value as SandboxHostOperation
}

function identifier(value: unknown): string {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) invalidProtocol()
  return value
}

function invocationIdentifier(value: unknown): string {
  if (typeof value !== 'string' || !INVOCATION_ID.test(value)) invalidProtocol()
  return value
}

function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalidProtocol()
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) invalidProtocol()
  return value as Record<string, unknown>
}

function exactKeys(record: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed)
  if (Object.keys(record).some((key) => !allowedSet.has(key))) invalidProtocol()
}

function boundedInteger(value: unknown, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) invalidProtocol()
  return value as number
}

function invalidProtocol(): never {
  throw new PluginSupplyChainError('PLUGIN_SANDBOX_PROTOCOL_INVALID', '插件沙箱消息无效')
}

function hostResponseLimitExceeded(): never {
  throw new PluginSupplyChainError('PLUGIN_SANDBOX_RESOURCE_LIMIT', '宿主响应结构超过大小限制')
}
