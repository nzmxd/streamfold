import { isSensitiveBackgroundFieldName } from '../../shared/plugin-host-contracts'
import { sanitizeSandboxDiagnostic } from './sandbox-diagnostics'

const MAX_RESPONSE_BODY_LENGTH = 8 * 1024
const MAX_RESPONSE_SOURCE_LENGTH = 64 * 1024
const MAX_TRANSPORT_SUMMARY_LENGTH = 2 * 1024
const MAX_VALUE_STRING_LENGTH = 2 * 1024
const MAX_DEPTH = 5
const MAX_OBJECT_KEYS = 24
const MAX_ARRAY_ITEMS = 12
const MAX_NODES = 160

export interface PluginNetworkResponseDiagnosticInput {
  status: unknown
  contentType: unknown
  body: string | Buffer
  responseBytes?: number
}

interface ProjectedText {
  text: string | null
  truncated: boolean
}

interface ProjectionBudget {
  nodes: number
  truncated: boolean
}

export class PluginNetworkDiagnosticError extends Error {
  readonly status: number | null
  readonly contentType: string
  readonly apiError: string | null
  readonly responseBody: string | null
  readonly responseBytes: number
  readonly truncated: boolean

  constructor(
    message: string,
    diagnostic: {
      status: number | null
      contentType: string
      apiError: string | null
      responseBody: string | null
      responseBytes: number
      truncated: boolean
    }
  ) {
    super(message)
    this.name = 'PluginNetworkDiagnosticError'
    this.status = diagnostic.status
    this.contentType = diagnostic.contentType
    this.apiError = diagnostic.apiError
    this.responseBody = diagnostic.responseBody
    this.responseBytes = diagnostic.responseBytes
    this.truncated = diagnostic.truncated
  }
}

export function pluginNetworkResponseError(
  message: string,
  input: PluginNetworkResponseDiagnosticInput
): PluginNetworkDiagnosticError {
  const projectedBytes = Buffer.isBuffer(input.body)
    ? input.body.byteLength
    : Buffer.byteLength(input.body, 'utf8')
  const bytes = Number.isSafeInteger(input.responseBytes) && input.responseBytes! >= 0
    ? input.responseBytes!
    : projectedBytes
  const source = Buffer.isBuffer(input.body)
    ? input.body.subarray(0, MAX_RESPONSE_SOURCE_LENGTH).toString('utf8')
    : input.body.slice(0, MAX_RESPONSE_SOURCE_LENGTH)
  const sourceTruncated = bytes !== projectedBytes || (Buffer.isBuffer(input.body)
    ? input.body.byteLength > MAX_RESPONSE_SOURCE_LENGTH
    : input.body.length > MAX_RESPONSE_SOURCE_LENGTH)
  const parsed = parseJson(source)
  const projectedError = parsed === undefined ? null : projectApiError(parsed)
  const projectedBody = !projectedError?.text ? projectResponseBody(source, parsed) : null
  return new PluginNetworkDiagnosticError(message, {
    status: safeStatus(input.status),
    contentType: safeContentType(input.contentType),
    apiError: projectedError?.text ?? null,
    responseBody: projectedBody?.text ?? null,
    responseBytes: bytes,
    truncated: sourceTruncated || Boolean(projectedError?.truncated) || Boolean(projectedBody?.truncated)
  })
}

export function normalizePluginNetworkError(
  error: unknown,
  message: string
): PluginNetworkDiagnosticError {
  if (error instanceof PluginNetworkDiagnosticError) return error
  const summary = transportSummary(error)
  return new PluginNetworkDiagnosticError(platformSessionMessage(summary.text ?? '') ?? message, {
    status: null,
    contentType: '',
    apiError: summary.text,
    responseBody: null,
    responseBytes: 0,
    truncated: summary.truncated
  })
}

export function hasPluginApiError(value: unknown): boolean {
  const record = plainRecord(value)
  if (!record) return false
  if (meaningfulError(record.error) || meaningfulError(record.errors)) return true
  if (record.success === false || record.ok === false) {
    return ['code', 'message', 'msg', 'detail', 'reason'].some((key) => meaningfulError(record[key]))
  }
  const code = firstDefined(record, ['error_code', 'errorCode', 'errcode', 'errno', 'code'])
  const apiMessage = firstDefined(record, ['message', 'msg', 'detail', 'reason'])
  if (isFailureCode(code) && meaningfulError(apiMessage)) return true
  return false
}

function projectApiError(value: unknown): ProjectedText {
  if (!hasPluginApiError(value)) return { text: null, truncated: false }
  const record = plainRecord(value)!
  const candidate: Record<string, unknown> = {}
  for (const key of [
    'error', 'errors', 'success', 'ok', 'error_code', 'errorCode', 'errcode', 'errno',
    'code', 'message', 'msg', 'detail', 'reason'
  ]) {
    if (Object.prototype.hasOwnProperty.call(record, key)) candidate[key] = record[key]
  }
  return projectText(candidate)
}

function projectResponseBody(source: string, parsed: unknown): ProjectedText {
  if (!source) return { text: null, truncated: false }
  if (parsed !== undefined) return projectText(parsed)
  const sanitized = sanitizeResponseText(source)
  if (!sanitized) return { text: null, truncated: false }
  return {
    text: sanitized.slice(0, MAX_RESPONSE_BODY_LENGTH),
    truncated: sanitized.length > MAX_RESPONSE_BODY_LENGTH
  }
}

function projectText(value: unknown): ProjectedText {
  const budget: ProjectionBudget = { nodes: MAX_NODES, truncated: false }
  const projected = projectValue(value, 0, budget)
  let serialized = ''
  try {
    serialized = JSON.stringify(projected, null, 2)
  } catch {
    serialized = '[Unavailable response diagnostic]'
    budget.truncated = true
  }
  const sanitized = sanitizeResponseText(serialized)
  return {
    text: sanitized ? sanitized.slice(0, MAX_RESPONSE_BODY_LENGTH) : null,
    truncated: budget.truncated || sanitized.length > MAX_RESPONSE_BODY_LENGTH
  }
}

function projectValue(value: unknown, depth: number, budget: ProjectionBudget): unknown {
  if (budget.nodes <= 0) {
    budget.truncated = true
    return '[Diagnostic budget exhausted]'
  }
  budget.nodes -= 1
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value)
  if (typeof value === 'string') {
    const text = sanitizeResponseText(value)
    if (text.length > MAX_VALUE_STRING_LENGTH) budget.truncated = true
    return text.slice(0, MAX_VALUE_STRING_LENGTH)
  }
  if (typeof value !== 'object' || depth >= MAX_DEPTH) {
    if (depth >= MAX_DEPTH) budget.truncated = true
    return `[${typeof value === 'object' ? 'Maximum depth reached' : typeof value}]`
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY_ITEMS) budget.truncated = true
    return value.slice(0, MAX_ARRAY_ITEMS).map((item) => projectValue(item, depth + 1, budget))
  }
  const record = plainRecord(value)
  if (!record) return '[Unavailable object]'
  const keys = Object.keys(record)
  if (keys.length > MAX_OBJECT_KEYS) budget.truncated = true
  const result: Record<string, unknown> = {}
  for (const key of keys.slice(0, MAX_OBJECT_KEYS)) {
    const cleanKey = sanitizeResponseText(key).replace(/\s+/gu, ' ').slice(0, 120)
    if (!cleanKey) continue
    result[cleanKey] = isSensitiveKey(key)
      ? '[REDACTED]'
      : projectValue(record[key], depth + 1, budget)
  }
  return result
}

function sanitizeResponseText(value: string): string {
  return sanitizeSandboxDiagnostic(value)
}

function sanitizeTransportText(value: string): string {
  const withoutUrls = value.replace(/https?:\/\/[^\s"'<>\])}]+/giu, '[REDACTED_URL]')
  const withoutMetadata = withoutUrls
    .replace(/(^|\n)[ \t]*(?:authorization|cookie|set-cookie|content-type|user-agent|host|referer|origin|x-[a-z0-9-]+)\s*:[^\r\n]*/giu, '$1[REDACTED_HEADER]')
    .replace(/\b(?:headers?|query(?:string)?|params?)\b\s*[:=]\s*[^\r\n]+/giu, '[REDACTED_METADATA]')
  return sanitizeSandboxDiagnostic(withoutMetadata)
}

function transportSummary(error: unknown): ProjectedText {
  let value = ''
  if (typeof error === 'string') value = error
  else if (error && typeof error === 'object') {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(error, 'message')
      if (descriptor && 'value' in descriptor && typeof descriptor.value === 'string') value = descriptor.value
    } catch {}
  }
  const source = value.slice(0, MAX_RESPONSE_SOURCE_LENGTH)
  const sanitized = sanitizeTransportText(source)
  return {
    text: sanitized ? sanitized.slice(0, MAX_TRANSPORT_SUMMARY_LENGTH) : null,
    truncated: value.length > MAX_RESPONSE_SOURCE_LENGTH || sanitized.length > MAX_TRANSPORT_SUMMARY_LENGTH
  }
}

function parseJson(value: string): unknown | undefined {
  const trimmed = value.trim()
  if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    return undefined
  }
}

function meaningfulError(value: unknown): boolean {
  if (value === undefined || value === null || value === false || value === '') return false
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === 'object') return Object.keys(value as Record<string, unknown>).length > 0
  return true
}

function firstDefined(record: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) if (record[key] !== undefined && record[key] !== null) return record[key]
  return undefined
}

function isFailureCode(value: unknown): boolean {
  if (!meaningfulError(value)) return false
  if (typeof value === 'number') return value !== 0 && value !== 200
  if (typeof value !== 'string') return true
  return !['0', '200', 'ok', 'success', 'succeeded'].includes(value.trim().toLocaleLowerCase())
}

function platformSessionMessage(value: string): string | null {
  if (value.includes('平台登录状态已失效')) return '平台登录状态已失效，请重新登录'
  if (value.includes('平台请求暂时受限')) return '平台请求暂时受限，请稍后重试'
  return null
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
    ? value as Record<string, unknown>
    : null
}

function safeStatus(value: unknown): number | null {
  const status = Number(value)
  return Number.isSafeInteger(status) && status >= 0 && status <= 999 ? status : null
}

function safeContentType(value: unknown): string {
  if (typeof value !== 'string') return ''
  const mime = value.split(';', 1)[0]!.trim().toLocaleLowerCase()
  return mime.length <= 120 && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(mime) ? mime : ''
}

function isSensitiveKey(key: string): boolean {
  return isSensitiveBackgroundFieldName(key)
}
