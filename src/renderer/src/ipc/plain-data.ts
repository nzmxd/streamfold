import type { SocialVaultInvokeChannel } from '../../../shared/contracts'
import { IPC_TRANSPORT_MAX_BYTES } from '../../../shared/contracts'

const MAX_NESTING_DEPTH = 64
const SUPPORTED_VALUE_DESCRIPTION = '仅支持 null、布尔值、有限数字、字符串、数组和普通对象'

interface CloneContext {
  channel: SocialVaultInvokeChannel
  argumentIndex: number
  development: boolean
  ancestors: WeakSet<object>
}

export interface IpcPlainDataOptions {
  development?: boolean
}

export class IpcArgumentSerializationError extends TypeError {
  readonly code = 'ERR_IPC_ARGUMENT_NOT_CLONEABLE'
  readonly channel: SocialVaultInvokeChannel
  readonly argumentIndex: number
  readonly valuePath: string

  constructor(
    channel: SocialVaultInvokeChannel,
    argumentIndex: number,
    valuePath: string,
    reason: string,
    development: boolean
  ) {
    super(development
      ? `[IPC ${channel}] 参数 ${argumentIndex + 1}（${valuePath}）${reason}；${SUPPORTED_VALUE_DESCRIPTION}。`
      : '无法发送请求：参数包含不支持的数据。')
    this.name = 'IpcArgumentSerializationError'
    this.channel = channel
    this.argumentIndex = argumentIndex
    this.valuePath = valuePath
  }
}

function fail(context: CloneContext, path: string, reason: string): never {
  throw new IpcArgumentSerializationError(
    context.channel,
    context.argumentIndex,
    path,
    reason,
    context.development
  )
}

function propertyPath(parent: string, key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? `${parent}.${key}` : `${parent}[${JSON.stringify(key)}]`
}

function cloneValue(value: unknown, context: CloneContext, path: string, depth: number): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(context, path, '包含非有限数字')
    return value
  }
  if (value === undefined) return undefined
  if (typeof value === 'function') fail(context, path, '包含函数')
  if (typeof value === 'symbol') fail(context, path, '包含 Symbol')
  if (typeof value === 'bigint') fail(context, path, '包含 BigInt')
  if (depth > MAX_NESTING_DEPTH) fail(context, path, `嵌套层级超过 ${MAX_NESTING_DEPTH} 层`)

  const objectValue = value as object
  if (context.ancestors.has(objectValue)) fail(context, path, '包含循环引用')
  context.ancestors.add(objectValue)

  try {
    if (Array.isArray(objectValue)) {
      const output: unknown[] = []
      for (let index = 0; index < objectValue.length; index += 1) {
        const item = objectValue[index]
        if (item === undefined) fail(context, `${path}[${index}]`, '包含 undefined 数组项')
        output.push(cloneValue(item, context, `${path}[${index}]`, depth + 1))
      }
      return output
    }

    const prototype = Object.getPrototypeOf(objectValue)
    if (prototype !== Object.prototype && prototype !== null) {
      const objectName = prototype?.constructor?.name
      fail(context, path, `包含非普通对象${objectName ? ` ${objectName}` : ''}`)
    }

    const output: Record<string, unknown> = {}
    for (const key of Reflect.ownKeys(objectValue)) {
      if (typeof key === 'symbol') fail(context, path, '包含 Symbol 属性')
      const descriptor = Object.getOwnPropertyDescriptor(objectValue, key)
      if (!descriptor || !descriptor.enumerable) continue
      const nextPath = propertyPath(path, key)
      if ('get' in descriptor || 'set' in descriptor) fail(context, nextPath, '包含访问器属性')
      if (descriptor.value === undefined) continue
      Object.defineProperty(output, key, {
        configurable: true,
        enumerable: true,
        writable: true,
        value: cloneValue(descriptor.value, context, nextPath, depth + 1)
      })
    }
    return output
  } catch (cause) {
    if (cause instanceof IpcArgumentSerializationError) throw cause
    fail(context, path, '无法安全读取')
  } finally {
    context.ancestors.delete(objectValue)
  }
}

function developmentMode(options?: IpcPlainDataOptions): boolean {
  return options?.development ?? import.meta.env.DEV
}

/**
 * Detaches Vue reactive proxies and validates a single business value. This is
 * also used by form state that needs an independent, plain-data copy.
 */
export function cloneIpcPlainValue(
  channel: SocialVaultInvokeChannel,
  value: unknown,
  argumentIndex = 0,
  options?: IpcPlainDataOptions
): unknown {
  return cloneValue(value, {
    channel,
    argumentIndex,
    development: developmentMode(options),
    ancestors: new WeakSet()
  }, `$[${argumentIndex}]`, 0)
}

/**
 * Serializes arguments in the renderer, before invoking any contextBridge
 * function. Trailing undefined optional arguments and undefined object fields
 * are omitted; undefined array entries are rejected to avoid ambiguous data.
 */
export function serializeIpcArgs(
  channel: SocialVaultInvokeChannel,
  args: readonly unknown[],
  options?: IpcPlainDataOptions
): string {
  let argumentCount = args.length
  while (argumentCount > 0 && args[argumentCount - 1] === undefined) argumentCount -= 1

  const normalized: unknown[] = []
  for (let index = 0; index < argumentCount; index += 1) {
    const value = args[index]
    if (value === undefined) {
      throw new IpcArgumentSerializationError(
        channel,
        index,
        `$[${index}]`,
        '包含位于必填参数之间的 undefined',
        developmentMode(options)
      )
    }
    normalized.push(cloneIpcPlainValue(channel, value, index, options))
  }

  const serialized = JSON.stringify(normalized)
  const byteLength = new TextEncoder().encode(serialized).byteLength
  if (byteLength > IPC_TRANSPORT_MAX_BYTES) {
    throw new IpcArgumentSerializationError(
      channel,
      0,
      '$',
      `序列化后超过 ${IPC_TRANSPORT_MAX_BYTES} 字节`,
      developmentMode(options)
    )
  }
  return serialized
}
