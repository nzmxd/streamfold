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
    },
    dialog: { showSaveDialog: vi.fn(async () => ({ canceled: true })) }
  }
})

vi.mock('electron', () => ({
  dialog: electronMock.dialog,
  ipcMain: electronMock.ipcMain,
  nativeTheme: electronMock.nativeTheme
}))

import { registerIpc, unregisterIpc, type IpcServices } from './ipc'

describe('IPC trust and maintenance boundary', () => {
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

  it('validates account metric queries inside the trusted renderer boundary', async () => {
    const fixture = ipcFixture()
    registerIpc(fixture.window, fixture.database, fixture.browser, fixture.services)
    const handler = requiredHandler('analytics:account-metrics')

    await expect(handler(eventFixture(fixture), {
      accountId: 'account-1',
      period: 'last_14_days',
      limit: 2
    })).resolves.toMatchObject({ accountId: 'account-1', platformId: 'zhihu' })
    expect(fixture.database.getAccountMetricHistory).toHaveBeenCalledWith({
      accountId: 'account-1',
      period: 'last_14_days',
      limit: 2
    })

    await expect(handler(eventFixture(fixture), {
      accountId: 'account-1',
      period: 'weekly'
    })).rejects.toThrow('账号指标周期无效')
    await expect(handler(eventFixture(fixture, { senderId: 999 }), {
      accountId: 'account-1',
      period: 'daily'
    })).rejects.toThrow('远程页面')
  })

  it('records the failing IPC channel with its trusted sender origin', async () => {
    const fixture = ipcFixture()
    fixture.pluginHost.listPackages.mockImplementationOnce(() => { throw new Error('catalog failed') })
    registerIpc(fixture.window, fixture.database, fixture.browser, fixture.services)

    await expect(requiredHandler('plugins:packages')(eventFixture(fixture)))
      .rejects.toThrow('catalog failed')
    expect(fixture.services.logs.captureError).toHaveBeenCalledWith(
      'ipc',
      expect.any(Error),
      { channel: 'plugins:packages', senderUrl: 'app://shell/index.html' }
    )
  })

  it('keeps update maintenance active after schedulers stop and installation starts', async () => {
    const fixture = ipcFixture()
    const activePackages = deferred<Array<{ id: string }>>()
    fixture.pluginHost.listPackages.mockImplementationOnce(() => activePackages.promise)
    registerIpc(fixture.window, fixture.database, fixture.browser, fixture.services)

    const packages = requiredHandler('plugins:packages')
    const activeRequest = packages(eventFixture(fixture))
    const installation = requiredHandler('updates:restart-and-install')(eventFixture(fixture))

    await vi.waitFor(() => expect(fixture.syncBatches.stop).toHaveBeenCalledOnce())
    await expect(packages(eventFixture(fixture))).rejects.toThrow('应用正在准备安装更新')
    expect(fixture.updates.restartAndInstall).not.toHaveBeenCalled()

    activePackages.resolve([{ id: 'safe-package' }])
    await expect(activeRequest).resolves.toEqual([{ id: 'safe-package' }])
    await expect(installation).resolves.toBeUndefined()

    expect(fixture.syncBatches.stop).toHaveBeenCalledOnce()
    expect(fixture.pluginAutomation.stop).toHaveBeenCalledOnce()
    expect(fixture.updates.restartAndInstall).toHaveBeenCalledOnce()
    expect(fixture.syncBatches.start).not.toHaveBeenCalled()
    expect(fixture.pluginAutomation.start).not.toHaveBeenCalled()
    await expect(packages(eventFixture(fixture)))
      .rejects.toThrow('应用正在准备安装更新')
  })

  it('restores schedulers and IPC access when update installation cannot start', async () => {
    const fixture = ipcFixture()
    fixture.updates.restartAndInstall.mockImplementation(() => { throw new Error('installer failed') })
    registerIpc(fixture.window, fixture.database, fixture.browser, fixture.services)

    await expect(requiredHandler('updates:restart-and-install')(eventFixture(fixture)))
      .rejects.toThrow('installer failed')

    expect(fixture.pluginAutomation.start).toHaveBeenCalledOnce()
    expect(fixture.syncBatches.start).toHaveBeenCalledOnce()
    await expect(requiredHandler('plugins:packages')(eventFixture(fixture)))
      .resolves.toEqual([{ id: 'safe-package' }])
  })

  it('rechecks running tasks after schedulers stop and restores them on rejection', async () => {
    const fixture = ipcFixture()
    fixture.syncBatches.hasRunningTasks.mockReturnValue(true)
    registerIpc(fixture.window, fixture.database, fixture.browser, fixture.services)

    await expect(requiredHandler('updates:restart-and-install')(eventFixture(fixture)))
      .rejects.toThrow('当前仍有任务正在运行')

    expect(fixture.updates.restartAndInstall).not.toHaveBeenCalled()
    expect(fixture.pluginAutomation.start).toHaveBeenCalledOnce()
    expect(fixture.syncBatches.start).toHaveBeenCalledOnce()
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
    listPackages: vi.fn<() => unknown>(() => [{ id: 'safe-package' }])
  }
  const pluginLifecycle = {
    installDevelopment: vi.fn(async () => null)
  }
  const pluginAutomation = {
    onChanged: vi.fn(() => vi.fn()),
    stop: vi.fn(),
    start: vi.fn(),
    hasRunningTasks: vi.fn(() => false)
  }
  const syncBatches = {
    stop: vi.fn(),
    start: vi.fn(),
    hasRunningTasks: vi.fn(() => false)
  }
  const updates = {
    subscribe: vi.fn(() => vi.fn()),
    getState: vi.fn(() => ({ phase: 'downloaded' })),
    restartAndInstall: vi.fn()
  }
  const services = {
    logs: {
      onChanged: vi.fn(() => vi.fn()),
      captureError: vi.fn(),
      list: vi.fn(() => ({ items: [], total: 0, fileBytes: 0, scopes: [] })),
      exportTo: vi.fn(),
      clear: vi.fn()
    },
    pluginHost,
    pluginLifecycle,
    pluginAutomation,
    syncBatches,
    jobs: { onChanged: vi.fn(() => vi.fn()) },
    updates
  } as unknown as IpcServices
  const database = {
    getAccountMetricHistory: vi.fn(() => ({
      accountId: 'account-1',
      platformId: 'zhihu',
      metricDefinitions: [],
      snapshots: []
    }))
  } as unknown as Parameters<typeof registerIpc>[1]
  return {
    mainFrame,
    window,
    pluginHost,
    pluginLifecycle,
    pluginAutomation,
    syncBatches,
    updates,
    services,
    database,
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

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((currentResolve) => { resolve = currentResolve })
  return { promise, resolve }
}
