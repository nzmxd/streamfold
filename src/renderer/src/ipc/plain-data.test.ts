import { reactive } from 'vue'
import { describe, expect, it } from 'vitest'
import {
  IpcArgumentSerializationError,
  serializeIpcArgs
} from './plain-data'

describe('renderer IPC plain-data serialization', () => {
  it('detaches Vue proxies before they reach the contextBridge transport', () => {
    const input = reactive({
      values: { fields: ['account', 'profile'] },
      clearSecrets: [] as string[],
      omitted: undefined
    })

    const serialized = serializeIpcArgs('plugins:save-config', [input], { development: true })
    const decoded = JSON.parse(serialized)

    expect(decoded).toEqual([{
      values: { fields: ['account', 'profile'] },
      clearSecrets: []
    }])
    expect(decoded[0]).not.toBe(input)
  })

  it('omits trailing optional arguments without converting them to null', () => {
    expect(serializeIpcArgs('plugins:run', ['plugin', 'action', undefined])).toBe('["plugin","action"]')
    expect(serializeIpcArgs('content:list', [undefined])).toBe('[]')
  })

  it.each([
    ['function', { values: { callback: () => undefined } }, '$[0].values.callback'],
    ['symbol', { values: { token: Symbol('token') } }, '$[0].values.token'],
    ['non-finite number', { values: { count: Number.NaN } }, '$[0].values.count'],
    ['class instance', { values: { date: new Date() } }, '$[0].values.date']
  ])('rejects a %s with the channel and value path in development', (_name, input, path) => {
    expect(() => serializeIpcArgs('plugins:save-config', [input], { development: true }))
      .toThrow(expect.objectContaining({
        code: 'ERR_IPC_ARGUMENT_NOT_CLONEABLE',
        channel: 'plugins:save-config',
        argumentIndex: 0,
        valuePath: path
      }))
  })

  it('rejects circular structures', () => {
    const input: Record<string, unknown> = {}
    input.self = input

    expect(() => serializeIpcArgs('accounts:update', [input], { development: true }))
      .toThrow(/accounts:update.*循环引用/)
  })

  it('uses a safe generic message in production while retaining a stable error code', () => {
    try {
      serializeIpcArgs('settings:update', [{ invalid: () => undefined }], { development: false })
      throw new Error('expected serialization to fail')
    } catch (cause) {
      expect(cause).toBeInstanceOf(IpcArgumentSerializationError)
      expect(cause).toMatchObject({ code: 'ERR_IPC_ARGUMENT_NOT_CLONEABLE' })
      expect((cause as Error).message).toBe('无法发送请求：参数包含不支持的数据。')
      expect((cause as Error).message).not.toContain('settings:update')
    }
  })
})
