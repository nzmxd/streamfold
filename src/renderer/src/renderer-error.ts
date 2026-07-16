import type { RendererErrorLogInput } from '../../shared/contracts'

type NormalizedRendererError = Pick<RendererErrorLogInput, 'message' | 'code' | 'stack' | 'details'>

export function normalizeRendererError(value: unknown): NormalizedRendererError {
  if (typeof value === 'string') return { message: value || '未知渲染错误' }
  if (!isRecord(value)) return { message: value === null || value === undefined ? '未知渲染错误' : String(value) }

  const message = stringProperty(value, 'message') || stringProperty(value, 'name') ||
    serializeDiagnostic(value) || '未知渲染错误'
  const codeValue = property(value, 'code')
  const code = typeof codeValue === 'string' || typeof codeValue === 'number'
    ? String(codeValue).slice(0, 160)
    : undefined
  const stack = stringProperty(value, 'stack') || undefined
  const details = serializeDiagnostic(value)
  return {
    message: message.slice(0, 1_000),
    ...(code ? { code } : {}),
    ...(stack ? { stack: stack.slice(0, 12_000) } : {}),
    ...(details && details !== message ? { details: details.slice(0, 4_000) } : {})
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (typeof value === 'object' && value !== null) || typeof value === 'function'
}

function property(value: Record<string, unknown>, key: string): unknown {
  try {
    return value[key]
  } catch {
    return undefined
  }
}

function stringProperty(value: Record<string, unknown>, key: string): string {
  const result = property(value, key)
  return typeof result === 'string' ? result : ''
}

function serializeDiagnostic(value: unknown): string {
  const seen = new WeakSet<object>()
  try {
    return JSON.stringify(value, (_key, item: unknown) => {
      if (typeof item === 'bigint') return item.toString()
      if (typeof item === 'function' || typeof item === 'symbol') return String(item)
      if (!item || typeof item !== 'object') return item
      if (seen.has(item)) return '[Circular]'
      seen.add(item)
      if (item instanceof Error) {
        const error = item as Error & { code?: unknown; cause?: unknown }
        return {
          name: error.name,
          message: error.message,
          stack: error.stack,
          code: error.code,
          cause: error.cause
        }
      }
      return item
    })
  } catch {
    return ''
  }
}
