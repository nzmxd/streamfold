import {
  BrowserWindow,
  session as electronSession,
  WebContentsView,
  type IpcMainInvokeEvent,
  type Session
} from 'electron'
import type { Account, BrowserState } from '../shared/contracts'
import type { AdapterOperation, ManagedBrowserAdapter } from './adapters'
import { verifyPinnedScript } from './adapters'
import { getPlatform, isOfficialUrl } from './platforms'
import { isTrustedBrowserUrl } from './shell-security'

const TOOLBAR_HEIGHT = 92

interface ManagedWorkspace {
  account: Account
  window: BrowserWindow
  view: WebContentsView
  senderId: number
  disposed: boolean
  state: BrowserState
}

export class BrowserManager {
  private readonly workspaces = new Map<string, ManagedWorkspace>()
  private readonly senderAccounts = new Map<number, string>()
  private readonly configuredSessions = new Set<string>()
  private readonly disconnecting = new Set<string>()
  private shuttingDown = false

  constructor(
    private readonly mainWindow: BrowserWindow,
    private readonly findAccount: (id: string) => Account | null,
    private readonly browserPreload: string,
    private readonly browserShellUrl: string,
    private readonly showWindows = true
  ) {}

  async open(accountId: string, loadRemote = true): Promise<BrowserState> {
    if (this.disconnecting.has(accountId)) throw new Error('账号正在断开，请稍候')
    const account = this.findAccount(accountId)
    if (!account) throw new Error('账号不存在')

    const existing = this.workspaces.get(accountId)
    if (existing && !existing.window.isDestroyed()) {
      if (existing.window.isMinimized()) existing.window.restore()
      existing.window.show()
      existing.window.focus()
      return { ...existing.state }
    }

    const managed = await this.createWorkspace(account)
    if (loadRemote) void this.safeLoad(managed, getPlatform(account.platformId).loginUrl).catch((cause) => {
      managed.state = {
        ...managed.state,
        loading: false,
        message: `官方页面加载失败：${messageOf(cause)}`
      }
      this.emitState(managed)
    })
    return { ...managed.state }
  }

  async smokeWorkspace(accountId: string): Promise<{
    hasApi: boolean
    title: string
    accountId: string | null
    toolbarUrl: string
    hasIdentityApi: boolean
  }> {
    await this.open(accountId, false)
    const managed = this.workspaces.get(accountId)
    if (!managed) throw new Error('浏览器工作窗口冒烟创建失败')
    try {
      return await managed.window.webContents.executeJavaScript(`(async () => {
        const hasApi = typeof window.browserWorkspace === 'object'
        const state = hasApi ? await window.browserWorkspace.getState() : { accountId: null }
        return {
          hasApi,
          title: document.title,
          accountId: state.accountId,
          toolbarUrl: location.href,
          hasIdentityApi: typeof window.browserWorkspace.verifyIdentity === 'function' &&
            typeof window.browserWorkspace.confirmIdentity === 'function'
        }
      })()`)
    } finally {
      this.disposeWorkspace(managed, true)
    }
  }

  async runAdapterOperation(
    accountId: string,
    adapter: ManagedBrowserAdapter,
    operation: AdapterOperation
  ): Promise<unknown> {
    const managed = this.workspaces.get(accountId)
    if (!managed || managed.window.isDestroyed() || managed.view.webContents.isDestroyed()) {
      throw new Error('请先打开该账号的内置浏览器并完成登录')
    }
    if (managed.account.platformId !== adapter.metadata.platformId) throw new Error('适配器与账号平台不匹配')
    if (managed.view.webContents.isLoading()) throw new Error('官方页面仍在加载，请稍后再核验')

    let current: URL
    try {
      current = new URL(managed.view.webContents.getURL())
    } catch {
      throw new Error('当前页面地址无效，请重新打开官方创作中心')
    }
    const hostname = current.hostname.toLowerCase().replace(/\.$/, '')
    if (
      current.protocol !== 'https:' || current.username || current.password ||
      (current.port && current.port !== '443') ||
      !adapter.metadata.allowedHosts.includes(hostname)
    ) throw new Error('请在已审核的平台创作中心页面执行身份核验')

    const pinned = adapter.scripts[operation]
    if (pinned.metadata.executionWorld !== 'isolated' || !verifyPinnedScript(pinned)) {
      throw new Error('适配器脚本完整性校验失败')
    }
    let result: unknown
    try {
      result = await managed.view.webContents.executeJavaScriptInIsolatedWorld(
        1201,
        [{ code: pinned.script }],
        false
      )
    } catch {
      throw new Error('平台页面核验脚本执行失败，请刷新官方页面后重试')
    }
    let serialized = ''
    try {
      serialized = JSON.stringify(result)
    } catch {
      throw new Error('平台页面返回了无效的核验结果')
    }
    if (serialized.length > 32_768) throw new Error('平台页面核验结果超过安全上限')
    return result
  }

  getStateForSender(event: IpcMainInvokeEvent): BrowserState {
    return { ...this.workspaceForSender(event).state }
  }

  backForSender(event: IpcMainInvokeEvent): void {
    const managed = this.workspaceForSender(event)
    if (managed.view.webContents.navigationHistory.canGoBack()) {
      managed.view.webContents.navigationHistory.goBack()
    }
  }

  forwardForSender(event: IpcMainInvokeEvent): void {
    const managed = this.workspaceForSender(event)
    if (managed.view.webContents.navigationHistory.canGoForward()) {
      managed.view.webContents.navigationHistory.goForward()
    }
  }

  reloadForSender(event: IpcMainInvokeEvent): void {
    this.workspaceForSender(event).view.webContents.reload()
  }

  async homeForSender(event: IpcMainInvokeEvent): Promise<void> {
    const managed = this.workspaceForSender(event)
    await this.safeLoad(managed, getPlatform(managed.account.platformId).homeUrl)
  }

  closeForSender(event: IpcMainInvokeEvent): void {
    this.workspaceForSender(event).window.close()
  }

  async disconnect(accountId: string): Promise<void> {
    if (this.disconnecting.has(accountId)) throw new Error('账号正在断开')
    this.disconnecting.add(accountId)
    const account = this.findAccount(accountId)
    if (!account) {
      this.disconnecting.delete(accountId)
      throw new Error('账号不存在')
    }

    try {
      const managed = this.workspaces.get(accountId)
      if (managed) this.disposeWorkspace(managed, true)

      await this.clearPartitions([account.sessionPartition])
    } finally {
      this.disconnecting.delete(accountId)
    }
  }

  destroy(): void {
    this.shuttingDown = true
    this.closeAll()
  }

  closeAll(): void {
    for (const managed of [...this.workspaces.values()]) this.disposeWorkspace(managed, true)
    this.workspaces.clear()
    this.senderAccounts.clear()
  }

  async clearPartitions(partitions: readonly string[]): Promise<void> {
    for (const partition of new Set(partitions)) {
      if (!/^persist:social:[0-9a-f-]{36}$/i.test(partition)) continue
      const session = electronSession.fromPartition(partition)
      await session.closeAllConnections()
      await session.clearAuthCache()
      await session.clearCache()
      // Each partition belongs to one account. Clear every Chromium storage type so restored or
      // deleted accounts cannot leave an unreachable authenticated session on disk.
      await session.clearStorageData()
      this.configuredSessions.delete(partition)
    }
  }

  private async createWorkspace(account: Account): Promise<ManagedWorkspace> {
    const platform = getPlatform(account.platformId)
    const window = new BrowserWindow({
      width: 1180,
      height: 820,
      minWidth: 900,
      minHeight: 620,
      title: `${platform.name} · ${sanitizeTitle(account.alias)} — Social Vault`,
      backgroundColor: '#f4f6f8',
      show: false,
      autoHideMenuBar: true,
      webPreferences: {
        preload: this.browserPreload,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        webviewTag: false,
        navigateOnDragDrop: false
      }
    })
    window.removeMenu()

    const view = new WebContentsView({
      webPreferences: {
        partition: account.sessionPartition,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        nodeIntegrationInSubFrames: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        experimentalFeatures: false,
        webviewTag: false,
        navigateOnDragDrop: false,
        devTools: false,
        safeDialogs: true
      }
    })

    this.configureSession(account.sessionPartition, view.webContents.session)
    const managed: ManagedWorkspace = {
      account,
      window,
      view,
      senderId: window.webContents.id,
      disposed: false,
      state: {
        accountId: account.id,
        platformId: account.platformId,
        accountAlias: sanitizeTitle(account.alias),
        platformName: platform.name,
        url: '',
        title: '',
        loading: false,
        canGoBack: false,
        canGoForward: false,
        official: false,
        windowOpen: true,
        message: '正在打开平台官方登录入口…'
      }
    }

    this.workspaces.set(account.id, managed)
    this.senderAccounts.set(managed.senderId, account.id)
    this.installWorkspaceGuards(managed)
    this.installRemoteGuards(managed)

    window.contentView.addChildView(view)
    const layout = (): void => this.layoutRemoteView(managed)
    window.on('resize', layout)
    window.on('maximize', layout)
    window.on('unmaximize', layout)
    window.once('ready-to-show', () => {
      if (this.showWindows && !window.isDestroyed()) window.show()
    })
    window.on('closed', () => {
      if (!this.shuttingDown) this.disposeWorkspace(managed, false)
    })

    try {
      await window.loadURL(this.browserShellUrl)
      this.layoutRemoteView(managed)
      this.emitState(managed)
      return managed
    } catch (error) {
      this.disposeWorkspace(managed, true)
      throw error
    }
  }

  private installWorkspaceGuards(managed: ManagedWorkspace): void {
    const contents = managed.window.webContents
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.on('will-navigate', (details) => {
      if (!isTrustedBrowserUrl(details.url)) details.preventDefault()
    })
    contents.on('will-frame-navigate', (details) => {
      if (!details.isMainFrame || !isTrustedBrowserUrl(details.url)) details.preventDefault()
    })
    contents.on('did-finish-load', () => this.emitState(managed))
  }

  private installRemoteGuards(managed: ManagedWorkspace): void {
    const contents = managed.view.webContents
    const guard = (event: Electron.Event, url: string): void => {
      if (isOfficialUrl(managed.account.platformId, url)) return
      event.preventDefault()
      managed.state = {
        ...managed.state,
        loading: false,
        official: false,
        message: `已阻止非官方地址：${safeHostname(url)}`
      }
      this.emitState(managed)
    }

    contents.on('will-navigate', (details) => guard(details, details.url))
    contents.on('will-frame-navigate', (details) => guard(details, details.url))
    contents.on('will-redirect', (details) => guard(details, details.url))
    contents.setWindowOpenHandler(({ url }) => {
      managed.state = {
        ...managed.state,
        message: isOfficialUrl(managed.account.platformId, url)
          ? '当前安全模式阻止了弹窗式登录；该流程需要单独审核后支持。'
          : `已阻止非官方弹窗：${safeHostname(url)}`
      }
      this.emitState(managed)
      return { action: 'deny' }
    })

    contents.on('did-start-loading', () => {
      managed.state = { ...managed.state, loading: true, message: '正在加载官方页面…' }
      this.emitState(managed)
    })
    contents.on('did-stop-loading', () => this.refreshState(managed))
    contents.on('did-navigate', () => this.refreshState(managed))
    contents.on('did-navigate-in-page', () => this.refreshState(managed))
    contents.on('page-title-updated', (_event, title) => {
      managed.state = { ...managed.state, title: sanitizeTitle(title) }
      this.emitState(managed)
    })
    contents.on('render-process-gone', () => {
      managed.state = {
        ...managed.state,
        loading: false,
        message: '页面进程已停止，请关闭并重新打开此窗口。'
      }
      this.emitState(managed)
    })
  }

  private configureSession(partition: string, session: Session): void {
    if (this.configuredSessions.has(partition)) return
    this.configuredSessions.add(partition)
    session.setPermissionCheckHandler(() => false)
    session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    session.on('will-download', (event) => event.preventDefault())
  }

  private layoutRemoteView(managed: ManagedWorkspace): void {
    if (managed.window.isDestroyed() || managed.view.webContents.isDestroyed()) return
    const { width, height } = managed.window.getContentBounds()
    managed.view.setBounds({
      x: 0,
      y: TOOLBAR_HEIGHT,
      width: Math.max(1, width),
      height: Math.max(1, height - TOOLBAR_HEIGHT)
    })
  }

  private async safeLoad(managed: ManagedWorkspace, url: string): Promise<void> {
    if (!isOfficialUrl(managed.account.platformId, url)) throw new Error('目标不是已审核的官方地址')
    await managed.view.webContents.loadURL(url)
  }

  private refreshState(managed: ManagedWorkspace): void {
    if (managed.view.webContents.isDestroyed()) return
    const contents = managed.view.webContents
    const rawUrl = contents.getURL()
    const official = Boolean(rawUrl) && isOfficialUrl(managed.account.platformId, rawUrl)
    managed.state = {
      ...managed.state,
      url: displayUrl(rawUrl),
      title: sanitizeTitle(contents.getTitle()),
      loading: contents.isLoading(),
      canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward(),
      official,
      windowOpen: true,
      message: official
        ? '平台官方域名 · 登录阶段不运行采集插件'
        : '仅允许访问已审核的官方域名'
    }
    this.emitState(managed)
  }

  private emitState(managed: ManagedWorkspace): void {
    const state = { ...managed.state }
    if (!this.mainWindow.isDestroyed()) this.mainWindow.webContents.send('browser:state', state)
    if (!managed.window.isDestroyed()) managed.window.webContents.send('browser:state', state)
  }

  private workspaceForSender(event: IpcMainInvokeEvent): ManagedWorkspace {
    const accountId = this.senderAccounts.get(event.sender.id)
    const managed = accountId ? this.workspaces.get(accountId) : undefined
    if (!managed || managed.window.isDestroyed()) throw new Error('浏览器工作窗口不存在')
    if (event.sender.id !== managed.window.webContents.id) throw new Error('浏览器窗口来源无效')
    if (event.senderFrame !== managed.window.webContents.mainFrame) throw new Error('拒绝来自子框架的请求')
    if (!isTrustedBrowserUrl(event.senderFrame.url)) throw new Error('浏览器工具栏来源无效')
    return managed
  }

  private disposeWorkspace(managed: ManagedWorkspace, closeWindow: boolean): void {
    if (managed.disposed) return
    managed.disposed = true
    this.workspaces.delete(managed.account.id)
    this.senderAccounts.delete(managed.senderId)
    managed.state = { ...managed.state, loading: false, windowOpen: false, message: '浏览器窗口已关闭' }
    if (!this.mainWindow.isDestroyed()) this.mainWindow.webContents.send('browser:state', { ...managed.state })

    if (!managed.view.webContents.isDestroyed()) managed.view.webContents.close()
    if (closeWindow && !managed.window.isDestroyed()) managed.window.destroy()
  }
}

function safeHostname(value: string): string {
  try {
    return new URL(value).hostname || '未知地址'
  } catch {
    return '无效地址'
  }
}

function displayUrl(value: string): string {
  try {
    const url = new URL(value)
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch {
    return ''
  }
}

function sanitizeTitle(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160)
}

function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}
