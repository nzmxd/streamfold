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
const MAX_DETAILS_LENGTH = 12_000
const MAX_CONTEXT_ENTRIES = 24
const SENSITIVE_KEY_SOURCE = '(?:password|passphrase|cookie|set[-_]?cookie|authorization|proxy[-_]?authorization|secret|client[-_]?secret|access[-_]?token|refresh[-_]?token|id[-_]?token|auth[-_]?token|auth[-_]?code|oauth[-_]?code|api[-_]?key|x[-_]?api[-_]?key|csrf(?:[-_]?token)?|xsrf(?:[-_]?token)?|session(?:[-_]?id)?)'
const DOUBLE_QUOTED_SECRET = new RegExp(`("${SENSITIVE_KEY_SOURCE}"\\s*:\\s*)"(?:\\\\.|[^"\\\\])*"`, 'gi')
const SINGLE_QUOTED_SECRET = new RegExp(`('${SENSITIVE_KEY_SOURCE}'\\s*:\\s*)'(?:\\\\.|[^'\\\\])*'`, 'gi')
const HEADER_SECRET = new RegExp(`(^|\\r?\\n)([ \\t]*${SENSITIVE_KEY_SOURCE}\\s*:\\s*)[^\\r\\n]*`, 'gim')
const INLINE_SECRET = new RegExp(`\\b(${SENSITIVE_KEY_SOURCE})\\b\\s*[:=]\\s*[^\\s,;&]+`, 'gi')

export interface AppLogMetadata {
  code?: string | null
  details?: string | null
  context?: Record<string, unknown>
}

export type AppLogListener = (entry: AppLogEntry) => void

export class AppLogService {
  private readonly currentPath: string
  private readonly listeners = new Set<AppLogListener>()

  constructor(private readonly directory: string) {
    this.currentPath = join(directory, 'app.jsonl')
    try {
      mkdirSync(directory, { recursive: true })
    } catch {}
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
    const record = error && typeof error === 'object' ? error as Record<string, unknown> : null
    const message = error instanceof Error
      ? error.message
      : typeof record?.message === 'string'
        ? record.message
        : serializeUnknown(error)
    const code = typeof record?.code === 'string' || typeof record?.code === 'number'
      ? String(record.code)
      : null
    const stack = error instanceof Error
      ? error.stack ?? null
      : typeof record?.stack === 'string' ? record.stack : null
    return this.error(scope, message, { code, details: stack, context })
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
      message: redact(cleanText(message, MAX_MESSAGE_LENGTH)),
      code: metadata.code ? redact(cleanText(metadata.code, 120)) : null,
      details: metadata.details ? redact(cleanText(metadata.details, MAX_DETAILS_LENGTH)) : null,
      context: cleanContext(metadata.context)
    }
    const serialized = `${JSON.stringify(entry)}\n`
    try {
      mkdirSync(this.directory, { recursive: true })
      this.rotateIfNeeded(Buffer.byteLength(serialized, 'utf8'))
      appendFileSync(this.currentPath, serialized, { encoding: 'utf8', mode: 0o600 })
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
          if (isLogEntry(parsed)) entries.push(parsed)
        } catch {}
      }
    }
    return entries.sort((left, right) => right.timestamp.localeCompare(left.timestamp))
  }

  private logPaths(): string[] {
    return [this.currentPath, ...Array.from({ length: MAX_ARCHIVES }, (_, index) => (
      join(this.directory, `app.${index + 1}.jsonl`)
    ))]
  }

  private rotateIfNeeded(incomingBytes: number): void {
    if (fileSize(this.currentPath) + incomingBytes <= MAX_FILE_BYTES) return
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
  return String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, maximum)
}

function cleanContext(value: Record<string, unknown> | undefined): Record<string, string | number | boolean | null> {
  const result: Record<string, string | number | boolean | null> = {}
  if (!value) return result
  for (const [key, field] of Object.entries(value).slice(0, MAX_CONTEXT_ENTRIES)) {
    const cleanKey = key.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 80)
    if (!cleanKey || isSensitiveKey(cleanKey)) continue
    if (field === null || typeof field === 'boolean') result[cleanKey] = field
    else if (typeof field === 'number' && Number.isFinite(field)) result[cleanKey] = field
    else if (typeof field === 'string') result[cleanKey] = redact(cleanText(field, 500))
  }
  return result
}

function redact(value: string): string {
  return redactUrlCredentials(value)
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(DOUBLE_QUOTED_SECRET, '$1"[REDACTED]"')
    .replace(SINGLE_QUOTED_SECRET, "$1'[REDACTED]'")
    .replace(HEADER_SECRET, '$1$2[REDACTED]')
    .replace(INLINE_SECRET, '$1=[REDACTED]')
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
        const normalized = key.toLocaleLowerCase().replace(/[^a-z0-9]/g, '')
        if (key.toLocaleLowerCase() === 'code' || key.toLocaleLowerCase() === 'state' ||
          isSensitiveKey(normalized)) {
          url.searchParams.set(key, '[REDACTED]')
        }
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
  try {
    const serialized = JSON.stringify(value)
    return serialized || String(value)
  } catch {
    return String(value)
  }
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLocaleLowerCase().replace(/[^a-z0-9]/g, '')
  return /(?:password|passphrase|cookie|authorization|secret|clientsecret|accesstoken|refreshtoken|idtoken|apikey|csrf|xsrf|sessionid|^session$)/.test(normalized)
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
