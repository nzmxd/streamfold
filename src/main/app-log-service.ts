import { randomUUID } from 'node:crypto'
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { basename, join } from 'node:path'
import {
  isSensitiveBackgroundFieldName,
  SENSITIVE_CREDENTIAL_FIELD_PATTERN_SOURCE
} from '../shared/plugin-host-contracts'
import type {
  AppLogEntry,
  AppLogExportResult,
  AppLogLevel,
  AppLogListResult,
  AppLogQuery
} from '../shared/log-contracts'

const MAX_FILE_BYTES = 5 * 1024 * 1024
const MAX_ARCHIVES = 3
const MAX_MESSAGE_LENGTH = 1_000
const MAX_DETAILS_LENGTH = 64_000
const MAX_CONTEXT_ENTRIES = 24
const MAX_DIAGNOSTIC_DEPTH = 5
const MAX_DIAGNOSTIC_PROPERTIES = 40
const MAX_DIAGNOSTIC_ARRAY_ITEMS = 30
const MAX_DIAGNOSTIC_NODES = 240
const MAX_DIAGNOSTIC_CHARACTERS = 48_000
const MAX_DIAGNOSTIC_STRING_LENGTH = 12_000
const MAX_SANITIZE_SOURCE_LENGTH = 256_000
const SENSITIVE_KEY_SOURCE = SENSITIVE_CREDENTIAL_FIELD_PATTERN_SOURCE
const DOUBLE_QUOTED_SECRET = new RegExp(`("${SENSITIVE_KEY_SOURCE}"\\s*:\\s*)"(?:\\\\.|[^"\\\\])*"`, 'gi')
const SINGLE_QUOTED_SECRET = new RegExp(`('${SENSITIVE_KEY_SOURCE}'\\s*:\\s*)'(?:\\\\.|[^'\\\\])*'`, 'gi')
const UNTERMINATED_DOUBLE_QUOTED_SECRET = new RegExp(`("${SENSITIVE_KEY_SOURCE}"\\s*:\\s*)"(?:\\\\.|[^"\\\\\\r\\n])*(?=$|\\r?\\n)`, 'gim')
const UNTERMINATED_SINGLE_QUOTED_SECRET = new RegExp(`('${SENSITIVE_KEY_SOURCE}'\\s*:\\s*)'(?:\\\\.|[^'\\\\\\r\\n])*(?=$|\\r?\\n)`, 'gim')
const HEADER_SECRET = new RegExp(`(^|\\r?\\n)([ \\t]*${SENSITIVE_KEY_SOURCE}\\s*:\\s*)[^\\r\\n]*(?:\\r?\\n[ \\t]+[^\\r\\n]*)*`, 'gim')
const DOUBLE_QUOTED_INLINE_SECRET = new RegExp(`\\b(${SENSITIVE_KEY_SOURCE}\\s*[:=]\\s*)"(?:\\\\.|[^"\\\\])*"`, 'gi')
const SINGLE_QUOTED_INLINE_SECRET = new RegExp(`\\b(${SENSITIVE_KEY_SOURCE}\\s*[:=]\\s*)'(?:\\\\.|[^'\\\\])*'`, 'gi')
const UNTERMINATED_DOUBLE_QUOTED_INLINE_SECRET = new RegExp(`\\b(${SENSITIVE_KEY_SOURCE}\\s*[:=]\\s*)"(?:\\\\.|[^"\\\\\\r\\n])*(?=$|\\r?\\n)`, 'gim')
const UNTERMINATED_SINGLE_QUOTED_INLINE_SECRET = new RegExp(`\\b(${SENSITIVE_KEY_SOURCE}\\s*[:=]\\s*)'(?:\\\\.|[^'\\\\\\r\\n])*(?=$|\\r?\\n)`, 'gim')
const LINE_TAIL_SECRET = new RegExp(`(?<![?&#])\\b(${SENSITIVE_KEY_SOURCE}\\s*[:=]\\s*)(?!["'])[^\\r\\n]+`, 'gi')
const COOKIE_INLINE_SECRET = new RegExp(`\\b([a-z0-9_-]*cookie[a-z0-9_-]*\\s*[:=]\\s*)[^\\r\\n]+`, 'gi')
const AUTHORIZATION_SECRET = /\b((?:proxy[-_. ]?authorization|authorization)\s*[:=]\s*)[^\r\n]*(?:\r?\n[ \t]+[^\r\n]*)*/gi
const DIGEST_SECRET = /\bDigest\s+[^\r\n]*(?:\r?\n[ \t]+[^\r\n]*)*/gi
const AUTH_SCHEME_SECRET = /\b(Bearer|Basic|Digest|Negotiate|Token)\s+[^\s,;]+/gi
const INLINE_SECRET = new RegExp(`\\b(${SENSITIVE_KEY_SOURCE})\\b\\s*[:=]\\s*[^\\s,;&]+`, 'gi')
const JWT_SECRET = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{8,})?\b/g
const PRIVATE_KEY_SECRET = /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)? PRIVATE KEY-----/g
const UNTERMINATED_PRIVATE_KEY_SECRET = /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----[\s\S]*$/g
const COMMON_COOKIE_SECRET = /\b(a1|sid|sapisid|hsid|ssid|apisid|lsid|osid|sessdata|bili[_-]?jct|web[_-]?session|webid|xsecappid|auth[_-]?token|ct0|twid|ttwid|odin[_-]?tt|z_c0|d_c0|q_c1|__secure[-_. ]?(?:1p|3p)(?:sid(?:ts|cc)?|apisid)|sidcc|psidts)\s*=\s*[^\s;,&]+/gi
const ARROW_SECRET = new RegExp(`\\b(${SENSITIVE_KEY_SOURCE})\\b\\s*(?:->|=>)\\s*[^\\r\\n]+`, 'gi')
const NARRATIVE_SECRET = new RegExp(`\\b(${SENSITIVE_KEY_SOURCE})\\b\\s+(?:is|was|equals?)\\s+[^\\r\\n]+`, 'gi')
const DOUBLE_QUOTED_PAIR = /("((?:\\.|[^"\\]){1,500})"\s*:\s*)"(?:\\.|[^"\\])*"/g
const SINGLE_QUOTED_PAIR = /('((?:\\.|[^'\\]){1,500})'\s*:\s*)'(?:\\.|[^'\\])*'/g
const UNTERMINATED_DOUBLE_QUOTED_PAIR = /("((?:\\.|[^"\\]){1,500})"\s*:\s*)"(?:\\.|[^"\\\r\n])*(?=$|\r?\n)/gm
const UNTERMINATED_SINGLE_QUOTED_PAIR = /('((?:\\.|[^'\\]){1,500})'\s*:\s*)'(?:\\.|[^'\\\r\n])*(?=$|\r?\n)/gm
const ESCAPED_DOUBLE_QUOTED_PAIR = /(\\"([^"\\]{1,500})\\"\s*:\s*)\\"([^"\\]*)\\"/g

export interface AppLogMetadata {
  code?: string | null
  details?: string | null
  context?: Record<string, unknown>
}

export type AppLogListener = (entry: AppLogEntry) => void

export class AppLogService {
  private readonly currentPath: string
  private readonly listeners = new Set<AppLogListener>()
  private cachedEntries: AppLogEntry[] | null = null

  constructor(private readonly directory: string) {
    this.currentPath = join(directory, 'app.jsonl')
    try {
      mkdirSync(directory, { recursive: true })
    } catch {}
  }

  sanitizeStoredLogs(): void {
    this.sanitizeExistingFiles()
  }

  debug(scope: string, message: string, metadata: AppLogMetadata = {}): AppLogEntry {
    return this.write('debug', scope, message, metadata)
  }

  info(scope: string, message: string, metadata: AppLogMetadata = {}): AppLogEntry {
    return this.write('info', scope, message, metadata)
  }

  warn(scope: string, message: string, metadata: AppLogMetadata = {}): AppLogEntry {
    return this.write('warn', scope, message, metadata)
  }

  error(scope: string, message: string, metadata: AppLogMetadata = {}): AppLogEntry {
    return this.write('error', scope, message, metadata)
  }

  captureError(scope: string, error: unknown, context: Record<string, unknown> = {}): AppLogEntry {
    const record = objectRecord(error)
    const messageValue = record ? safeDataProperty(record, 'message') : undefined
    const codeValue = record ? safeDataProperty(record, 'code') : undefined
    const message = typeof messageValue === 'string' ? messageValue : serializeUnknown(error)
    const code = typeof codeValue === 'string' || typeof codeValue === 'number'
      ? safeString(codeValue)
      : null
    return this.error(scope, message, { code, details: formatErrorDetails(error), context })
  }

  onChanged(listener: AppLogListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  list(query: AppLogQuery = {}): AppLogListResult {
    const entries = this.readEntries()
    const filtered = filterEntries(entries, query)
    const limit = Number.isSafeInteger(query.limit) ? Math.max(1, Math.min(2_000, query.limit!)) : 500
    return {
      items: filtered.slice(0, limit).map(cloneEntry),
      total: filtered.length,
      fileBytes: this.logPaths().reduce((total, path) => total + fileSize(path), 0),
      scopes: [...new Set(entries.map((entry) => entry.scope))].sort((left, right) => left.localeCompare(right))
    }
  }

  exportTo(path: string, query: AppLogQuery = {}): AppLogExportResult {
    const entries = filterEntries(this.readEntries(), query)
    const payload = entries.map((entry) => JSON.stringify(entry)).join('\n')
    writeFileSync(path, payload ? `${payload}\n` : '', { encoding: 'utf8', mode: 0o600 })
    return { cancelled: false, fileName: basename(path), exportedCount: entries.length }
  }

  clear(): void {
    for (const path of this.logPaths()) rmSync(path, { force: true })
    this.cachedEntries = []
    this.info('app', '诊断日志已清空')
  }

  private write(
    level: AppLogLevel,
    scope: string,
    message: string,
    metadata: AppLogMetadata
  ): AppLogEntry {
    const entry: AppLogEntry = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      level,
      scope: cleanScope(scope),
      message: sanitizeText(message, MAX_MESSAGE_LENGTH),
      code: metadata.code ? sanitizeText(metadata.code, 120) : null,
      details: metadata.details ? sanitizeText(metadata.details, MAX_DETAILS_LENGTH) : null,
      context: cleanContext(metadata.context)
    }
    const serialized = `${JSON.stringify(entry)}\n`
    try {
      mkdirSync(this.directory, { recursive: true })
      const rotated = this.rotateIfNeeded(Buffer.byteLength(serialized, 'utf8'))
      if (rotated) this.cachedEntries = null
      appendFileSync(this.currentPath, serialized, { encoding: 'utf8', mode: 0o600 })
      if (!rotated) this.cachedEntries?.unshift(cloneEntry(entry))
    } catch {
      // Diagnostics must never replace the original application error.
    }
    for (const listener of this.listeners) {
      try {
        listener(cloneEntry(entry))
      } catch {}
    }
    return cloneEntry(entry)
  }

  private readEntries(): AppLogEntry[] {
    if (this.cachedEntries) return this.cachedEntries
    const entries: AppLogEntry[] = []
    for (const path of this.logPaths().reverse()) {
      if (!existsSync(path)) continue
      let text = ''
      try {
        text = readFileSync(path, 'utf8')
      } catch {
        continue
      }
      for (const line of text.split(/\r?\n/)) {
        if (!line) continue
        try {
          const parsed = JSON.parse(line) as AppLogEntry
          if (isLogEntry(parsed)) entries.push(sanitizeStoredEntry(parsed))
        } catch {}
      }
    }
    this.cachedEntries = sortEntries(entries)
    return this.cachedEntries
  }

  private logPaths(): string[] {
    return [this.currentPath, ...Array.from({ length: MAX_ARCHIVES }, (_, index) => (
      join(this.directory, `app.${index + 1}.jsonl`)
    ))]
  }

  private rotateIfNeeded(incomingBytes: number): boolean {
    if (fileSize(this.currentPath) + incomingBytes <= MAX_FILE_BYTES) return false
    const oldest = join(this.directory, `app.${MAX_ARCHIVES}.jsonl`)
    rmSync(oldest, { force: true })
    for (let index = MAX_ARCHIVES - 1; index >= 1; index -= 1) {
      const source = join(this.directory, `app.${index}.jsonl`)
      if (!existsSync(source)) continue
      const destination = join(this.directory, `app.${index + 1}.jsonl`)
      renameSync(source, destination)
    }
    if (existsSync(this.currentPath)) {
      try {
        renameSync(this.currentPath, join(this.directory, 'app.1.jsonl'))
      } catch {
        copyFileSync(this.currentPath, join(this.directory, 'app.1.jsonl'))
        rmSync(this.currentPath, { force: true })
      }
    }
    return true
  }

  private sanitizeExistingFiles(): void {
    const cachedEntries: AppLogEntry[] = []
    let cacheComplete = true
    for (const path of this.logPaths().reverse()) {
      if (!existsSync(path)) continue
      let source = ''
      try {
        source = readFileSync(path, 'utf8')
      } catch {
        cacheComplete = false
        continue
      }
      const sanitized: string[] = []
      for (const line of source.split(/\r?\n/)) {
        if (!line) continue
        try {
          const parsed = JSON.parse(line) as AppLogEntry
          if (isLogEntry(parsed)) {
            const entry = sanitizeStoredEntry(parsed)
            sanitized.push(JSON.stringify(entry))
            cachedEntries.push(entry)
          }
        } catch {
          // Invalid diagnostic lines are discarded instead of preserving potentially sensitive text.
        }
      }
      const payload = sanitized.length > 0 ? `${sanitized.join('\n')}\n` : ''
      if (payload === source) continue
      const temporaryPath = `${path}.${process.pid}.sanitize.tmp`
      try {
        writeFileSync(temporaryPath, payload, { encoding: 'utf8', mode: 0o600 })
        renameSync(temporaryPath, path)
      } catch {
        try { rmSync(temporaryPath, { force: true }) } catch {}
      }
    }
    this.cachedEntries = cacheComplete ? sortEntries(cachedEntries) : null
  }
}

function isLogEntry(value: unknown): value is AppLogEntry {
  if (!value || typeof value !== 'object') return false
  const entry = value as Partial<AppLogEntry>
  return typeof entry.id === 'string' && typeof entry.timestamp === 'string' &&
    (entry.level === 'debug' || entry.level === 'info' || entry.level === 'warn' || entry.level === 'error') &&
    typeof entry.scope === 'string' && typeof entry.message === 'string' &&
    Boolean(entry.context) && typeof entry.context === 'object' && !Array.isArray(entry.context)
}

function cleanScope(value: string): string {
  const scope = value.trim().toLocaleLowerCase().replace(/[^a-z0-9._-]/g, '-').slice(0, 80)
  return scope || 'app'
}

function cleanText(value: unknown, maximum: number): string {
  return normalizedText(value).slice(0, maximum)
}

function normalizedText(value: unknown): string {
  return safeString(value ?? '')
    .slice(0, MAX_SANITIZE_SOURCE_LENGTH)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim()
}

function sanitizeText(value: unknown, maximum: number): string {
  return cleanText(redact(normalizedText(value)), maximum)
}

function cleanContext(value: Record<string, unknown> | undefined): Record<string, string | number | boolean | null> {
  const result: Record<string, string | number | boolean | null> = {}
  if (!value) return result
  for (const key of safePropertyNames(value).slice(0, MAX_CONTEXT_ENTRIES)) {
    const field = safeDataProperty(value, key)
    const cleanKey = key.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 80)
    if (!cleanKey || isSensitiveKey(cleanKey)) continue
    if (field === null || typeof field === 'boolean') result[cleanKey] = field
    else if (typeof field === 'number' && Number.isFinite(field)) result[cleanKey] = field
    else if (typeof field === 'string') result[cleanKey] = sanitizeText(field, 500)
  }
  return result
}

function redact(value: string): string {
  return redactCookieSequences(redactPercentEncodedSecrets(redactQuotedSecrets(redactUrlCredentials(value)
    .replace(PRIVATE_KEY_SECRET, '[REDACTED PRIVATE KEY]')
    .replace(UNTERMINATED_PRIVATE_KEY_SECRET, '[REDACTED PRIVATE KEY]')
    .replace(DOUBLE_QUOTED_SECRET, '$1"[REDACTED]"')
    .replace(SINGLE_QUOTED_SECRET, "$1'[REDACTED]'")
    .replace(UNTERMINATED_DOUBLE_QUOTED_SECRET, '$1"[REDACTED]"')
    .replace(UNTERMINATED_SINGLE_QUOTED_SECRET, "$1'[REDACTED]'")
    .replace(HEADER_SECRET, '$1$2[REDACTED]')
    .replace(DOUBLE_QUOTED_INLINE_SECRET, '$1"[REDACTED]"')
    .replace(SINGLE_QUOTED_INLINE_SECRET, "$1'[REDACTED]'")
    .replace(UNTERMINATED_DOUBLE_QUOTED_INLINE_SECRET, '$1"[REDACTED]"')
    .replace(UNTERMINATED_SINGLE_QUOTED_INLINE_SECRET, "$1'[REDACTED]'")
    .replace(LINE_TAIL_SECRET, '$1[REDACTED]')
    .replace(ARROW_SECRET, '$1 -> [REDACTED]')
    .replace(NARRATIVE_SECRET, '$1 is [REDACTED]')
    .replace(COOKIE_INLINE_SECRET, '$1[REDACTED]')
    .replace(AUTHORIZATION_SECRET, '$1[REDACTED]')
    .replace(DIGEST_SECRET, 'Digest [REDACTED]')
    .replace(AUTH_SCHEME_SECRET, '$1 [REDACTED]')
    .replace(JWT_SECRET, '[REDACTED JWT]')
    .replace(COMMON_COOKIE_SECRET, '$1=[REDACTED]')
    .replace(INLINE_SECRET, '$1=[REDACTED]'))))
}

function redactCookieSequences(value: string): string {
  return value.replace(
    /(^|[^A-Za-z0-9_.-])((?:[A-Za-z0-9_.-]+\s*=\s*[^;\r\n]*;\s*)+[A-Za-z0-9_.-]+\s*=\s*[^;\r\n]*)/gm,
    (_match, prefix: string, sequence: string) => (
      `${prefix}${sequence.replace(/(=)\s*[^;]*/g, '$1[REDACTED]')}`
    )
  )
}

function redactQuotedSecrets(value: string): string {
  const replaceDouble = (match: string, prefix: string, rawKey: string): string => (
    isSensitiveKey(decodeJsonKey(rawKey)) ? `${prefix}"[REDACTED]"` : match
  )
  const replaceSingle = (match: string, prefix: string, rawKey: string): string => (
    isSensitiveKey(rawKey.replace(/\\'/g, "'")) ? `${prefix}'[REDACTED]'` : match
  )
  const replaceEscaped = (match: string, prefix: string, rawKey: string): string => (
    isSensitiveKey(rawKey) ? `${prefix}\\"[REDACTED]\\"` : match
  )
  return value
    .replace(DOUBLE_QUOTED_PAIR, replaceDouble)
    .replace(SINGLE_QUOTED_PAIR, replaceSingle)
    .replace(UNTERMINATED_DOUBLE_QUOTED_PAIR, replaceDouble)
    .replace(UNTERMINATED_SINGLE_QUOTED_PAIR, replaceSingle)
    .replace(ESCAPED_DOUBLE_QUOTED_PAIR, replaceEscaped)
}

function redactPercentEncodedSecrets(value: string): string {
  return value.replace(/(?:[A-Za-z0-9_.~+-]|%[0-9A-Fa-f]{2}){6,}/g, (candidate) => {
    if (!candidate.includes('%')) return candidate
    try {
      const decoded = decodeURIComponent(candidate.replace(/\+/g, '%20'))
      return containsSensitiveAssignment(decoded) ? '[REDACTED URL-ENCODED DATA]' : candidate
    } catch {
      return candidate
    }
  })
}

function containsSensitiveAssignment(value: string): boolean {
  if (/\b(?:Bearer|Basic|Digest|Negotiate|Token)\s+/i.test(value)) return true
  const pattern = /([A-Za-z0-9_. -]{1,100})\s*[:=]/g
  for (const match of value.matchAll(pattern)) {
    if (isSensitiveKey(match[1] ?? '')) return true
  }
  return false
}

function decodeJsonKey(value: string): string {
  try {
    return JSON.parse(`"${value}"`) as string
  } catch {
    return value
  }
}

function redactUrlCredentials(value: string): string {
  return value.replace(/\bhttps?:\/\/[^\s<>"']+/gi, (candidate) => {
    let source = candidate
    let suffix = ''
    while (/[),.;\]]$/.test(source)) {
      suffix = source.slice(-1) + suffix
      source = source.slice(0, -1)
    }
    try {
      const url = new URL(source)
      if (url.username || url.password) {
        url.username = 'REDACTED'
        url.password = ''
      }
      for (const key of [...url.searchParams.keys()]) {
        if (key.toLocaleLowerCase() === 'code' || key.toLocaleLowerCase() === 'state' ||
          isSensitiveKey(key)) {
          url.searchParams.set(key, '[REDACTED]')
        }
      }
      if (url.hash.length > 1) {
        const fragment = new URLSearchParams(url.hash.slice(1))
        let changed = false
        for (const key of [...fragment.keys()]) {
          if (key.toLocaleLowerCase() === 'code' || key.toLocaleLowerCase() === 'state' ||
            isSensitiveKey(key)) {
            fragment.set(key, '[REDACTED]')
            changed = true
          }
        }
        if (changed) url.hash = fragment.toString()
      }
      return `${url.toString()}${suffix}`
    } catch {
      return candidate
    }
  })
}

function serializeUnknown(value: unknown): string {
  if (value === undefined || value === null || value === '') return '未知错误'
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return safeString(value)
  }
  return '未知错误'
}

function isSensitiveKey(key: string): boolean {
  return isSensitiveBackgroundFieldName(key)
}

function formatErrorDetails(error: unknown): string | null {
  const blocks: string[] = []
  const visited = new WeakSet<object>()
  const serialized = new WeakSet<object>()
  const budget: DiagnosticBudget = {
    nodes: MAX_DIAGNOSTIC_NODES,
    characters: MAX_DIAGNOSTIC_CHARACTERS
  }

  const append = (value: unknown, label: string, depth: number): void => {
    if (depth > MAX_DIAGNOSTIC_DEPTH || budget.nodes <= 0 || budget.characters <= 0) return
    budget.nodes -= 1
    const record = objectRecord(value)
    if (record) {
      if (visited.has(record)) {
        blocks.push(`${label}\n[Circular error reference]`)
        return
      }
      visited.add(record)
    }

    const stackValue = record ? safeDataProperty(record, 'stack') : undefined
    const nameValue = record ? safeDataProperty(record, 'name') : undefined
    const messageValue = record ? safeDataProperty(record, 'message') : undefined
    const name = typeof nameValue === 'string' ? nameValue : 'Error'
    const message = typeof messageValue === 'string' ? messageValue : serializeUnknown(value)
    const headline = diagnosticText(
      typeof stackValue === 'string' ? stackValue : `${name}: ${message}`,
      budget,
      MAX_DETAILS_LENGTH
    )
    if (headline) blocks.push(label ? `${label}\n${headline}` : headline)

    if (record) {
      serialized.add(record)
      const properties = diagnosticProperties(
        record,
        new Set(['name', 'message', 'stack', 'cause', 'errors']),
        budget,
        serialized
      )
      if (Object.keys(properties).length > 0) {
        const propertiesText = diagnosticText(JSON.stringify(properties, null, 2), budget, MAX_DETAILS_LENGTH)
        if (propertiesText) blocks.push(`${label ? `${label} ` : ''}错误属性\n${propertiesText}`)
      }
      const errors = safeArrayItems(safeDataProperty(record, 'errors'), MAX_DIAGNOSTIC_ARRAY_ITEMS)
      if (errors) {
        for (const [index, item] of errors.entries()) {
          append(item, `聚合错误 ${index + 1}`, depth + 1)
        }
      }
      const cause = safeDataProperty(record, 'cause')
      if (cause !== undefined) append(cause, '原因', depth + 1)
    }
  }

  append(error, '', 0)
  return blocks.length > 0 ? sanitizeText(blocks.join('\n\n'), MAX_DETAILS_LENGTH) : null
}

interface DiagnosticBudget {
  nodes: number
  characters: number
}

function diagnosticProperties(
  record: Record<string, unknown>,
  excluded: ReadonlySet<string>,
  budget: DiagnosticBudget,
  seen: WeakSet<object>
): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const key of safePropertyNames(record).slice(0, MAX_DIAGNOSTIC_PROPERTIES)) {
    if (budget.nodes <= 0 || budget.characters <= 0) {
      result.diagnosticTruncated = true
      break
    }
    if (excluded.has(key)) continue
    const field = safeOwnDataProperty(record, key)
    if (!field.found) continue
    const cleanKey = sanitizeText(key, 200) || 'field'
    result[key] = isSensitiveKey(key)
      ? '[REDACTED]'
      : diagnosticValue(field.value, 0, seen, budget)
    if (cleanKey !== key) {
      result[cleanKey] = result[key]
      delete result[key]
    }
  }
  return result
}

function diagnosticValue(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
  budget: DiagnosticBudget
): unknown {
  if (budget.nodes <= 0 || budget.characters <= 0) return '[Diagnostic budget exhausted]'
  budget.nodes -= 1
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value
  if (typeof value === 'string') return diagnosticText(value, budget, MAX_DIAGNOSTIC_STRING_LENGTH)
  if (typeof value === 'bigint') return diagnosticText(safeString(value), budget, 200)
  if (typeof value === 'undefined') return '[undefined]'
  if (typeof value === 'function') {
    const name = safeDataProperty(value as unknown as Record<string, unknown>, 'name')
    return `[Function ${typeof name === 'string' ? sanitizeText(name, 120) : 'anonymous'}]`
  }
  if (typeof value !== 'object') return diagnosticText(safeString(value), budget, 200)
  if (seen.has(value)) return '[Circular]'
  if (depth >= MAX_DIAGNOSTIC_DEPTH) return '[Maximum depth reached]'
  seen.add(value)
  const items = safeArrayItems(value, MAX_DIAGNOSTIC_ARRAY_ITEMS)
  if (items) {
    return items.map((item) => diagnosticValue(item, depth + 1, seen, budget))
  }
  const result: Record<string, unknown> = {}
  for (const key of safePropertyNames(value).slice(0, MAX_DIAGNOSTIC_PROPERTIES)) {
    if (budget.nodes <= 0 || budget.characters <= 0) {
      result.diagnosticTruncated = true
      break
    }
    const field = safeOwnDataProperty(value, key)
    if (!field.found) continue
    const cleanKey = sanitizeText(key, 200) || 'field'
    result[cleanKey] = isSensitiveKey(key)
      ? '[REDACTED]'
      : diagnosticValue(field.value, depth + 1, seen, budget)
  }
  return result
}

function diagnosticText(value: unknown, budget: DiagnosticBudget, maximum: number): string {
  const allowance = Math.max(0, Math.min(maximum, budget.characters))
  if (allowance === 0) return ''
  const text = sanitizeText(value, allowance)
  budget.characters = Math.max(0, budget.characters - text.length)
  return text
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return ((typeof value === 'object' && value !== null) || typeof value === 'function')
    ? value as Record<string, unknown>
    : null
}

function safePropertyNames(value: object): string[] {
  try {
    return Object.getOwnPropertyNames(value)
  } catch {
    return []
  }
}

function safeOwnDataProperty(
  value: object,
  key: string
): { found: true; value: unknown } | { found: false } {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor && 'value' in descriptor
      ? { found: true, value: descriptor.value }
      : { found: false }
  } catch {
    return { found: false }
  }
}

function safeDataProperty(value: object, key: string): unknown {
  let current: object | null = value
  for (let depth = 0; current && depth < 6; depth += 1) {
    const own = safeOwnDataProperty(current, key)
    if (own.found) return own.value
    try {
      current = Object.getPrototypeOf(current) as object | null
    } catch {
      return undefined
    }
  }
  return undefined
}

function safeArrayItems(value: unknown, maximum: number): unknown[] | null {
  try {
    if (!Array.isArray(value)) return null
    const length = Math.min(value.length, maximum)
    return Array.from({ length }, (_, index) => safeDataProperty(value, String(index)))
  } catch {
    return null
  }
}

function safeString(value: unknown): string {
  try {
    return String(value)
  } catch {
    return '[Unavailable value]'
  }
}

function sanitizeStoredEntry(entry: AppLogEntry): AppLogEntry {
  return {
    id: cleanText(entry.id, 120),
    timestamp: cleanText(entry.timestamp, 80),
    level: entry.level,
    scope: cleanScope(entry.scope),
    message: sanitizeText(entry.message, MAX_MESSAGE_LENGTH),
    code: entry.code ? sanitizeText(entry.code, 120) : null,
    details: entry.details ? sanitizeText(entry.details, MAX_DETAILS_LENGTH) : null,
    context: cleanContext(entry.context as Record<string, unknown>)
  }
}

function sortEntries(entries: AppLogEntry[]): AppLogEntry[] {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((left, right) => (
      right.entry.timestamp.localeCompare(left.entry.timestamp) || right.index - left.index
    ))
    .map(({ entry }) => entry)
}

function cleanSearch(value: string | undefined): string {
  return value?.trim().toLocaleLowerCase().slice(0, 200) ?? ''
}

function searchableText(entry: AppLogEntry): string {
  return [entry.level, entry.scope, entry.message, entry.code ?? '', entry.details ?? '', JSON.stringify(entry.context)]
    .join(' ')
    .toLocaleLowerCase()
}

function filterEntries(entries: AppLogEntry[], query: AppLogQuery): AppLogEntry[] {
  const level = query.level
  const scope = cleanSearch(query.scope)
  const search = cleanSearch(query.search)
  return entries.filter((entry) => {
    if (level && entry.level !== level) return false
    if (scope && entry.scope.toLocaleLowerCase() !== scope) return false
    if (!search) return true
    return searchableText(entry).includes(search)
  })
}

function fileSize(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

function cloneEntry(entry: AppLogEntry): AppLogEntry {
  return { ...entry, context: { ...entry.context } }
}
