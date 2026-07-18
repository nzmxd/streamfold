import {
  isSensitiveBackgroundFieldName,
  SENSITIVE_CREDENTIAL_FIELD_PATTERN_SOURCE
} from '../../shared/plugin-host-contracts'

const MAX_DIAGNOSTIC_SOURCE_LENGTH = 64_000
const MAX_DIAGNOSTIC_LENGTH = 16_000
const MAX_DIAGNOSTIC_DEPTH = 5
const MAX_DIAGNOSTIC_PROPERTIES = 40
const MAX_DIAGNOSTIC_ARRAY_ITEMS = 30
const MAX_DIAGNOSTIC_NODES = 200
const MAX_DIAGNOSTIC_CHARACTERS = 14_000
const MAX_DIAGNOSTIC_STRING_LENGTH = 8_000
const MAX_HEADLINE_LENGTH = 8_000
const SENSITIVE_KEY = SENSITIVE_CREDENTIAL_FIELD_PATTERN_SOURCE
const INLINE_SECRET = new RegExp(`\\b(${SENSITIVE_KEY}\\b\\s*[:=]\\s*)[^\\s,;&#]+`, 'gi')
const DOUBLE_QUOTED_INLINE_SECRET = new RegExp(`\\b(${SENSITIVE_KEY}\\s*[:=]\\s*)"(?:\\\\.|[^"\\\\])*"`, 'gi')
const SINGLE_QUOTED_INLINE_SECRET = new RegExp(`\\b(${SENSITIVE_KEY}\\s*[:=]\\s*)'(?:\\\\.|[^'\\\\])*'`, 'gi')
const UNTERMINATED_DOUBLE_QUOTED_INLINE_SECRET = new RegExp(`\\b(${SENSITIVE_KEY}\\s*[:=]\\s*)"(?:\\\\.|[^"\\\\\\r\\n])*(?=$|\\r?\\n)`, 'gim')
const UNTERMINATED_SINGLE_QUOTED_INLINE_SECRET = new RegExp(`\\b(${SENSITIVE_KEY}\\s*[:=]\\s*)'(?:\\\\.|[^'\\\\\\r\\n])*(?=$|\\r?\\n)`, 'gim')
const LINE_TAIL_SECRET = new RegExp(`(?<![?&#])\\b(${SENSITIVE_KEY}\\s*[:=]\\s*)(?!["'])[^\\r\\n]+`, 'gi')
const HEADER_SECRET = new RegExp(`(^|\\n)([ \\t]*${SENSITIVE_KEY}\\s*:\\s*)[^\\r\\n]*(?:\\n[ \\t]+[^\\r\\n]*)*`, 'gim')
const PASSWORD_LINE_SECRET = /(?<![?&#])\b((?:password|passwd|pwd|passphrase)\s*[:=]\s*)[^\r\n]+/gi
const COOKIE_LINE_SECRET = /(?<![?&#])\b([a-z0-9_.-]*cookie[a-z0-9_.-]*\s*[:=]\s*)[^\r\n]+/gi
const AUTH_SCHEME_SECRET = /\b(Bearer|Basic|Digest|Negotiate|Token)\s+[^\s,;]+/gi
const JWT_SECRET = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{8,})?\b/g
const COMMON_COOKIE_SECRET = /\b(a1|sid|sapisid|hsid|ssid|apisid|lsid|osid|sessdata|bili[_-]?jct|web[_-]?session|webid|xsecappid|auth[_-]?token|ct0|twid|ttwid|odin[_-]?tt|z_c0|d_c0|q_c1|__secure[-_. ]?(?:1p|3p)(?:sid(?:ts|cc)?|apisid)|sidcc|psidts)\s*=\s*[^\s;,&#]+/gi
const PRIVATE_KEY_SECRET = /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)? PRIVATE KEY-----/g
const UNTERMINATED_PRIVATE_KEY_SECRET = /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----[\s\S]*$/g
const ARROW_SECRET = new RegExp(`\\b(${SENSITIVE_KEY})\\b\\s*(?:->|=>)\\s*[^\\r\\n]+`, 'gi')
const NARRATIVE_SECRET = new RegExp(`\\b(${SENSITIVE_KEY})\\b\\s+(?:is|was|equals?)\\s+[^\\r\\n]+`, 'gi')
const DOUBLE_QUOTED_PAIR = /("((?:\\.|[^"\\]){1,500})"\s*:\s*)"(?:\\.|[^"\\])*"/g
const SINGLE_QUOTED_PAIR = /('((?:\\.|[^'\\]){1,500})'\s*:\s*)'(?:\\.|[^'\\])*'/g
const UNTERMINATED_DOUBLE_QUOTED_PAIR = /("((?:\\.|[^"\\]){1,500})"\s*:\s*)"(?:\\.|[^"\\\r\n])*(?=$|\r?\n)/gm
const UNTERMINATED_SINGLE_QUOTED_PAIR = /('((?:\\.|[^'\\]){1,500})'\s*:\s*)'(?:\\.|[^'\\\r\n])*(?=$|\r?\n)/gm
const ESCAPED_DOUBLE_QUOTED_PAIR = /(\\"((?:\\\\.|[^"\\]){1,500})\\"\s*:\s*)\\"(?:\\\\.|[^"\\])*\\"/g
const UNTERMINATED_ESCAPED_DOUBLE_QUOTED_PAIR = /(\\"((?:\\\\.|[^"\\]){1,500})\\"\s*:\s*)\\"(?:\\\\.|[^"\\\r\n])*(?=$|\r?\n)/gm

interface DiagnosticBudget {
  nodes: number
  characters: number
}

export function formatSandboxDiagnostic(error: unknown): string | undefined {
  const sections: string[] = []
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
        sections.push(`${label ? `${label}\n` : ''}[Circular error reference]`)
        return
      }
      visited.add(record)
    }

    const nameValue = record ? safeDataProperty(record, 'name') : undefined
    const messageValue = record ? safeDataProperty(record, 'message') : undefined
    const stackValue = record ? safeDataProperty(record, 'stack') : undefined
    const name = typeof nameValue === 'string' && nameValue ? nameValue : depth === 0 ? 'PluginError' : 'Cause'
    const message = typeof messageValue === 'string'
      ? messageValue
      : value === undefined || value === null
        ? ''
        : safeString(value)
    const headline = diagnosticText(
      typeof stackValue === 'string' && stackValue ? stackValue : [name, message].filter(Boolean).join(': '),
      budget,
      MAX_HEADLINE_LENGTH
    )
    if (headline) sections.push(label ? `${label}\n${headline}` : headline)

    if (!record) return
    serialized.add(record)
    const properties = diagnosticProperties(
      record,
      new Set(['name', 'message', 'stack', 'cause', 'errors']),
      budget,
      serialized
    )
    if (Object.keys(properties).length > 0) {
      const propertyText = diagnosticText(safeJson(properties), budget, MAX_DIAGNOSTIC_STRING_LENGTH)
      if (propertyText) sections.push(`${label ? `${label} ` : ''}错误属性\n${propertyText}`)
    }

    const errors = safeArrayItems(safeDataProperty(record, 'errors'), MAX_DIAGNOSTIC_ARRAY_ITEMS)
    if (errors) {
      for (const [index, item] of errors.items.entries()) append(item, `聚合错误 ${index + 1}`, depth + 1)
      if (errors.truncated) sections.push('聚合错误\n[Additional errors truncated]')
    }
    const cause = safeDataProperty(record, 'cause')
    if (cause !== undefined) append(cause, '原因', depth + 1)
  }

  append(error, '', 0)
  const diagnostic = sanitizeSandboxDiagnostic(sections.join('\n\n'))
  return diagnostic || undefined
}

export function sanitizeSandboxDiagnostic(value: string): string {
  let text = value.slice(0, MAX_DIAGNOSTIC_SOURCE_LENGTH)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
  text = redactPercentEncodedSecrets(redactQuotedSecrets(redactHttpUrls(text)
    .replace(PRIVATE_KEY_SECRET, '[REDACTED_PRIVATE_KEY]')
    .replace(UNTERMINATED_PRIVATE_KEY_SECRET, '[REDACTED_PRIVATE_KEY]')
    .replace(HEADER_SECRET, '$1$2[REDACTED]')
    .replace(DOUBLE_QUOTED_INLINE_SECRET, '$1"[REDACTED]"')
    .replace(SINGLE_QUOTED_INLINE_SECRET, "$1'[REDACTED]'")
    .replace(UNTERMINATED_DOUBLE_QUOTED_INLINE_SECRET, '$1"[REDACTED]"')
    .replace(UNTERMINATED_SINGLE_QUOTED_INLINE_SECRET, "$1'[REDACTED]'")
    .replace(LINE_TAIL_SECRET, '$1[REDACTED]')
    .replace(PASSWORD_LINE_SECRET, '$1[REDACTED]')
    .replace(COOKIE_LINE_SECRET, '$1[REDACTED]')
    .replace(ARROW_SECRET, '$1 -> [REDACTED]')
    .replace(NARRATIVE_SECRET, '$1 is [REDACTED]')
    .replace(AUTH_SCHEME_SECRET, '$1 [REDACTED]')
    .replace(JWT_SECRET, '[REDACTED_JWT]')
    .replace(COMMON_COOKIE_SECRET, '$1=[REDACTED]')
    .replace(INLINE_SECRET, '$1[REDACTED]')))
  return text.slice(0, MAX_DIAGNOSTIC_LENGTH).trim()
}

function diagnosticProperties(
  record: Record<string, unknown>,
  excluded: ReadonlySet<string>,
  budget: DiagnosticBudget,
  seen: WeakSet<object>
): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  const names = safePropertyNames(record)
  for (const key of names.slice(0, MAX_DIAGNOSTIC_PROPERTIES)) {
    if (budget.nodes <= 0 || budget.characters <= 0) {
      result.diagnosticTruncated = true
      break
    }
    if (excluded.has(key)) continue
    const field = safeOwnDataProperty(record, key)
    if (!field.found) continue
    const cleanKey = diagnosticPropertyKey(key)
    result[cleanKey] = isSensitiveDiagnosticKey(key)
      ? '[REDACTED]'
      : diagnosticValue(field.value, 0, seen, budget)
  }
  if (names.length > MAX_DIAGNOSTIC_PROPERTIES) result.diagnosticTruncated = true
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
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : safeString(value)
  if (typeof value === 'string') return sanitizedValueText(value, MAX_DIAGNOSTIC_STRING_LENGTH)
  if (typeof value === 'bigint') return sanitizedValueText(safeString(value), 200)
  if (typeof value === 'undefined') return '[undefined]'
  if (typeof value === 'function') {
    const name = safeDataProperty(value as unknown as Record<string, unknown>, 'name')
    return `[Function ${typeof name === 'string' ? sanitizedValueText(name, 120) : 'anonymous'}]`
  }
  if (typeof value !== 'object') return sanitizedValueText(safeString(value), 200)
  if (seen.has(value)) return '[Circular]'
  if (depth >= MAX_DIAGNOSTIC_DEPTH) return '[Maximum depth reached]'
  seen.add(value)

  const array = safeArrayItems(value, MAX_DIAGNOSTIC_ARRAY_ITEMS)
  if (array) {
    const items = array.items.map((item) => diagnosticValue(item, depth + 1, seen, budget))
    if (array.truncated) items.push('[Additional items truncated]')
    return items
  }

  const result: Record<string, unknown> = {}
  const names = safePropertyNames(value)
  for (const key of names.slice(0, MAX_DIAGNOSTIC_PROPERTIES)) {
    if (budget.nodes <= 0 || budget.characters <= 0) {
      result.diagnosticTruncated = true
      break
    }
    const field = safeOwnDataProperty(value, key)
    if (!field.found) continue
    const cleanKey = diagnosticPropertyKey(key)
    result[cleanKey] = isSensitiveDiagnosticKey(key)
      ? '[REDACTED]'
      : diagnosticValue(field.value, depth + 1, seen, budget)
  }
  if (names.length > MAX_DIAGNOSTIC_PROPERTIES) result.diagnosticTruncated = true
  return result
}

function diagnosticText(value: unknown, budget: DiagnosticBudget, maximum: number): string {
  const allowance = Math.max(0, Math.min(maximum, budget.characters))
  if (allowance === 0) return ''
  const text = sanitizeSandboxDiagnostic(safeString(value)).slice(0, allowance)
  budget.characters = Math.max(0, budget.characters - text.length)
  return text
}

function sanitizedValueText(value: unknown, maximum: number): string {
  return sanitizeSandboxDiagnostic(safeString(value)).slice(0, maximum)
}

function diagnosticPropertyKey(value: string): string {
  return sanitizeSandboxDiagnostic(value).replace(/\s+/gu, ' ').slice(0, 160) || 'field'
}

function redactQuotedSecrets(value: string): string {
  const redactDouble = (match: string, prefix: string, rawKey: string): string => (
    isSensitiveDiagnosticKey(decodeJsonKey(rawKey)) ? `${prefix}"[REDACTED]"` : match
  )
  const redactSingle = (match: string, prefix: string, rawKey: string): string => (
    isSensitiveDiagnosticKey(rawKey.replace(/\\'/g, "'")) ? `${prefix}'[REDACTED]'` : match
  )
  const redactEscaped = (match: string, prefix: string, rawKey: string): string => (
    isSensitiveDiagnosticKey(decodeJsonKey(rawKey)) ? `${prefix}\\"[REDACTED]\\"` : match
  )
  return value
    .replace(DOUBLE_QUOTED_PAIR, redactDouble)
    .replace(SINGLE_QUOTED_PAIR, redactSingle)
    .replace(UNTERMINATED_DOUBLE_QUOTED_PAIR, redactDouble)
    .replace(UNTERMINATED_SINGLE_QUOTED_PAIR, redactSingle)
    .replace(ESCAPED_DOUBLE_QUOTED_PAIR, redactEscaped)
    .replace(UNTERMINATED_ESCAPED_DOUBLE_QUOTED_PAIR, redactEscaped)
}

function redactPercentEncodedSecrets(value: string): string {
  return value.replace(/(?:[A-Za-z0-9_.~+-]|%[0-9A-Fa-f]{2}){6,}/g, (candidate) => {
    if (!candidate.includes('%')) return candidate
    try {
      const decoded = decodeURIComponent(candidate.replace(/\+/g, '%20'))
      return containsSensitiveAssignment(decoded) ? '[REDACTED_URL_ENCODED_DATA]' : candidate
    } catch {
      return candidate
    }
  })
}

function containsSensitiveAssignment(value: string): boolean {
  if (/\b(?:Bearer|Basic|Digest|Negotiate|Token)\s+/iu.test(value)) return true
  const assignments = /([A-Za-z0-9_. -]{1,100})\s*[:=]/g
  for (const match of value.matchAll(assignments)) {
    if (isSensitiveDiagnosticKey(match[1] ?? '')) return true
  }
  return false
}

function decodeJsonKey(value: string): string {
  let decoded = value
  for (let depth = 0; depth < 2; depth += 1) {
    try {
      const next = JSON.parse(`"${decoded}"`) as string
      if (next === decoded) break
      decoded = next
    } catch {
      break
    }
  }
  return decoded
}

function redactHttpUrls(value: string): string {
  return value.replace(/https?:\/\/[^\s"'<>\])}]+/gi, (candidate) => {
    let source = candidate
    let suffix = ''
    while (/[),.;\]]$/u.test(source)) {
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
        if (isSensitiveDiagnosticKey(key) || /^(?:code|state)$/iu.test(key)) {
          url.searchParams.set(key, '[REDACTED]')
        }
      }
      if (url.hash.length > 1) {
        const fragment = new URLSearchParams(url.hash.slice(1))
        let changed = false
        for (const key of [...fragment.keys()]) {
          if (isSensitiveDiagnosticKey(key) || /^(?:code|state)$/iu.test(key)) {
            fragment.set(key, '[REDACTED]')
            changed = true
          }
        }
        if (changed) url.hash = fragment.toString()
      }
      return `${url.toString()}${suffix}`.replace(/%5BREDACTED%5D/giu, '[REDACTED]')
    } catch {
      return candidate
    }
  })
}

function isSensitiveDiagnosticKey(key: string): boolean {
  return isSensitiveBackgroundFieldName(key)
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

function safeArrayItems(
  value: unknown,
  maximum: number
): { items: unknown[]; truncated: boolean } | null {
  try {
    if (!Array.isArray(value)) return null
    const length = Math.min(value.length, maximum)
    return {
      items: Array.from({ length }, (_, index) => safeDataProperty(value, String(index))),
      truncated: value.length > maximum
    }
  } catch {
    return null
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return '[Unavailable diagnostic properties]'
  }
}

function safeString(value: unknown): string {
  try {
    return String(value)
  } catch {
    return '[Unavailable value]'
  }
}
