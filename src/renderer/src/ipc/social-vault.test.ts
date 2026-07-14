import { reactive } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import type { SocialVaultBridge } from '../../../shared/contracts'
import { createSocialVaultApi } from './social-vault'

describe('social vault renderer facade', () => {
  it('passes only a channel and serialized plain-data string to the contextBridge', async () => {
    const invoke = vi.fn(async (_channel: string, _serializedArgs: string) => ({ rawRetentionDays: 30 }))
    const bridge: SocialVaultBridge = {
      runtime: { platform: 'win32' },
      invoke,
      on: vi.fn(() => () => undefined)
    }
    const api = createSocialVaultApi(bridge)
    const reactiveInput = reactive({ rawRetentionDays: 30 })

    await api.settings.update(reactiveInput)

    expect(invoke).toHaveBeenCalledOnce()
    expect(invoke).toHaveBeenCalledWith('settings:update', '[{"rawRetentionDays":30}]')
    expect(typeof invoke.mock.calls[0]?.[1]).toBe('string')
  })

  it('rejects invalid values before calling the contextBridge', () => {
    const invoke = vi.fn(async (_channel: string, _serializedArgs: string) => undefined)
    const bridge: SocialVaultBridge = {
      runtime: { platform: 'win32' },
      invoke,
      on: vi.fn(() => () => undefined)
    }
    const api = createSocialVaultApi(bridge)

    expect(() => api.settings.update({ rawRetentionDays: (() => 30) as never })).toThrow()
    expect(invoke).not.toHaveBeenCalled()
  })
})
