import type { IpcRenderer } from 'electron'
import {
  IPC_TRANSPORT_MAX_BYTES,
  socialVaultEventChannels,
  socialVaultInvokeChannels,
  type RuntimePlatform,
  type SocialVaultBridge,
  type SocialVaultEventChannel,
  type SocialVaultInvokeChannel
} from '../shared/contracts'

const invokeChannelSet = new Set<string>(socialVaultInvokeChannels)
const eventChannelSet = new Set<string>(socialVaultEventChannels)
const MAX_NESTING_DEPTH = 64

function rejection(detail: string): TypeError {
  return new TypeError(process.env.NODE_ENV === 'production'
    ? 'IPC 请求参数无效。'
    : `[IPC transport] ${detail}`)
}

function validateDecodedArgs(value: unknown): asserts value is unknown[] {
  if (!Array.isArray(value)) throw rejection('serialized arguments must decode to an array')
  const pending: Array<{ value: unknown; depth: number }> = value.map((item) => ({ value: item, depth: 0 }))
  while (pending.length > 0) {
    const current = pending.pop()
    if (!current || current.value === null || typeof current.value !== 'object') continue
    if (current.depth > MAX_NESTING_DEPTH) throw rejection(`arguments exceed ${MAX_NESTING_DEPTH} nesting levels`)
    const children = Array.isArray(current.value)
      ? current.value
      : Object.values(current.value as Record<string, unknown>)
    for (const child of children) pending.push({ value: child, depth: current.depth + 1 })
  }
}

export function decodeIpcArgs(channel: string, serializedArgs: unknown): unknown[] {
  if (!invokeChannelSet.has(channel)) throw rejection(`channel ${JSON.stringify(channel)} is not allowed`)
  if (typeof serializedArgs !== 'string') throw rejection(`channel ${channel} requires a JSON string payload`)
  if (Buffer.byteLength(serializedArgs, 'utf8') > IPC_TRANSPORT_MAX_BYTES) {
    throw rejection(`channel ${channel} payload exceeds ${IPC_TRANSPORT_MAX_BYTES} bytes`)
  }

  let decoded: unknown
  try {
    decoded = JSON.parse(serializedArgs)
  } catch {
    throw rejection(`channel ${channel} payload is not valid JSON`)
  }
  validateDecodedArgs(decoded)
  return decoded
}

export function createSocialVaultBridge(
  renderer: Pick<IpcRenderer, 'invoke' | 'on' | 'removeListener'>,
  platform: RuntimePlatform
): SocialVaultBridge {
  return {
    runtime: { platform },
    invoke: (channel: SocialVaultInvokeChannel, serializedArgs: string) => {
      const args = decodeIpcArgs(channel, serializedArgs)
      return renderer.invoke(channel, ...args)
    },
    on: (channel: SocialVaultEventChannel, callback: (payload?: unknown) => void) => {
      if (!eventChannelSet.has(channel)) throw rejection(`event channel ${JSON.stringify(channel)} is not allowed`)
      if (typeof callback !== 'function') throw rejection(`event channel ${channel} requires a callback`)
      const listener = (_event: Electron.IpcRendererEvent, payload?: unknown): void => callback(payload)
      renderer.on(channel, listener)
      return () => renderer.removeListener(channel, listener)
    }
  }
}
