import { createHash } from 'node:crypto'
import { contentTypes, type ContentSnapshot, type ContentType } from '../../shared/content-contracts'
import type {
  NormalizedImportContent,
  NormalizedImportPayload,
  NormalizedImportProfile
} from './types'
import { SafeImportError } from './errors'

export const MAX_IMPORT_ROWS = 5_000
export const MAX_IMPORT_WARNINGS = 100
export const MAX_IMPORT_SNAPSHOTS = 5_000

const SENSITIVE_KEY_PARTS = [
  'cookie',
  'token',
  'password',
  'passwd',
  'pwd',
  'authorization',
  'credential',
  'secret',
  'session',
  'bearer',
  'apikey'
] as const

const SENSITIVE_URL_KEY_PARTS = [
  ...SENSITIVE_KEY_PARTS,
  'sig',
  'signature',
  'auth',
  'code',
  'ticket',
  'key',
  'expires',
  'policy',
  'xamz',
  'jwt'
] as const

// Keep only identifiers that are useful for a stable public content link. Tracking and unknown
// parameters are discarded, while credential-like parameters reject the entire import.
const PUBLIC_URL_PARAMETERS = new Set([
  'id', 'mid', 'aid', 'noteid', 'videoid', 'articleid', 'itemid', 'answerid', 'contentid'
])

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|([+-])(\d{2}):(\d{2})))?$/i
const ILLEGAL_TEXT_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/
const METRIC_ALIASES = ['views', 'likes', 'comments', 'shares', 'favorites'] as const

export interface ParseImportOptions {
  /** A caller-supplied ISO timestamp keeps the parser deterministic and testable. */
  capturedAt: string
}

interface NormalizeContext {
  capturedAt: string
  warnings: WarningCollector
  snapshotCount: number
}

export function parseJsonImport(source: string, options: ParseImportOptions): NormalizedImportPayload {
  let parsed: unknown
  try {
    parsed = JSON.parse(stripBom(source)) as unknown
  } catch {
    throw new SafeImportError('INVALID_JSON', 'JSON 文件格式无效')
  }
  return normalizeJsonImport(parsed, options)
}

export function normalizeJsonImport(value: unknown, options: ParseImportOptions): NormalizedImportPayload {
  scanForSensitiveKeys(value)
  const fallbackCapturedAt = normalizeRequiredDate(options.capturedAt, '导入时间')
  const warnings = new WarningCollector()
  const context: NormalizeContext = {
    capturedAt: fallbackCapturedAt,
    warnings,
    snapshotCount: 0
  }

  let account: unknown = null
  let contents: unknown
  let capturedAt = fallbackCapturedAt

  if (Array.isArray(value)) {
    contents = value
  } else {
    const root = requireRecord(value, '根对象')
    account = getAliased(root, ['account', 'profile']) ?? null
    contents = getAliased(root, ['contents', 'content', 'items'])
    if (contents === undefined) {
      throw new SafeImportError('INVALID_IMPORT_SHAPE', 'JSON 需要包含 contents 数组')
    }
    const suppliedCapturedAt = getAliased(root, ['capturedAt', 'captured_at'])
    if (suppliedCapturedAt !== undefined && suppliedCapturedAt !== null && suppliedCapturedAt !== '') {
      capturedAt = normalizeRequiredDate(suppliedCapturedAt, 'capturedAt')
      context.capturedAt = capturedAt
    }
  }

  if (!Array.isArray(contents)) {
    throw new SafeImportError('INVALID_CONTENTS', 'contents 必须是数组')
  }
  if (contents.length > MAX_IMPORT_ROWS) {
    throw new SafeImportError('IMPORT_ROW_LIMIT_EXCEEDED', `单次最多导入 ${MAX_IMPORT_ROWS} 条内容`)
  }

  const profile = account === null ? null : normalizeProfile(account)
  const normalizedContents = contents.map((content, index) => normalizeContent(content, index + 1, context))

  return {
    capturedAt,
    profile,
    contents: normalizedContents,
    warnings: warnings.values()
  }
}

export function parseCsvImport(source: string, options: ParseImportOptions): NormalizedImportPayload {
  const capturedAt = normalizeRequiredDate(options.capturedAt, '导入时间')
  const rows = parseCsvRows(stripBom(source), MAX_IMPORT_ROWS + 1)
  if (rows.length === 0) {
    throw new SafeImportError('EMPTY_CSV', 'CSV 文件为空')
  }

  const rawHeaders = rows[0]
  if (!rawHeaders || rawHeaders.length === 0) {
    throw new SafeImportError('INVALID_CSV_HEADER', 'CSV 缺少表头')
  }
  const headers = rawHeaders.map((header) => header.trim())
  if (headers.some((header) => header.length === 0)) {
    throw new SafeImportError('INVALID_CSV_HEADER', 'CSV 表头不能为空')
  }
  for (const header of headers) assertNotSensitiveKey(header)

  const canonicalHeaders = headers.map(canonicalKey)
  const duplicateHeader = canonicalHeaders.find((header, index) => canonicalHeaders.indexOf(header) !== index)
  if (duplicateHeader) {
    throw new SafeImportError('DUPLICATE_CSV_HEADER', 'CSV 表头存在重复列')
  }

  const dataRows = rows.slice(1).filter((row) => row.some((cell) => cell.trim() !== ''))
  if (dataRows.length > MAX_IMPORT_ROWS) {
    throw new SafeImportError('IMPORT_ROW_LIMIT_EXCEEDED', `单次最多导入 ${MAX_IMPORT_ROWS} 条内容`)
  }
  if (!hasCanonicalAlias(canonicalHeaders, ['type'])) {
    throw new SafeImportError('MISSING_CSV_COLUMN', 'CSV 缺少 type 列')
  }
  if (
    !hasCanonicalAlias(canonicalHeaders, ['remoteId', 'remote_id', 'id']) &&
    !hasCanonicalAlias(canonicalHeaders, ['url', 'link'])
  ) {
    throw new SafeImportError('MISSING_CSV_COLUMN', 'CSV 需要 remoteId 或 url 列')
  }

  const warnings = new WarningCollector()
  const context: NormalizeContext = { capturedAt, warnings, snapshotCount: 0 }
  const contents = dataRows.map((row, index) => {
    if (row.length > headers.length) {
      throw new SafeImportError('INVALID_CSV_ROW', `CSV 第 ${index + 2} 行列数超过表头`)
    }
    const record = Object.create(null) as Record<string, string>
    for (let column = 0; column < headers.length; column += 1) {
      const header = headers[column]
      if (header) record[header] = row[column] ?? ''
    }
    return normalizeContent(record, index + 1, context, true)
  })

  return {
    capturedAt,
    profile: null,
    contents,
    warnings: warnings.values()
  }
}

/** RFC 4180-style parser with support for escaped quotes and quoted newlines. */
export function parseCsvRows(source: string, maximumRows = MAX_IMPORT_ROWS + 1): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let quoteClosed = false

  const pushRow = (): void => {
    row.push(field)
    rows.push(row)
    if (rows.length > maximumRows) {
      throw new SafeImportError('IMPORT_ROW_LIMIT_EXCEEDED', `单次最多导入 ${MAX_IMPORT_ROWS} 条内容`)
    }
    row = []
    field = ''
    quoteClosed = false
  }

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]
    if (quoted) {
      if (character === '"') {
        if (source[index + 1] === '"') {
          field += '"'
          index += 1
        } else {
          quoted = false
          quoteClosed = true
        }
      } else {
        field += character
      }
      continue
    }

    if (character === '"') {
      if (field.length !== 0 || quoteClosed) {
        throw new SafeImportError('INVALID_CSV', 'CSV 引号位置无效')
      }
      quoted = true
      continue
    }

    if (character === ',') {
      row.push(field)
      field = ''
      quoteClosed = false
      continue
    }

    if (character === '\n' || character === '\r') {
      if (character === '\r' && source[index + 1] === '\n') index += 1
      pushRow()
      continue
    }

    if (quoteClosed) {
      throw new SafeImportError('INVALID_CSV', 'CSV 引号后只能紧跟逗号或换行')
    }
    field += character
  }

  if (quoted) {
    throw new SafeImportError('INVALID_CSV', 'CSV 存在未闭合的引号')
  }
  if (row.length > 0 || field.length > 0 || quoteClosed) pushRow()
  return rows
}

export function stableRemoteIdForUrl(url: string): string {
  const normalized = normalizeUrl(url, 'url')
  return `url-sha256:${createHash('sha256').update(normalized, 'utf8').digest('hex')}`
}

function normalizeProfile(value: unknown): NormalizedImportProfile {
  const record = requireRecord(value, 'account')
  return {
    remoteId: normalizeRequiredText(getAliased(record, ['remoteId', 'remote_id', 'id']), 'account.remoteId', 512),
    remoteName: normalizeRequiredText(getAliased(record, ['remoteName', 'remote_name', 'name']), 'account.remoteName', 500),
    followers: normalizeOptionalInteger(getAliased(record, ['followers']), 'account.followers'),
    following: normalizeOptionalInteger(getAliased(record, ['following']), 'account.following'),
    contentCount: normalizeOptionalInteger(getAliased(record, ['contentCount', 'content_count']), 'account.contentCount'),
    viewsTotal: normalizeOptionalInteger(getAliased(record, ['viewsTotal', 'views_total']), 'account.viewsTotal')
  }
}

function normalizeContent(
  value: unknown,
  rowNumber: number,
  context: NormalizeContext,
  fromCsv = false
): NormalizedImportContent {
  const record = requireRecord(value, `第 ${rowNumber} 条内容`)
  const typeValue = getAliased(record, ['type', 'contentType', 'content_type'])
  const type = normalizeContentType(typeValue, rowNumber)
  const urlValue = getAliased(record, ['url', 'link'])
  const url = normalizeOptionalUrl(urlValue, `第 ${rowNumber} 条内容的 url`)
  const remoteIdValue = getAliased(record, ['remoteId', 'remote_id', 'id'])
  let remoteId = normalizeOptionalText(remoteIdValue, `第 ${rowNumber} 条内容的 remoteId`, 512)
  if (!remoteId) {
    if (!url) {
      throw new SafeImportError('MISSING_REMOTE_ID', `第 ${rowNumber} 条内容缺少 remoteId 和 HTTPS url`)
    }
    remoteId = stableRemoteIdForUrl(url)
    context.warnings.add(`第 ${rowNumber} 条内容缺少 remoteId，已使用 HTTPS URL 生成稳定标识`)
  }

  const rawTitle = getAliased(record, ['title', 'name'])
  const title = normalizeOptionalText(rawTitle, `第 ${rowNumber} 条内容的 title`, 500)
  if (!title) context.warnings.add(`第 ${rowNumber} 条内容没有标题`)

  const bodyExcerpt = normalizeOptionalText(
    getAliased(record, ['bodyExcerpt', 'body_excerpt', 'excerpt', 'body']),
    `第 ${rowNumber} 条内容的 bodyExcerpt`,
    5_000
  )
  const publishedAt = normalizeOptionalDate(
    getAliased(record, ['publishedAt', 'published_at', 'publishTime', 'publish_time', 'date']),
    `第 ${rowNumber} 条内容的 publishedAt`
  )

  const snapshots: ContentSnapshot[] = []
  const suppliedSnapshots = getAliased(record, ['snapshots', 'metricsHistory', 'metrics_history'])
  if (suppliedSnapshots !== undefined && suppliedSnapshots !== null && suppliedSnapshots !== '') {
    if (!Array.isArray(suppliedSnapshots)) {
      throw new SafeImportError('INVALID_SNAPSHOTS', `第 ${rowNumber} 条内容的 snapshots 必须是数组`)
    }
    for (let index = 0; index < suppliedSnapshots.length; index += 1) {
      const snapshot = normalizeSnapshot(suppliedSnapshots[index], context.capturedAt, `第 ${rowNumber} 条内容的第 ${index + 1} 个快照`, false)
      if (snapshot) snapshots.push(snapshot)
    }
  }

  if (fromCsv || hasAnyAlias(record, [...METRIC_ALIASES, 'capturedAt', 'captured_at'])) {
    const snapshot = normalizeSnapshot(record, context.capturedAt, `CSV 第 ${rowNumber + 1} 行`, fromCsv)
    if (snapshot) snapshots.push(snapshot)
  }

  context.snapshotCount += snapshots.length
  if (context.snapshotCount > MAX_IMPORT_SNAPSHOTS) {
    throw new SafeImportError('IMPORT_SNAPSHOT_LIMIT_EXCEEDED', `单次最多导入 ${MAX_IMPORT_SNAPSHOTS} 个指标快照`)
  }
  snapshots.sort((left, right) => left.capturedAt.localeCompare(right.capturedAt))

  return {
    remoteId,
    type,
    title,
    bodyExcerpt,
    url,
    publishedAt,
    snapshots
  }
}

function normalizeSnapshot(
  value: unknown,
  fallbackCapturedAt: string,
  label: string,
  csvValues: boolean
): ContentSnapshot | null {
  const record = requireRecord(value, label)
  const metrics = {
    views: csvValues
      ? normalizeOptionalCsvInteger(getAliased(record, ['views']), `${label}.views`)
      : normalizeOptionalInteger(getAliased(record, ['views']), `${label}.views`),
    likes: csvValues
      ? normalizeOptionalCsvInteger(getAliased(record, ['likes']), `${label}.likes`)
      : normalizeOptionalInteger(getAliased(record, ['likes']), `${label}.likes`),
    comments: csvValues
      ? normalizeOptionalCsvInteger(getAliased(record, ['comments']), `${label}.comments`)
      : normalizeOptionalInteger(getAliased(record, ['comments']), `${label}.comments`),
    shares: csvValues
      ? normalizeOptionalCsvInteger(getAliased(record, ['shares']), `${label}.shares`)
      : normalizeOptionalInteger(getAliased(record, ['shares']), `${label}.shares`),
    favorites: csvValues
      ? normalizeOptionalCsvInteger(getAliased(record, ['favorites']), `${label}.favorites`)
      : normalizeOptionalInteger(getAliased(record, ['favorites']), `${label}.favorites`)
  }
  if (Object.values(metrics).every((metric) => metric === null)) return null
  const suppliedCapturedAt = getAliased(record, ['capturedAt', 'captured_at'])
  const capturedAt = suppliedCapturedAt === undefined || suppliedCapturedAt === null || suppliedCapturedAt === ''
    ? fallbackCapturedAt
    : normalizeRequiredDate(suppliedCapturedAt, `${label}.capturedAt`)
  return { capturedAt, ...metrics }
}

function normalizeContentType(value: unknown, rowNumber: number): ContentType {
  if (typeof value !== 'string' || !(contentTypes as readonly string[]).includes(value.trim())) {
    throw new SafeImportError(
      'INVALID_CONTENT_TYPE',
      `第 ${rowNumber} 条内容的 type 必须是 ${contentTypes.join('/')}`
    )
  }
  return value.trim() as ContentType
}

function normalizeOptionalInteger(value: unknown, label: string): number | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isSafeInteger(value) || value < 0) {
    throw new SafeImportError('INVALID_METRIC', `${label} 必须是非负有限整数`)
  }
  return value
}

function normalizeOptionalCsvInteger(value: unknown, label: string): number | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) {
    throw new SafeImportError('INVALID_METRIC', `${label} 必须是非负有限整数`)
  }
  const parsed = Number(value.trim())
  if (!Number.isFinite(parsed) || !Number.isSafeInteger(parsed)) {
    throw new SafeImportError('INVALID_METRIC', `${label} 必须是非负有限整数`)
  }
  return parsed
}

function normalizeRequiredText(value: unknown, label: string, maximumLength: number): string {
  const normalized = normalizeOptionalText(value, label, maximumLength)
  if (!normalized) throw new SafeImportError('MISSING_REQUIRED_TEXT', `${label} 不能为空`)
  return normalized
}

function normalizeOptionalText(value: unknown, label: string, maximumLength: number): string {
  if (value === undefined || value === null || value === '') return ''
  if (typeof value !== 'string') {
    throw new SafeImportError('INVALID_TEXT', `${label} 必须是文本`)
  }
  const normalized = value.trim()
  if (normalized.length > maximumLength || ILLEGAL_TEXT_CONTROL.test(normalized)) {
    throw new SafeImportError('INVALID_TEXT', `${label} 格式无效或过长`)
  }
  return normalized
}

function normalizeOptionalUrl(value: unknown, label: string): string {
  if (value === undefined || value === null || value === '') return ''
  if (typeof value !== 'string') throw new SafeImportError('INVALID_URL', `${label} 必须是 HTTPS URL`)
  return normalizeUrl(value.trim(), label)
}

function normalizeUrl(value: string, label: string): string {
  if (value.length === 0 || value.length > 4_096 || ILLEGAL_TEXT_CONTROL.test(value)) {
    throw new SafeImportError('INVALID_URL', `${label} 格式无效`)
  }
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new SafeImportError('INVALID_URL', `${label} 格式无效`)
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !parsed.hostname) {
    throw new SafeImportError('INVALID_URL', `${label} 必须是不含凭证的 HTTPS URL`)
  }
  for (const key of [...parsed.searchParams.keys()]) {
    assertSafeUrlParameter(key)
    if (!PUBLIC_URL_PARAMETERS.has(canonicalKey(key))) parsed.searchParams.delete(key)
  }
  for (const key of new URLSearchParams(parsed.hash.slice(1)).keys()) {
    assertSafeUrlParameter(key)
  }
  parsed.hash = ''
  parsed.searchParams.sort()
  return parsed.toString()
}

function normalizeOptionalDate(value: unknown, label: string): string | null {
  if (value === undefined || value === null || value === '') return null
  return normalizeRequiredDate(value, label)
}

function normalizeRequiredDate(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length > 64) {
    throw new SafeImportError('INVALID_DATE', `${label} 必须是 ISO 8601 日期`)
  }
  const parts = DATE_PATTERN.exec(value)
  if (!parts || !isValidDateParts(parts)) {
    throw new SafeImportError('INVALID_DATE', `${label} 必须是有效的 ISO 8601 日期`)
  }
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds)) {
    throw new SafeImportError('INVALID_DATE', `${label} 必须是有效日期`)
  }
  return new Date(milliseconds).toISOString()
}

function isValidDateParts(parts: RegExpExecArray): boolean {
  const year = Number(parts[1])
  const month = Number(parts[2])
  const day = Number(parts[3])
  if (month < 1 || month > 12) return false
  const maximumDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
  if (day < 1 || day > maximumDay) return false
  if (parts[4] === undefined) return true

  const hour = Number(parts[4])
  const minute = Number(parts[5])
  const second = Number(parts[6])
  if (hour > 23 || minute > 59 || second > 59) return false
  if (parts[7]?.toUpperCase() === 'Z') return true

  const offsetHour = Number(parts[9])
  const offsetMinute = Number(parts[10])
  return offsetHour < 14
    ? offsetMinute <= 59
    : offsetHour === 14 && offsetMinute === 0
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SafeImportError('INVALID_OBJECT', `${label} 必须是对象`)
  }
  return value as Record<string, unknown>
}

function getAliased(record: Record<string, unknown>, aliases: readonly string[]): unknown {
  const wanted = new Set(aliases.map(canonicalKey))
  let found = false
  let value: unknown
  for (const [key, candidate] of Object.entries(record)) {
    if (!wanted.has(canonicalKey(key))) continue
    if (found) throw new SafeImportError('AMBIGUOUS_FIELD', '文件中存在语义重复的字段')
    found = true
    value = candidate
  }
  return value
}

function hasAnyAlias(record: Record<string, unknown>, aliases: readonly string[]): boolean {
  const wanted = new Set(aliases.map(canonicalKey))
  return Object.keys(record).some((key) => wanted.has(canonicalKey(key)))
}

function hasCanonicalAlias(headers: readonly string[], aliases: readonly string[]): boolean {
  const wanted = new Set(aliases.map(canonicalKey))
  return headers.some((header) => wanted.has(header))
}

function canonicalKey(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_.-]/g, '')
}

function scanForSensitiveKeys(value: unknown): void {
  const stack: unknown[] = [value]
  let inspected = 0
  while (stack.length > 0) {
    const current = stack.pop()
    inspected += 1
    if (inspected > 100_000) {
      throw new SafeImportError('IMPORT_STRUCTURE_TOO_COMPLEX', '导入文件结构过于复杂')
    }
    if (Array.isArray(current)) {
      for (const item of current) stack.push(item)
      continue
    }
    if (!current || typeof current !== 'object') continue
    for (const [key, nested] of Object.entries(current as Record<string, unknown>)) {
      assertNotSensitiveKey(key)
      if (nested && typeof nested === 'object') stack.push(nested)
    }
  }
}

function assertNotSensitiveKey(key: string): void {
  const canonical = canonicalKey(key)
  if (SENSITIVE_KEY_PARTS.some((part) => canonical.includes(part))) {
    throw new SafeImportError('SENSITIVE_FIELD', '导入文件不能包含 Cookie、Token、密码或其他登录凭证字段')
  }
}

function assertSafeUrlParameter(key: string): void {
  const canonical = canonicalKey(key)
  if (SENSITIVE_URL_KEY_PARTS.some((part) => canonical.includes(part))) {
    throw new SafeImportError('SENSITIVE_FIELD', 'URL 中不能包含签名、授权码或其他登录凭证参数')
  }
}

class WarningCollector {
  private readonly warnings: string[] = []
  private truncated = false

  add(warning: string): void {
    if (this.truncated) return
    if (this.warnings.length < MAX_IMPORT_WARNINGS - 1) {
      this.warnings.push(warning)
      return
    }
    this.warnings.push('其余警告已省略')
    this.truncated = true
  }

  values(): string[] {
    return [...this.warnings]
  }
}

function stripBom(source: string): string {
  return source.charCodeAt(0) === 0xfeff ? source.slice(1) : source
}
