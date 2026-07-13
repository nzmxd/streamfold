import {
  BrowserWindow,
  nativeTheme,
  session as electronSession,
  WebContentsView,
  type IpcMainInvokeEvent,
  type Session,
  type WebContents
} from 'electron'
import type { Account, AppearanceState, BrowserState } from '../shared/contracts'
import { getPlatform, isOfficialUrl } from './platforms'
import { isTrustedBrowserUrl } from './shell-security'
import {
  XIAOHONGSHU_API_ENDPOINTS,
  XIAOHONGSHU_API_ROUTES,
  isNoteAnalyzeListUrl,
  isPostedNotesUrl,
  type XiaohongshuApiTransport,
  type XiaohongshuCaptureKind,
  type XiaohongshuJsonResponse
} from './xiaohongshu-api'

const TOOLBAR_HEIGHT = 92
const XIAOHONGSHU_CREATOR_ORIGIN = 'https://creator.xiaohongshu.com'
const DIRECT_JSON_TIMEOUT_MS = 12_000
const SIGNED_CAPTURE_TIMEOUT_MS = 20_000
const SIGNED_CAPTURE_QUIET_MS = 600
const DIRECT_JSON_LIMIT_BYTES = 256 * 1024
const SIGNED_JSON_LIMIT_BYTES = 512 * 1024

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
  private readonly activeApiCaptures = new Set<string>()
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

  createXiaohongshuApiTransport(accountId: string): XiaohongshuApiTransport {
    return Object.freeze({
      directJson: async (endpoint: string): Promise<XiaohongshuJsonResponse> => {
        const managed = this.requireXiaohongshuApiWorkspace(accountId)
        return fetchXiaohongshuPageJson(managed.view.webContents, endpoint)
      },
      captureSignedJson: async (
        route: string,
        kind: XiaohongshuCaptureKind,
        limit: number
      ): Promise<readonly XiaohongshuJsonResponse[]> => {
        const managed = this.requireXiaohongshuApiWorkspace(accountId)
        if (this.activeApiCaptures.has(accountId)) throw new Error('该账号正在同步，请稍候')
        this.activeApiCaptures.add(accountId)
        try {
          return await captureXiaohongshuSignedJson(managed.view.webContents, route, kind, limit)
        } finally {
          this.activeApiCaptures.delete(accountId)
        }
      }
    })
  }

  async smokeWorkspace(accountId: string): Promise<{
    hasApi: boolean
    appearanceReady: boolean
    accountId: string | null
    toolbarUrl: string
  }> {
    await this.open(accountId, false)
    const managed = this.workspaces.get(accountId)
    if (!managed) throw new Error('浏览器工作窗口冒烟创建失败')
    try {
      const result = await managed.window.webContents.executeJavaScript(`(async () => {
        const api = window.browserWorkspace
        const hasApi = typeof api === 'object' && typeof api.getState === 'function'
        const state = hasApi ? await api.getState() : { accountId: null }
        const appearance = hasApi ? await api.appearance.get() : null
        return {
          hasApi,
          appearanceReady: appearance?.resolved === 'light' || appearance?.resolved === 'dark',
          accountId: state.accountId,
          toolbarUrl: location.href
        }
      })()`)
      return result
    } finally {
      this.disposeWorkspace(managed, true)
    }
  }

  getStateForSender(event: IpcMainInvokeEvent): BrowserState {
    return { ...this.workspaceForSender(event).state }
  }

  assertTrustedSender(event: IpcMainInvokeEvent): void {
    this.workspaceForSender(event)
  }

  applyAppearance(state: AppearanceState): void {
    for (const managed of this.workspaces.values()) {
      if (managed.window.isDestroyed()) continue
      if (process.platform !== 'darwin') {
        managed.window.setTitleBarOverlay({
          color: state.resolved === 'dark' ? '#141821' : '#ffffff',
          symbolColor: state.resolved === 'dark' ? '#f5f7fb' : '#171a24'
        })
      }
      managed.window.webContents.send('appearance:changed', state)
    }
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
      title: `${platform.name} · ${sanitizeTitle(account.alias)} — 归页`,
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#0d1016' : '#f6f7fb',
      show: false,
      autoHideMenuBar: true,
      ...(process.platform === 'darwin'
        ? {
            titleBarStyle: 'hiddenInset' as const,
            trafficLightPosition: { x: 16, y: 20 }
          }
        : {
            titleBarStyle: 'hidden' as const,
            titleBarOverlay: {
              color: nativeTheme.shouldUseDarkColors ? '#141821' : '#ffffff',
              symbolColor: nativeTheme.shouldUseDarkColors ? '#f5f7fb' : '#171a24',
              height: 61
            }
          }),
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
          ? '此页面尝试打开新窗口，请在当前页面继续操作。'
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
      message: official ? '平台页面已打开' : '正在打开平台页面'
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

  private requireXiaohongshuApiWorkspace(accountId: string): ManagedWorkspace {
    const account = this.findAccount(accountId)
    const managed = this.workspaces.get(accountId)
    if (!account || !managed || managed.disposed || managed.window.isDestroyed() ||
      managed.view.webContents.isDestroyed()) {
      throw new Error('请先打开该账号的内置浏览器窗口')
    }
    if (account.platformId !== 'xiaohongshu' || managed.account.platformId !== 'xiaohongshu') {
      throw new Error('该 API 传输仅允许小红书账号')
    }
    if (managed.account.id !== account.id ||
      managed.account.sessionPartition !== account.sessionPartition ||
      managed.view.webContents.session !== electronSession.fromPartition(account.sessionPartition)) {
      throw new Error('浏览器工作区与账号独立登录分区不匹配')
    }
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

async function fetchXiaohongshuPageJson(
  contents: Pick<WebContents, 'executeJavaScript' | 'getURL' | 'isDestroyed'>,
  endpoint: string,
  timeoutMs = DIRECT_JSON_TIMEOUT_MS
): Promise<XiaohongshuJsonResponse> {
  assertDirectEndpoint(endpoint)
  if (contents.isDestroyed()) throw new Error('浏览器页面已关闭')
  assertXiaohongshuPageUrl(contents.getURL())

  // Run the fixed API request in the logged-in page origin. Electron's
  // Session.fetch does not reproduce all browser-origin request semantics used
  // by the creator center. This script only streams a whitelisted JSON API; it
  // never reads document content or queries page elements.
  const source = `(async () => {
    const endpoint = ${JSON.stringify(endpoint)};
    const target = new URL(endpoint, 'https://creator.xiaohongshu.com');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ${timeoutMs});
    try {
      const response = await fetch(target.href, {
        method: 'GET',
        credentials: 'include',
        redirect: 'error',
        headers: { Accept: 'application/json' },
        signal: controller.signal
      });
      const contentType = response.headers.get('content-type') || '';
      const declaredLength = Number(response.headers.get('content-length') || '0');
      if (Number.isFinite(declaredLength) && declaredLength > ${DIRECT_JSON_LIMIT_BYTES}) {
        controller.abort();
        return { error: 'TOO_LARGE' };
      }
      if (!response.body) return { error: 'NO_BODY' };
      const reader = response.body.getReader();
      const chunks = [];
      let total = 0;
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        total += part.value.byteLength;
        if (total > ${DIRECT_JSON_LIMIT_BYTES}) {
          controller.abort();
          return { error: 'TOO_LARGE' };
        }
        chunks.push(part.value);
      }
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return {
        status: response.status,
        url: response.url || target.href,
        contentType,
        text: new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      };
    } catch (error) {
      return {
        error: controller.signal.aborted ? 'TIMEOUT' : 'NETWORK',
        detail: String(error && error.message || error).slice(0, 160)
      };
    } finally {
      clearTimeout(timeout);
    }
  })()`
  const raw = objectRecord(await withTimeout(
    contents.executeJavaScript(source),
    timeoutMs + 2_000,
    '小红书只读 API 请求超时'
  ))
  if (raw.error === 'TIMEOUT') throw new Error('小红书只读 API 请求超时')
  if (raw.error === 'TOO_LARGE') throw new Error('小红书 API 响应超过 256 KiB')
  if (raw.error) throw new Error(`小红书 API 请求失败：${String(raw.detail || raw.error).slice(0, 160)}`)
  if (!Number.isInteger(raw.status) || typeof raw.url !== 'string' || typeof raw.text !== 'string') {
    throw new Error('小红书 API 响应结构非法')
  }
  assertExactApiUrl(raw.url, endpoint)
  assertJsonContentType(typeof raw.contentType === 'string' ? raw.contentType : '')
  if (Buffer.byteLength(raw.text, 'utf8') > DIRECT_JSON_LIMIT_BYTES) {
    throw new Error('小红书 API 响应超过 256 KiB')
  }
  return { status: raw.status as number, url: raw.url, json: parseJson(raw.text) }
}

function assertXiaohongshuPageUrl(value: string): void {
  try {
    const url = new URL(value)
    if (url.protocol === 'https:' && url.hostname === 'creator.xiaohongshu.com') return
  } catch {}
  throw new Error('请先在账号浏览器中打开小红书创作中心')
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function captureXiaohongshuSignedJson(
  contents: Pick<WebContents, 'debugger' | 'isDestroyed' | 'loadURL' | 'sendInputEvent'>,
  route: string,
  kind: XiaohongshuCaptureKind,
  limit: number,
  timeoutMs = SIGNED_CAPTURE_TIMEOUT_MS,
  quietMs = SIGNED_CAPTURE_QUIET_MS
): Promise<readonly XiaohongshuJsonResponse[]> {
  assertCaptureRequest(route, kind, limit)
  if (contents.isDestroyed()) throw new Error('浏览器页面已关闭')
  const browserDebugger = contents.debugger
  if (browserDebugger.isAttached()) throw new Error('浏览器调试通道正被其他操作占用')
  let attached = false
  try {
    browserDebugger.attach('1.3')
    attached = true
    await browserDebugger.sendCommand('Network.enable', {
      maxResourceBufferSize: SIGNED_JSON_LIMIT_BYTES,
      maxTotalBufferSize: SIGNED_JSON_LIMIT_BYTES * 4
    })
    return await waitForSignedResponses(contents, route, kind, limit, timeoutMs, quietMs)
  } finally {
    if (attached && browserDebugger.isAttached()) {
      try { await browserDebugger.sendCommand('Network.disable') } catch {}
      try { browserDebugger.detach() } catch {}
    }
  }
}

interface CapturedResponseMetadata {
  requestId: string
  url: string
  status: number
  contentType: string
}

function waitForSignedResponses(
  contents: Pick<WebContents, 'debugger' | 'isDestroyed' | 'loadURL' | 'sendInputEvent'>,
  route: string,
  kind: XiaohongshuCaptureKind,
  limit: number,
  timeoutMs: number,
  quietMs: number
): Promise<readonly XiaohongshuJsonResponse[]> {
  const browserDebugger = contents.debugger
  return new Promise((resolve, reject) => {
    const pending = new Map<string, CapturedResponseMetadata>()
    const harvesting = new Set<string>()
    const results = new Map<string, XiaohongshuJsonResponse>()
    let settled = false
    let quietTimer: ReturnType<typeof setTimeout> | null = null
    let paginationAttempts = 0
    const maximumPaginationAttempts = Math.min(12, Math.max(2, Math.ceil(limit / 10) + 1))
    const timeout = setTimeout(() => fail(new Error('等待小红书签名 JSON 接口超时')), timeoutMs)

    const cleanup = (): void => {
      clearTimeout(timeout)
      if (quietTimer) clearTimeout(quietTimer)
      browserDebugger.removeListener('message', onMessage)
      browserDebugger.removeListener('detach', onDetach)
    }
    const finish = (): void => {
      if (settled || results.size === 0 || pending.size > 0 || harvesting.size > 0) return
      settled = true
      cleanup()
      resolve([...results.values()].sort((left, right) => pageNumber(left.url) - pageNumber(right.url)))
    }
    const fail = (error: unknown): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(error instanceof Error ? error : new Error(String(error)))
    }
    const scheduleAdvanceOrFinish = (): void => {
      if (quietTimer) clearTimeout(quietTimer)
      quietTimer = null
      if (settled || pending.size > 0 || harvesting.size > 0) return
      const shouldAdvance = kind === 'posted_notes' &&
        postedCaptureNeedsMore([...results.values()], limit) &&
        paginationAttempts < maximumPaginationAttempts
      if (shouldAdvance) {
        quietTimer = setTimeout(() => {
          quietTimer = null
          if (settled) return
          paginationAttempts += 1
          try {
            contents.sendInputEvent({ type: 'keyDown', keyCode: 'PageDown' })
            contents.sendInputEvent({ type: 'keyUp', keyCode: 'PageDown' })
          } catch (error) {
            fail(error)
            return
          }
          scheduleAdvanceOrFinish()
        }, quietMs)
        return
      }
      quietTimer = setTimeout(finish, quietMs)
    }
    const harvest = async (requestId: string, encodedDataLength: unknown): Promise<void> => {
      const metadata = pending.get(requestId)
      if (!metadata || harvesting.has(requestId)) return
      harvesting.add(requestId)
      try {
        if (typeof encodedDataLength === 'number' && encodedDataLength > SIGNED_JSON_LIMIT_BYTES) {
          throw new Error('小红书签名 JSON 响应超过 512 KiB')
        }
        assertJsonContentType(metadata.contentType)
        const value = objectRecord(await browserDebugger.sendCommand('Network.getResponseBody', { requestId }))
        if (typeof value.body !== 'string' || value.body.length > SIGNED_JSON_LIMIT_BYTES * 2) {
          throw new Error('小红书签名 JSON 响应正文非法或超过上限')
        }
        const bytes = value.base64Encoded === true
          ? Buffer.from(value.body, 'base64')
          : Buffer.from(value.body, 'utf8')
        if (bytes.byteLength > SIGNED_JSON_LIMIT_BYTES) throw new Error('小红书签名 JSON 响应超过 512 KiB')
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
        results.set(metadata.url, {
          status: metadata.status,
          url: metadata.url,
          json: parseJson(text)
        })
      } finally {
        pending.delete(requestId)
        harvesting.delete(requestId)
      }
      scheduleAdvanceOrFinish()
    }
    const onMessage = (
      _event: Electron.Event,
      method: string,
      params: Record<string, unknown>
    ): void => {
      if (method === 'Network.responseReceived') {
        const requestId = typeof params.requestId === 'string' ? params.requestId : ''
        const response = objectRecord(params.response)
        const url = typeof response.url === 'string' ? response.url : ''
        const resourceType = typeof params.type === 'string' ? params.type : ''
        if (!requestId || (resourceType !== 'Fetch' && resourceType !== 'XHR') ||
          !captureUrlMatches(url, kind)) return
        if (quietTimer) clearTimeout(quietTimer)
        quietTimer = null
        const status = response.status
        if (!Number.isInteger(status) || (status as number) < 100 || (status as number) > 599) {
          fail(new Error('小红书签名接口 HTTP 状态非法'))
          return
        }
        pending.set(requestId, {
          requestId,
          url,
          status: status as number,
          contentType: capturedContentType(response)
        })
        return
      }
      if (method === 'Network.loadingFinished') {
        const requestId = typeof params.requestId === 'string' ? params.requestId : ''
        if (pending.has(requestId)) void harvest(requestId, params.encodedDataLength).catch(fail)
        return
      }
      if (method === 'Network.loadingFailed') {
        const requestId = typeof params.requestId === 'string' ? params.requestId : ''
        if (pending.has(requestId)) {
          pending.delete(requestId)
          fail(new Error('小红书签名接口加载失败'))
        }
      }
    }
    const onDetach = (): void => fail(new Error('小红书 API 捕获通道意外断开'))

    browserDebugger.on('message', onMessage)
    browserDebugger.on('detach', onDetach)
    void contents.loadURL(route).catch(fail)
  })
}

function assertDirectEndpoint(endpoint: string): void {
  if (endpoint !== XIAOHONGSHU_API_ENDPOINTS.personalInfo &&
    endpoint !== XIAOHONGSHU_API_ENDPOINTS.accountStats) {
    throw new Error('拒绝非白名单的小红书只读 API')
  }
}

function assertCaptureRequest(route: string, kind: XiaohongshuCaptureKind, limit: number): void {
  const validPair = route === XIAOHONGSHU_API_ROUTES.noteAnalytics
    ? kind === 'note_analyze_list'
    : route === XIAOHONGSHU_API_ROUTES.noteManager && kind === 'posted_notes'
  if (!validPair) throw new Error('拒绝非固定的小红书数据请求')
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('作品同步数量超出允许范围')
}

function captureUrlMatches(url: string, kind: XiaohongshuCaptureKind): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.origin !== XIAOHONGSHU_CREATOR_ORIGIN || parsed.username || parsed.password || parsed.port) return false
  } catch {
    return false
  }
  return kind === 'posted_notes' ? isPostedNotesUrl(url) : isNoteAnalyzeListUrl(url)
}

function assertExactApiUrl(value: string, endpoint: string): void {
  if (typeof value !== 'string' || value.length > 2_048) throw new Error('小红书 API 响应地址非法')
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('小红书 API 响应地址非法')
  }
  if (url.origin !== XIAOHONGSHU_CREATOR_ORIGIN || url.username || url.password || url.port ||
    url.pathname !== endpoint || url.search || url.hash) {
    throw new Error('小红书 API 响应来源不在白名单')
  }
}

function assertJsonContentType(value: string | null): void {
  const contentType = String(value || '').split(';', 1)[0]?.trim().toLowerCase()
  if (contentType !== 'application/json' && contentType !== 'text/json' && !contentType?.endsWith('+json')) {
    throw new Error('小红书接口未返回 JSON Content-Type')
  }
}

async function readLimitedBody(response: Response, maximumBytes: number): Promise<string> {
  const declared = response.headers.get('content-length')
  if (declared) {
    const length = Number(declared)
    if (!Number.isSafeInteger(length) || length < 0 || length > maximumBytes) {
      throw new Error('小红书只读 API 响应超过大小上限')
    }
  }
  if (!response.body) throw new Error('小红书只读 API 响应正文为空')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      length += next.value.byteLength
      if (length > maximumBytes) {
        await reader.cancel()
        throw new Error('小红书只读 API 响应超过大小上限')
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  const body = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(body)
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    throw new Error('小红书接口返回了无效 JSON')
  }
}

function capturedContentType(response: Record<string, unknown>): string {
  const mimeType = typeof response.mimeType === 'string' ? response.mimeType : ''
  const headers = objectRecord(response.headers)
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === 'content-type' && typeof value === 'string') return value
  }
  return mimeType
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function postedCaptureNeedsMore(
  responses: readonly XiaohongshuJsonResponse[],
  limit: number
): boolean {
  let total = 0
  let lastHasMore = false
  let sawNotes = false
  const ids = new Set<string>()
  const ordered = [...responses].sort((left, right) => pageNumber(left.url) - pageNumber(right.url))
  for (const response of ordered) {
    const envelope = objectRecord(response.json)
    const data = objectRecord(envelope.data)
    const nested = objectRecord(data.data)
    const source = [data, nested].find((record) =>
      ['notes', 'note_list', 'items', 'list'].some((name) => Array.isArray(record[name])))
    if (!source) continue
    const notes = ['notes', 'note_list', 'items', 'list']
      .map((name) => source[name])
      .find(Array.isArray) as unknown[] | undefined
    if (!notes) continue
    sawNotes = true
    notes.forEach((value, index) => {
      const note = objectRecord(value)
      const id = note.note_id ?? note.noteId ?? note.id ?? note.item_id ?? note.display_id
      ids.add(id === undefined || id === null || id === ''
        ? `${response.url}#${index}`
        : String(id))
    })
    const totalValue = data.total ?? data.note_count ?? data.count ??
      nested.total ?? nested.note_count ?? nested.count
    if (Number.isSafeInteger(totalValue) && (totalValue as number) >= 0) {
      total = Math.max(total, totalValue as number)
    }
    lastHasMore = data.has_more === true || data.hasMore === true ||
      nested.has_more === true || nested.hasMore === true
  }
  if (!sawNotes || ids.size >= limit) return false
  return (total > 0 && ids.size < Math.min(total, limit)) || (total === 0 && lastHasMore)
}

function pageNumber(value: string): number {
  try {
    const search = new URL(value).searchParams
    const pageNum = Number(search.get('page_num') || '')
    if (Number.isInteger(pageNum) && pageNum > 0) return pageNum
    const page = Number(search.get('page') || '')
    return Number.isInteger(page) && page >= 0 ? page + 1 : 1
  } catch {
    return 1
  }
}

export const __xiaohongshuApiTransportTest = Object.freeze({
  fetchPageJson: fetchXiaohongshuPageJson,
  captureSignedJson: captureXiaohongshuSignedJson
})

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
