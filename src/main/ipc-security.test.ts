import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'

const electronMock = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  return {
    handlers,
    ipcMain: {
      handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(channel, handler)
      }),
      removeHandler: vi.fn((channel: string) => handlers.delete(channel))
    },
    nativeTheme: {
      themeSource: 'system',
      shouldUseDarkColors: false,
      on: vi.fn(),
      removeListener: vi.fn()
    }
  }
})

vi.mock('electron', () => ({
  ipcMain: electronMock.ipcMain,
  nativeTheme: electronMock.nativeTheme
}))

import { registerIpc, unregisterIpc, type IpcServices } from './ipc'

describe('plugin IPC trust boundary', () => {
  beforeEach(() => {
    electronMock.handlers.clear()
    vi.clearAllMocks()
  })

  afterEach(() => {
    unregisterIpc()
  })

  it('rejects remote WebContents, child frames and non-shell origins before calling plugin services', async () => {
    const fixture = ipcFixture()
    registerIpc(fixture.window, fixture.database, fixture.browser, fixture.services)
    const handler = requiredHandler('plugins:packages')

    await expect(handler(eventFixture(fixture, { senderId: 999 }))).rejects.toThrow('远程页面')
    await expect(handler(eventFixture(fixture, { childFrame: true }))).rejects.toThrow('子框架')
    fixture.mainFrame.url = 'https://evil.example/plugin-center'
    await expect(handler(eventFixture(fixture))).rejects.toThrow('管理界面来源无效')

    expect(fixture.pluginHost.listPackages).not.toHaveBeenCalled()
  })

  it('allows the exact local main frame and does not accept a renderer-supplied development package path', async () => {
    const fixture = ipcFixture()
    registerIpc(fixture.window, fixture.database, fixture.browser, fixture.services)

    await expect(requiredHandler('plugins:packages')(eventFixture(fixture)))
      .resolves.toEqual([{ id: 'safe-package' }])
    await expect(requiredHandler('plugins:install-development')(
      eventFixture(fixture),
      'C:\\Users\\attacker\\untrusted.streamfold-plugin'
    )).resolves.toBeNull()

    expect(fixture.pluginHost.listPackages).toHaveBeenCalledOnce()
    expect(fixture.pluginLifecycle.installDevelopment).toHaveBeenCalledWith()
  })
})

function ipcFixture() {
  const mainFrame = { url: 'app://shell/index.html' }
  const webContents = {
    id: 42,
    mainFrame,
    send: vi.fn()
  }
  const window = {
    webContents,
    isDestroyed: () => false,
    setTitleBarOverlay: vi.fn()
  } as unknown as BrowserWindow
  const pluginHost = {
    listPackages: vi.fn(() => [{ id: 'safe-package' }])
  }
  const pluginLifecycle = {
    installDevelopment: vi.fn(async () => null)
  }
  const services = {
    pluginHost,
    pluginLifecycle,
    updates: { subscribe: vi.fn(() => vi.fn()) }
  } as unknown as IpcServices
  return {
    mainFrame,
    window,
    pluginHost,
    pluginLifecycle,
    services,
    database: {} as Parameters<typeof registerIpc>[1],
    browser: { applyAppearance: vi.fn() } as unknown as Parameters<typeof registerIpc>[2]
  }
}

function eventFixture(
  fixture: ReturnType<typeof ipcFixture>,
  options: { senderId?: number; childFrame?: boolean } = {}
): IpcMainInvokeEvent {
  return {
    sender: { id: options.senderId ?? 42 },
    senderFrame: options.childFrame ? { url: 'app://shell/child.html' } : fixture.mainFrame
  } as unknown as IpcMainInvokeEvent
}

function requiredHandler(channel: string): (...args: unknown[]) => Promise<unknown> {
  const handler = electronMock.handlers.get(channel)
  if (!handler) throw new Error(`missing IPC handler: ${channel}`)
  return async (...args: unknown[]) => await handler(...args)
}
