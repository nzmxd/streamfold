import { describe, expect, it, vi } from 'vitest'
import type { IpcRenderer } from 'electron'
import { createSocialVaultBridge, decodeIpcArgs } from './social-vault-bridge'

describe('preload social vault transport', () => {
  it('decodes renderer-validated JSON and spreads arguments into Electron IPC', async () => {
    const invoke = vi.fn(async () => 'ok')
    const renderer = {
      invoke,
      on: vi.fn(),
      removeListener: vi.fn()
    } as unknown as Pick<IpcRenderer, 'invoke' | 'on' | 'removeListener'>
    const bridge = createSocialVaultBridge(renderer, 'win32')

    await expect(bridge.invoke('accounts:switch-adapter', '["account","adapter"]')).resolves.toBe('ok')
    expect(invoke).toHaveBeenCalledWith('accounts:switch-adapter', 'account', 'adapter')
  })

  it('rejects channels outside the explicit allowlist', () => {
    expect(() => decodeIpcArgs('shell:open', '[]')).toThrow(/not allowed/)
  })

  it('rejects malformed or non-array transport payloads', () => {
    expect(() => decodeIpcArgs('accounts:list', '{')).toThrow(/not valid JSON/)
    expect(() => decodeIpcArgs('accounts:list', '{}')).toThrow(/decode to an array/)
  })
})
