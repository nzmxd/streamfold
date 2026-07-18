import { createHash } from 'node:crypto'
import {
  app,
  BrowserWindow,
  nativeTheme,
  session as electronSession,
  WebContentsView,
  type IpcMainInvokeEvent,
  type NativeImage,
  type Session,
  type WebContents
} from 'electron'
import type { Account, AppearanceState, BrowserState, PlatformDefinition } from '../shared/contracts'
import type {
  PlatformAdapterContribution,
  PlatformCaptureDeclaration,
  PlatformCapturePolicy,
  PlatformEndpointDeclaration
} from '../shared/plugin-host-contracts'
import { normalizePlatformUserAgent } from './browser-compatibility'
import { getPlatform, isOfficialUrl, shouldBlockRemoteNavigation } from './platforms'
import type { CachedProfileAvatar, ProfileMediaStore } from './profile-media'
import {
  hasPluginApiError,
  normalizePluginNetworkError,
  pluginNetworkResponseError
} from './plugins/network-diagnostics'
import {
  BackgroundCaptureSupervisor,
  matchesBackgroundResponseCorrelations,
  type BackgroundCaptureHealth,
  type BackgroundCaptureNotice
} from './plugins/background-capture-supervisor'
import { isTrustedBrowserUrl } from './shell-security'
import {
  XIAOHONGSHU_API_ENDPOINTS,
  XIAOHONGSHU_API_ROUTES,
  XiaohongshuApiError,
  isCreatorNoteUpdateRoute,
  isNoteAnalyzeListUrl,
  isNoteDetailApiUrl,
  isPostedNotesUrl,
  type XiaohongshuApiTransport,
  type XiaohongshuCaptureKind,
  type XiaohongshuJsonResponse
} from './xiaohongshu-api'
import {
  ZhihuApiError,
  normalizeZhihuApiEndpoint,
  type ZhihuApiTransport,
  type ZhihuJsonResponse
} from './zhihu-api'

const TOOLBAR_HEIGHT = 92
const XIAOHONGSHU_CREATOR_ORIGIN = 'https://creator.xiaohongshu.com'
const ZHIHU_ORIGIN = 'https://www.zhihu.com'
const ZHIHU_API_HOME = `${ZHIHU_ORIGIN}/`
const DIRECT_JSON_TIMEOUT_MS = 12_000
const API_NAVIGATION_STABLE_MS = 250
const API_NAVIGATION_TIMEOUT_MS = 8_000
const API_NAVIGATION_POLL_MS = 50
const API_NETWORK_RETRY_DELAY_MS = 250
const SIGNED_CAPTURE_TIMEOUT_MS = 20_000
const SIGNED_CAPTURE_QUIET_MS = 600
const DIRECT_JSON_LIMIT_BYTES = 256 * 1024
const ZHIHU_JSON_LIMIT_BYTES = 512 * 1024
const SIGNED_JSON_LIMIT_BYTES = 512 * 1024

interface ManagedWorkspace {
  account: Account
  window: BrowserWindow
  view: WebContentsView
  senderId: number
  disposed: boolean
  foregroundRequested: boolean
  apiLeaseCount: number
  shellReady: Promise<void>
  apiPageReady: Promise<void> | null
  backgroundCapture: BackgroundCaptureSupervisor | null
  backgroundCaptureNamespace: string | null
  backgroundCapturePluginId: string | null
  backgroundCaptureResumePending: boolean
  state: BrowserState
}

export interface PluginCaptureActivity {
  accountId: string
  captureId: string | null
  pluginId: string | null
  contributionId: string | null
  reason: 'navigation' | 'capture' | 'health'
  health: BackgroundCaptureHealth | null
  error: Error | null
  sequence: number
}

export interface PluginCaptureBootstrapOptions {
  pluginId?: string
  retryInitialDelayMs: number
  retryMaximumDelayMs: number
}

export interface XiaohongshuApiTransportLease {
  readonly transport: XiaohongshuApiTransport
  showForLogin(): void
  release(): void
}

export interface ZhihuApiTransportLease {
  readonly transport: ZhihuApiTransport
  showForLogin(): void
  release(): void
}

export class BrowserManager {
  private readonly workspaces = new Map<string, ManagedWorkspace>()
  private readonly senderAccounts = new Map<number, string>()
  private readonly configuredSessions = new Set<string>()
  private readonly disconnecting = new Set<string>()
  private readonly activeApiCaptures = new Set<string>()
  private readonly pluginCaptureListeners = new Set<(activity: PluginCaptureActivity) => void>()
  private readonly activePluginCaptureBootstraps = new Set<string>()
  private readonly resumablePluginCaptures = new Set<string>()
  private readonly backgroundBootstrapTasks = new Map<string, Promise<void>>()
  private readonly backgroundBootstrapOwners = new Map<string, string>()
  private readonly backgroundBootstrapPolicies = new Map<string, PluginCaptureBootstrapOptions>()
  private readonly backgroundBootstrapGenerations = new Map<string, number>()
  private readonly backgroundBootstrapRetryAttempts = new Map<string, number>()
  private readonly backgroundBootstrapRetryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private pluginCaptureSequence = 0
  private shuttingDown = false

  constructor(
    private readonly mainWindow: BrowserWindow,
    private readonly findAccount: (id: string) => Account | null,
    private readonly browserPreload: string,
    private readonly browserShellUrl: string,
    private readonly showWindows = true,
    private readonly profileMedia: ProfileMediaStore | null = null,
    private readonly windowIcon: NativeImage | null = null
  ) {}

  onPluginCaptureActivity(listener: (activity: PluginCaptureActivity) => void): () => void {
    this.pluginCaptureListeners.add(listener)
    return () => this.pluginCaptureListeners.delete(listener)
  }

  async open(accountId: string, loadRemote = true): Promise<BrowserState> {
    if (this.disconnecting.has(accountId)) throw new Error('账号正在断开，请稍候')
    const account = this.findAccount(accountId)
    if (!account) throw new Error('账号不存在')
    await this.waitForBackgroundBootstrap(accountId)
    if (this.disconnecting.has(accountId)) throw new Error('账号正在断开，请稍候')

    const existing = this.workspaces.get(accountId)
    if (existing && !existing.window.isDestroyed()) {
      this.showWorkspace(existing)
      return { ...existing.state }
    }

    const managed = await this.createWorkspace(account, true)
    if (loadRemote) void this.safeLoad(
      managed,
      interactiveWorkspaceEntryUrl(getPlatform(account.platformId))
    ).catch((cause) => {
      managed.state = {
        ...managed.state,
        loading: false,
        message: `官方页面加载失败：${messageOf(cause)}`
      }
      this.emitState(managed)
    })
    return { ...managed.state }
  }

  async openAt(accountId: string, targetUrl: string): Promise<BrowserState> {
    if (this.disconnecting.has(accountId)) throw new Error('账号正在断开，请稍候')
    const account = this.findAccount(accountId)
    if (!account) throw new Error('账号不存在')
    if (!isOfficialUrl(account.platformId, targetUrl)) throw new Error('原帖链接不是已审核的官方地址')
    await this.waitForBackgroundBootstrap(accountId)
    if (this.disconnecting.has(accountId)) throw new Error('账号正在断开，请稍候')

    let managed = this.workspaces.get(accountId)
    if (managed && !managed.disposed && !managed.window.isDestroyed() &&
      !managed.view.webContents.isDestroyed()) {
      if (managed.apiLeaseCount > 0 || this.activeApiCaptures.has(accountId)) {
        throw new Error('账号正在同步或核验，请稍候查看原帖')
      }
      this.showWorkspace(managed)
    } else {
      if (managed) this.disposeWorkspace(managed, true)
      managed = await this.createWorkspace(account, true)
    }

    try {
      await this.safeLoad(managed, targetUrl)
      this.refreshState(managed)
      return { ...managed.state }
    } catch {
      managed.state = {
        ...managed.state,
        loading: false,
        message: '原帖加载失败，请检查网络后重试'
      }
      this.emitState(managed)
      throw new Error(managed.state.message)
    }
  }

  async acquireXiaohongshuApiTransport(accountId: string): Promise<XiaohongshuApiTransportLease> {
    if (this.disconnecting.has(accountId)) throw new Error('账号正在断开，请稍候')
    const account = this.findAccount(accountId)
    if (!account) throw new Error('账号不存在')
    if (account.platformId !== 'xiaohongshu') throw new Error('该 API 传输仅允许小红书账号')

    await this.waitForBackgroundBootstrap(accountId)
    if (this.disconnecting.has(accountId)) throw new Error('账号正在断开，请稍候')
    let managed = this.workspaces.get(accountId)
    if (!managed || managed.disposed || managed.window.isDestroyed() ||
      managed.view.webContents.isDestroyed()) {
      managed = await this.createWorkspace(account, false)
    } else {
      await managed.shellReady
    }

    beginApiLease(managed)
    let released = false
    try {
      await this.prepareXiaohongshuApiPage(managed)
      this.requireXiaohongshuApiWorkspace(accountId)
    } catch (error) {
      this.releaseApiLease(managed)
      throw error
    }

    const transport = this.createXiaohongshuApiTransport(accountId)
    return Object.freeze({
      transport,
      showForLogin: (): void => {
        if (released || managed.disposed) return
        this.showWorkspace(managed)
      },
      release: (): void => {
        if (released) return
        released = true
        this.releaseApiLease(managed)
      }
    })
  }

  async acquireZhihuApiTransport(accountId: string): Promise<ZhihuApiTransportLease> {
    if (this.disconnecting.has(accountId)) throw new Error('账号正在断开，请稍候')
    const account = this.findAccount(accountId)
    if (!account) throw new Error('账号不存在')
    if (account.platformId !== 'zhihu') throw new Error('该 API 传输仅允许知乎账号')

    await this.waitForBackgroundBootstrap(accountId)
    if (this.disconnecting.has(accountId)) throw new Error('账号正在断开，请稍候')
    let managed = this.workspaces.get(accountId)
    if (!managed || managed.disposed || managed.window.isDestroyed() ||
      managed.view.webContents.isDestroyed()) {
      managed = await this.createWorkspace(account, false)
    } else {
      await managed.shellReady
    }

    beginApiLease(managed)
    let released = false
    try {
      await this.prepareZhihuApiPage(managed)
      this.requireZhihuApiWorkspace(accountId)
    } catch (error) {
      this.releaseApiLease(managed)
      throw error
    }

    const transport = this.createZhihuApiTransport(accountId)
    return Object.freeze({
      transport,
      showForLogin: (): void => {
        if (released || managed.disposed) return
        this.showWorkspace(managed)
      },
      release: (): void => {
        if (released) return
        released = true
        this.releaseApiLease(managed)
      }
    })
  }

  async getPluginPlatformJson(
    accountId: string,
    contribution: PlatformAdapterContribution,
    endpointId: string,
    params: Record<string, unknown>
  ): Promise<unknown> {
    const endpoint = contribution.endpoints.find((item) => item.id === endpointId)
    if (!endpoint) throw new Error('平台插件请求了未声明的端点')
    const managed = await this.acquirePluginWorkspace(accountId, contribution)
    try {
      const target = renderDeclaredUrl(endpoint.origin, endpoint.pathTemplate, endpoint.queryParameters ?? [], params)
      return await fetchDeclaredPlatformJson(
        managed.view.webContents,
        target,
        endpoint.maximumResponseBytes ?? 256 * 1024
      )
    } finally {
      this.releaseApiLease(managed)
    }
  }

  async capturePluginPlatformJson(
    accountId: string,
    pluginId: string,
    pluginVersion: string,
    contribution: PlatformAdapterContribution,
    captureId: string,
    params: Record<string, unknown>,
    limit?: number,
    policy: PlatformCapturePolicy = 'fresh'
  ): Promise<unknown[]> {
    const capture = contribution.captures.find((item) => item.id === captureId)
    if (!capture) throw new Error('平台插件请求了未声明的捕获规则')
    const rendered = renderDeclaredCaptureUrls(capture, params)
    const background = contribution.backgroundCapture
    const backgroundRule = background?.captures.find((item) => item.captureId === capture.id)
    const managed = await this.acquirePluginWorkspace(accountId, contribution, false)
    if (policy === 'background-cache') {
      try {
        if (!background || !backgroundRule) {
          throw new Error('该平台适配器不支持后台响应监听')
        }
        const requestedLimit = limit ?? capture.maximumResponses ?? 20
        if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1) {
          throw new Error('平台后台捕获响应数量无效')
        }
        const namespace = `${pluginId}:${pluginVersion}:${contribution.id}`
        if (managed.backgroundCaptureNamespace && managed.backgroundCaptureNamespace !== namespace) {
          this.stopWorkspaceBackgroundCapture(managed)
        }
        if (!managed.backgroundCapture) {
          managed.backgroundCaptureNamespace = namespace
          managed.backgroundCapturePluginId = pluginId
          managed.backgroundCapture = new BackgroundCaptureSupervisor(
            managed.view.webContents,
            (notice) => this.emitPluginCaptureActivity(managed, {
              pluginId,
              contributionId: contribution.id,
              notice
            }),
            Date.now,
            {
              cacheTtlMs: background.cacheTtlSeconds * 1_000,
              retryInitialDelayMs: background.retryIntervalSeconds * 1_000,
              retryMaximumDelayMs: background.maximumRetryIntervalSeconds * 1_000
            }
          )
          managed.backgroundCaptureResumePending = false
        }
        this.activePluginCaptureBootstraps.add(accountId)
        this.resumablePluginCaptures.add(accountId)
        this.backgroundBootstrapOwners.set(accountId, pluginId)
        this.backgroundBootstrapPolicies.set(accountId, {
          pluginId,
          retryInitialDelayMs: background.retryIntervalSeconds * 1_000,
          retryMaximumDelayMs: background.maximumRetryIntervalSeconds * 1_000
        })
        return managed.backgroundCapture.read(
          namespace,
          capture,
          backgroundRule.responseFieldPaths,
          backgroundRule.responseCorrelations ?? [],
          rendered.routeParameters,
          rendered.responseUrl,
          rendered.routeUrl,
          Math.min(requestedLimit, capture.maximumResponses ?? 100)
        )
      } finally {
        this.releaseApiLease(managed)
      }
    }
    if (managed.backgroundCapture || managed.backgroundCaptureResumePending) {
      managed.backgroundCaptureResumePending = true
    }
    this.stopWorkspaceBackgroundCapture(managed, true)
    if (this.activeApiCaptures.has(accountId)) {
      this.releaseApiLease(managed)
      throw new Error('该账号正在执行响应捕获')
    }
    this.activeApiCaptures.add(accountId)
    try {
      return await captureDeclaredPlatformJson(
        managed.view.webContents,
        capture,
        rendered.responseUrl,
        Math.min(limit ?? capture.maximumResponses ?? 20, capture.maximumResponses ?? 100),
        rendered.routeUrl,
        backgroundRule?.responseCorrelations?.length
          ? (value) => matchesBackgroundResponseCorrelations(
              value,
              backgroundRule.responseCorrelations ?? [],
              rendered.routeParameters
            )
          : undefined
      )
    } finally {
      this.activeApiCaptures.delete(accountId)
      if (managed.backgroundCaptureResumePending) {
        const currentAccount = this.findAccount(accountId)
        if (!currentAccount || currentAccount.remoteId) this.stopWorkspaceBackgroundCapture(managed)
        else this.bootstrapPluginCapture(accountId)
      }
      this.releaseApiLease(managed)
    }
  }

  stopPluginCapture(accountId: string, preserveResume = false): void {
    const managed = this.workspaces.get(accountId)
    const hadResumeIntent = this.activePluginCaptureBootstraps.has(accountId) ||
      this.resumablePluginCaptures.has(accountId) ||
      Boolean(managed?.backgroundCapture || managed?.backgroundCaptureResumePending)
    this.invalidateBackgroundBootstrap(accountId)
    if (preserveResume) {
      if (hadResumeIntent) this.resumablePluginCaptures.add(accountId)
    } else {
      this.resumablePluginCaptures.delete(accountId)
      this.backgroundBootstrapOwners.delete(accountId)
      this.backgroundBootstrapPolicies.delete(accountId)
    }
    if (!managed) {
      this.cleanupBackgroundBootstrapGeneration(accountId)
      return
    }
    if (!managed.foregroundRequested && managed.apiLeaseCount === 0) {
      this.disposeWorkspace(managed, true)
      this.cleanupBackgroundBootstrapGeneration(accountId)
      return
    }
    this.stopWorkspaceBackgroundCapture(managed)
    this.disposeHiddenWorkspaceIfIdle(managed)
    this.cleanupBackgroundBootstrapGeneration(accountId)
  }

  stopAllPluginCaptures(): void {
    const accountIds = new Set([
      ...this.activePluginCaptureBootstraps,
      ...this.resumablePluginCaptures,
      ...this.backgroundBootstrapTasks.keys(),
      ...this.backgroundBootstrapOwners.keys(),
      ...this.backgroundBootstrapPolicies.keys(),
      ...this.backgroundBootstrapRetryTimers.keys(),
      ...this.workspaces.keys()
    ])
    for (const accountId of accountIds) this.stopPluginCapture(accountId)
  }

  stopPluginCapturesForPlugin(pluginId: string, preserveResume = true): void {
    const accountIds = new Set<string>()
    for (const [accountId, ownerPluginId] of this.backgroundBootstrapOwners) {
      if (ownerPluginId === pluginId) accountIds.add(accountId)
    }
    for (const managed of [...this.workspaces.values()]) {
      if (managed.backgroundCapturePluginId === pluginId) accountIds.add(managed.account.id)
    }
    for (const accountId of accountIds) this.stopPluginCapture(accountId, preserveResume)
  }

  bootstrapPluginCapture(
    accountId: string,
    options?: PluginCaptureBootstrapOptions
  ): void {
    if (options) {
      this.backgroundBootstrapPolicies.set(accountId, { ...options })
      if (options.pluginId) this.backgroundBootstrapOwners.set(accountId, options.pluginId)
    }
    const account = this.findAccount(accountId)
    if (!account || account.remoteId) {
      this.stopPluginCapture(accountId)
      return
    }
    this.activePluginCaptureBootstraps.add(accountId)
    this.resumablePluginCaptures.add(accountId)
    const managed = this.workspaces.get(accountId)
    if (!managed || managed.disposed) {
      this.restorePluginCaptureWorkspace(accountId)
      return
    }
    managed.backgroundCaptureResumePending = true
    this.emitPluginCaptureActivity(managed, {
      pluginId: null,
      contributionId: account.adapterContributionId,
      notice: null
    })
  }

  private restorePluginCaptureWorkspace(accountId: string): void {
    if (this.backgroundBootstrapTasks.has(accountId) || this.shuttingDown ||
      !this.activePluginCaptureBootstraps.has(accountId)) return
    const generation = this.backgroundBootstrapGenerations.get(accountId) ?? 0
    const task = (async () => {
      const account = this.findAccount(accountId)
      if (!account || account.remoteId || !this.isBackgroundBootstrapCurrent(accountId, generation)) return
      let managed = this.workspaces.get(accountId)
      if (!managed || managed.disposed || managed.window.isDestroyed() ||
        managed.view.webContents.isDestroyed()) {
        managed = await this.createWorkspace(account, false)
      }
      const current = this.findAccount(accountId)
      if (!current || current.remoteId || !this.isBackgroundBootstrapCurrent(accountId, generation)) {
        const replacementPending = Boolean(current && !current.remoteId &&
          this.activePluginCaptureBootstraps.has(accountId))
        if (!replacementPending && !managed.foregroundRequested && managed.apiLeaseCount === 0) {
          this.disposeWorkspace(managed, true)
        }
        return
      }
      managed.backgroundCaptureResumePending = true
      this.clearBackgroundBootstrapRetry(accountId)
      this.emitPluginCaptureActivity(managed, {
        pluginId: null,
        contributionId: current.adapterContributionId,
        notice: null
      })
    })().catch((error) => {
      if (!this.isBackgroundBootstrapCurrent(accountId, generation)) return
      const retry = this.schedulePluginCaptureWorkspaceRestore(accountId, generation)
      this.emitPluginCaptureWorkspaceFailure(accountId, error, retry)
    }).finally(() => {
      if (this.backgroundBootstrapTasks.get(accountId) === task) {
        this.backgroundBootstrapTasks.delete(accountId)
      }
      if (this.activePluginCaptureBootstraps.has(accountId) &&
        generation !== (this.backgroundBootstrapGenerations.get(accountId) ?? 0)) {
        this.restorePluginCaptureWorkspace(accountId)
      }
      this.cleanupBackgroundBootstrapGeneration(accountId)
    })
    this.backgroundBootstrapTasks.set(accountId, task)
  }

  private schedulePluginCaptureWorkspaceRestore(
    accountId: string,
    generation: number
  ): { retryAttempt: number; nextRetryAt: string } | null {
    if (!this.isBackgroundBootstrapCurrent(accountId, generation) ||
      this.backgroundBootstrapRetryTimers.has(accountId)) return null
    const policy = this.backgroundBootstrapPolicies.get(accountId) ?? {
      retryInitialDelayMs: 1_000,
      retryMaximumDelayMs: 60_000
    }
    const attempt = (this.backgroundBootstrapRetryAttempts.get(accountId) ?? 0) + 1
    this.backgroundBootstrapRetryAttempts.set(accountId, attempt)
    const delay = Math.min(
      policy.retryMaximumDelayMs,
      policy.retryInitialDelayMs * (2 ** Math.min(attempt - 1, 20))
    )
    const timer = setTimeout(() => {
      this.backgroundBootstrapRetryTimers.delete(accountId)
      if (this.isBackgroundBootstrapCurrent(accountId, generation)) {
        this.restorePluginCaptureWorkspace(accountId)
      }
    }, delay)
    timer.unref?.()
    this.backgroundBootstrapRetryTimers.set(accountId, timer)
    return {
      retryAttempt: attempt,
      nextRetryAt: new Date(Date.now() + delay).toISOString()
    }
  }

  private clearBackgroundBootstrapRetry(accountId: string): void {
    const timer = this.backgroundBootstrapRetryTimers.get(accountId)
    if (timer) clearTimeout(timer)
    this.backgroundBootstrapRetryTimers.delete(accountId)
    this.backgroundBootstrapRetryAttempts.delete(accountId)
  }

  private invalidateBackgroundBootstrap(accountId: string): void {
    this.activePluginCaptureBootstraps.delete(accountId)
    this.backgroundBootstrapGenerations.set(
      accountId,
      (this.backgroundBootstrapGenerations.get(accountId) ?? 0) + 1
    )
    this.clearBackgroundBootstrapRetry(accountId)
  }

  private isBackgroundBootstrapCurrent(accountId: string, generation: number): boolean {
    return !this.shuttingDown && this.activePluginCaptureBootstraps.has(accountId) &&
      (this.backgroundBootstrapGenerations.get(accountId) ?? 0) === generation
  }

  private cleanupBackgroundBootstrapGeneration(accountId: string): void {
    if (this.activePluginCaptureBootstraps.has(accountId) ||
      this.resumablePluginCaptures.has(accountId) ||
      this.backgroundBootstrapTasks.has(accountId) ||
      this.backgroundBootstrapRetryTimers.has(accountId) ||
      this.backgroundBootstrapOwners.has(accountId) ||
      this.backgroundBootstrapPolicies.has(accountId)) return
    this.backgroundBootstrapGenerations.delete(accountId)
  }

  private async waitForBackgroundBootstrap(accountId: string): Promise<void> {
    while (true) {
      const task = this.backgroundBootstrapTasks.get(accountId)
      if (!task) return
      await task
    }
  }

  private async acquirePluginWorkspace(
    accountId: string,
    contribution: PlatformAdapterContribution,
    prepareHome = true
  ): Promise<ManagedWorkspace> {
    if (this.disconnecting.has(accountId)) throw new Error('账号正在断开，请稍候')
    const account = this.findAccount(accountId)
    if (!account) throw new Error('账号不存在')
    if (account.platformId !== contribution.platform.id) {
      throw new Error('平台适配器与账号绑定不匹配')
    }
    await this.waitForBackgroundBootstrap(accountId)
    if (this.disconnecting.has(accountId)) throw new Error('账号正在断开，请稍候')
    let managed = this.workspaces.get(accountId)
    if (!managed || managed.disposed || managed.window.isDestroyed() || managed.view.webContents.isDestroyed()) {
      managed = await this.createWorkspace(account, false)
    } else {
      await managed.shellReady
    }
    beginApiLease(managed)
    try {
      this.requirePluginWorkspace(accountId, contribution, managed)
      if (prepareHome) {
        const current = managed.view.webContents.getURL()
        if (!current || new URL(current).origin !== new URL(contribution.platform.homeUrl).origin) {
          await this.safeLoad(managed, contribution.platform.homeUrl)
        }
        await waitForNavigationStable(managed.view.webContents)
      }
      return managed
    } catch (error) {
      this.releaseApiLease(managed)
      throw error
    }
  }

  private requirePluginWorkspace(
    accountId: string,
    contribution: PlatformAdapterContribution,
    managed: ManagedWorkspace
  ): void {
    const account = this.findAccount(accountId)
    if (!account || managed.disposed || managed.account.id !== account.id ||
      account.platformId !== contribution.platform.id ||
      managed.account.sessionPartition !== account.sessionPartition ||
      managed.view.webContents.session !== electronSession.fromPartition(account.sessionPartition)) {
      throw new Error('平台插件工作区与账号独立登录分区不匹配')
    }
  }

  private showWorkspace(managed: ManagedWorkspace): void {
    promoteApiWorkspace(managed)
    managed.state = {
      ...managed.state,
      windowOpen: true,
      message: managed.state.loading
        ? '正在加载官方页面…'
        : managed.state.official
          ? '平台页面已打开'
          : managed.state.message
    }
    this.emitState(managed)
    if (managed.window.isMinimized()) managed.window.restore()
    managed.window.show()
    managed.window.focus()
  }

  private async prepareXiaohongshuApiPage(managed: ManagedWorkspace): Promise<void> {
    if (managed.disposed || managed.window.isDestroyed() || managed.view.webContents.isDestroyed()) {
      throw new Error('账号浏览器工作区已关闭')
    }
    if (managed.apiPageReady) return managed.apiPageReady

    const pending = prepareXiaohongshuApiContents(
      managed.view.webContents,
      (url) => this.safeLoad(managed, url)
    )
    managed.apiPageReady = pending
    try {
      await pending
    } finally {
      if (managed.apiPageReady === pending) managed.apiPageReady = null
    }
  }

  private async prepareZhihuApiPage(managed: ManagedWorkspace): Promise<void> {
    if (managed.disposed || managed.window.isDestroyed() || managed.view.webContents.isDestroyed()) {
      throw new Error('账号浏览器工作区已关闭')
    }
    if (managed.apiPageReady) return managed.apiPageReady

    const pending = prepareZhihuApiContents(
      managed.view.webContents,
      (url) => this.safeLoad(managed, url)
    )
    managed.apiPageReady = pending
    try {
      await pending
    } finally {
      if (managed.apiPageReady === pending) managed.apiPageReady = null
    }
  }

  createXiaohongshuApiTransport(accountId: string): XiaohongshuApiTransport {
    return Object.freeze({
      directJson: async (endpoint: string): Promise<XiaohongshuJsonResponse> => {
        const managed = this.requireXiaohongshuApiWorkspace(accountId)
        await this.prepareXiaohongshuApiPage(managed)
        return fetchXiaohongshuPageJson(
          managed.view.webContents,
          endpoint,
          DIRECT_JSON_TIMEOUT_MS,
          () => this.prepareXiaohongshuApiPage(managed)
        )
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

  createZhihuApiTransport(accountId: string): ZhihuApiTransport {
    return Object.freeze({
      getJson: async (endpoint: string): Promise<ZhihuJsonResponse> => {
        const managed = this.requireZhihuApiWorkspace(accountId)
        return fetchZhihuPageJson(
          managed.view.webContents,
          endpoint,
          DIRECT_JSON_TIMEOUT_MS,
          () => this.prepareZhihuApiPage(managed)
        )
      }
    })
  }

  async cacheXiaohongshuAvatar(
    accountId: string,
    sourceUrl: string
  ): Promise<CachedProfileAvatar | null> {
    if (!this.profileMedia) return null
    const account = this.findAccount(accountId)
    if (!account) throw new Error('账号不存在')
    if (account.platformId !== 'xiaohongshu') throw new Error('头像缓存仅允许小红书账号')
    const managed = this.requireXiaohongshuApiWorkspace(accountId)
    const accountSession = electronSession.fromPartition(account.sessionPartition)
    if (managed.view.webContents.session !== accountSession) {
      throw new Error('头像缓存会话与账号独立登录分区不匹配')
    }
    return this.profileMedia.cacheAvatar(
      account.id,
      sourceUrl,
      (url, init) => accountSession.fetch(url, init)
    )
  }

  async cacheZhihuAvatar(
    accountId: string,
    sourceUrl: string
  ): Promise<CachedProfileAvatar | null> {
    if (!this.profileMedia) return null
    const account = this.findAccount(accountId)
    if (!account) throw new Error('账号不存在')
    if (account.platformId !== 'zhihu') throw new Error('头像缓存仅允许知乎账号')
    const managed = this.requireZhihuApiWorkspace(accountId)
    const accountSession = electronSession.fromPartition(account.sessionPartition)
    if (managed.view.webContents.session !== accountSession) {
      throw new Error('头像缓存会话与账号独立登录分区不匹配')
    }
    return this.profileMedia.cacheAvatar(
      account.id,
      sourceUrl,
      (url, init) => accountSession.fetch(url, init)
    )
  }

  async cachePluginAvatar(
    accountId: string,
    contribution: PlatformAdapterContribution,
    sourceUrl: string
  ): Promise<CachedProfileAvatar | null> {
    if (!this.profileMedia) return null
    const account = this.findAccount(accountId)
    if (!account) throw new Error('账号不存在')
    if (account.platformId !== contribution.platform.id ||
      account.adapterContributionId !== contribution.id) {
      throw new Error('头像缓存仅允许账号已绑定的平台适配器')
    }
    const managed = await this.acquirePluginWorkspace(accountId, contribution, false)
    try {
      const accountSession = electronSession.fromPartition(account.sessionPartition)
      if (managed.view.webContents.session !== accountSession) {
        throw new Error('头像缓存会话与账号独立登录分区不匹配')
      }
      return await this.profileMedia.cacheAvatar(
        account.id,
        sourceUrl,
        (url, init) => accountSession.fetch(url, init),
        contribution.platform.imageHosts
      )
    } finally {
      this.releaseApiLease(managed)
    }
  }

  async purgeAccountMedia(accountId: string): Promise<void> {
    await this.profileMedia?.purgeAccount(accountId)
  }

  async pruneAccountAvatarMedia(accountId: string, keepCacheKey: string): Promise<void> {
    await this.profileMedia?.pruneAccountAvatars(accountId, keepCacheKey)
  }

  async pruneAccountMedia(accountIds: ReadonlySet<string>): Promise<void> {
    await this.profileMedia?.pruneAccounts(accountIds)
  }

  async smokeWorkspace(accountId: string): Promise<{
    hasApi: boolean
    appearanceReady: boolean
    accountId: string | null
    toolbarUrl: string
    remoteUserAgent: string
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
      return {
        ...result,
        remoteUserAgent: managed.view.webContents.getUserAgent()
      }
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
    try {
      this.stopPluginCapture(accountId)
      await this.waitForBackgroundBootstrap(accountId)
      const active = this.workspaces.get(accountId)
      if ((active?.apiLeaseCount ?? 0) > 0 || this.activeApiCaptures.has(accountId)) {
        throw new Error('账号正在同步或核验，请稍候')
      }
      const account = this.findAccount(accountId)
      if (!account) throw new Error('账号不存在')
      const managed = this.workspaces.get(accountId)
      if (managed) this.disposeWorkspace(managed, true)

      await this.clearPartitions([account.sessionPartition])
    } finally {
      this.disconnecting.delete(accountId)
    }
  }

  destroy(): void {
    this.shuttingDown = true
    void this.closeAll()
  }

  async closeAll(): Promise<void> {
    this.stopAllPluginCaptures()
    for (const managed of [...this.workspaces.values()]) this.disposeWorkspace(managed, true)
    this.workspaces.clear()
    this.senderAccounts.clear()
    const tasks = [...this.backgroundBootstrapTasks.values()]
    if (tasks.length > 0) await Promise.allSettled(tasks)
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

  private async createWorkspace(account: Account, foregroundRequested: boolean): Promise<ManagedWorkspace> {
    const platform = getPlatform(account.platformId)
    const accountLabel = displayAccountName(account, platform.name)
    const window = new BrowserWindow({
      width: 1180,
      height: 820,
      minWidth: 900,
      minHeight: 620,
      title: `${platform.name} · ${accountLabel} — 归页`,
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#0d1016' : '#f6f7fb',
      show: false,
      autoHideMenuBar: true,
      ...(this.windowIcon ? { icon: this.windowIcon } : {}),
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

    // Keep the actual OS and bundled Chromium version. Some official login pages reject
    // Electron wrapper product tokens as an obsolete embedded client.
    view.webContents.setUserAgent(normalizePlatformUserAgent(
      account.platformId,
      view.webContents.getUserAgent(),
      app.getName()
    ))
    this.configureSession(account.sessionPartition, view.webContents.session)
    try {
      await initializeRemoteWorkspace(view.webContents)
    } catch (error) {
      try { view.webContents.close() } catch {}
      window.destroy()
      throw error
    }
    const managed: ManagedWorkspace = {
      account,
      window,
      view,
      senderId: window.webContents.id,
      disposed: false,
      foregroundRequested,
      apiLeaseCount: 0,
      shellReady: Promise.resolve(),
      apiPageReady: null,
      backgroundCapture: null,
      backgroundCaptureNamespace: null,
      backgroundCapturePluginId: null,
      backgroundCaptureResumePending: false,
      state: {
        accountId: account.id,
        platformId: account.platformId,
        accountAlias: accountLabel,
        platformName: platform.name,
        url: '',
        title: '',
        loading: false,
        canGoBack: false,
        canGoForward: false,
        official: false,
        windowOpen: foregroundRequested,
        message: '正在打开平台官方账号页面…'
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
      if (this.showWindows && managed.foregroundRequested && !window.isDestroyed()) window.show()
    })
    window.on('close', (event) => {
      if (this.shuttingDown || managed.disposed ||
        (!managed.backgroundCapture && !managed.backgroundCaptureResumePending)) return
      event.preventDefault()
      managed.foregroundRequested = false
      managed.state = {
        ...managed.state,
        windowOpen: false,
        message: managed.backgroundCapture
          ? '窗口已隐藏，后台监听仍在运行'
          : '窗口已隐藏，后台监听将在身份核验后继续'
      }
      window.hide()
      this.emitState(managed)
    })
    window.on('closed', () => {
      if (!this.shuttingDown) this.disposeWorkspace(managed, false)
    })

    try {
      managed.shellReady = window.loadURL(this.browserShellUrl).then(() => undefined)
      await managed.shellReady
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
    const guard = (event: Electron.Event, url: string, isMainFrame = true): void => {
      if (!shouldBlockRemoteNavigation(managed.account.platformId, url, isMainFrame)) return
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
    contents.on('will-frame-navigate', (details) => guard(details, details.url, details.isMainFrame))
    contents.on('will-redirect', (details) => guard(details, details.url, details.isMainFrame))
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
    contents.on('did-stop-loading', () => {
      this.refreshState(managed)
      const account = this.findAccount(managed.account.id)
      if (account && !account.remoteId && isOfficialUrl(account.platformId, contents.getURL())) {
        this.emitPluginCaptureActivity(managed, {
          pluginId: null,
          contributionId: account.adapterContributionId,
          notice: null
        })
      }
    })
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
    const listeningInBackground = !managed.foregroundRequested &&
      (Boolean(managed.backgroundCapture) || managed.backgroundCaptureResumePending)
    managed.state = {
      ...managed.state,
      url: displayUrl(rawUrl),
      title: sanitizeTitle(contents.getTitle()),
      loading: contents.isLoading(),
      canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward(),
      official,
      windowOpen: managed.foregroundRequested,
      message: listeningInBackground
        ? managed.backgroundCapture
          ? '窗口已隐藏，后台监听仍在运行'
          : '窗口已隐藏，后台监听将在身份核验后继续'
        : official
          ? '平台页面已打开'
          : '正在打开平台页面'
    }
    this.emitState(managed)
  }

  private emitState(managed: ManagedWorkspace): void {
    const state = { ...managed.state }
    if (!this.mainWindow.isDestroyed()) this.mainWindow.webContents.send('browser:state', state)
    if (!managed.window.isDestroyed()) managed.window.webContents.send('browser:state', state)
  }

  private emitPluginCaptureActivity(
    managed: ManagedWorkspace,
    input: {
      pluginId: string | null
      contributionId: string | null
      notice: BackgroundCaptureNotice | null
    }
  ): void {
    if (managed.disposed || !this.findAccount(managed.account.id)) return
    const activity: PluginCaptureActivity = {
      accountId: managed.account.id,
      captureId: input.notice?.captureId ?? null,
      pluginId: input.pluginId,
      contributionId: input.contributionId,
      reason: input.notice?.reason ?? 'navigation',
      health: input.notice?.health ?? null,
      error: input.notice?.error ?? null,
      sequence: ++this.pluginCaptureSequence
    }
    for (const listener of this.pluginCaptureListeners) {
      try { listener(activity) } catch {}
    }
  }

  private emitPluginCaptureWorkspaceFailure(
    accountId: string,
    error: unknown,
    retry: { retryAttempt: number; nextRetryAt: string } | null
  ): void {
    const account = this.findAccount(accountId)
    if (!account || this.shuttingDown) return
    const failure = normalizePluginNetworkError(error, '平台后台监听工作区恢复失败')
    const activity: PluginCaptureActivity = {
      accountId,
      captureId: null,
      pluginId: this.backgroundBootstrapOwners.get(accountId) ?? null,
      contributionId: account.adapterContributionId,
      reason: 'health',
      health: {
        status: retry ? 'retrying' : 'degraded',
        retryAttempt: retry?.retryAttempt ?? 0,
        nextRetryAt: retry?.nextRetryAt ?? null,
        lastCaptureAt: null,
        lastError: failure.message
      },
      error: failure,
      sequence: ++this.pluginCaptureSequence
    }
    for (const listener of this.pluginCaptureListeners) {
      try { listener(activity) } catch {}
    }
  }

  private stopWorkspaceBackgroundCapture(managed: ManagedWorkspace, preserveResume = false): void {
    managed.backgroundCapture?.dispose()
    managed.backgroundCapture = null
    managed.backgroundCaptureNamespace = null
    if (!preserveResume) {
      managed.backgroundCapturePluginId = null
      managed.backgroundCaptureResumePending = false
    }
  }

  private disposeHiddenWorkspaceIfIdle(managed: ManagedWorkspace): void {
    if (!managed.disposed && !managed.foregroundRequested && managed.apiLeaseCount === 0 &&
      !managed.backgroundCapture && !managed.backgroundCaptureResumePending) {
      this.disposeWorkspace(managed, true)
    }
  }

  private releaseApiLease(managed: ManagedWorkspace): void {
    endApiLease(managed)
    this.disposeHiddenWorkspaceIfIdle(managed)
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

  private requireZhihuApiWorkspace(accountId: string): ManagedWorkspace {
    const account = this.findAccount(accountId)
    const managed = this.workspaces.get(accountId)
    if (!account || !managed || managed.disposed || managed.window.isDestroyed() ||
      managed.view.webContents.isDestroyed()) {
      throw new Error('请先打开该账号的内置浏览器窗口')
    }
    if (account.platformId !== 'zhihu' || managed.account.platformId !== 'zhihu') {
      throw new Error('该 API 传输仅允许知乎账号')
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
    const hadBackgroundCapture = Boolean(managed.backgroundCapture)
    this.stopWorkspaceBackgroundCapture(managed)
    if (!hadBackgroundCapture) {
      this.emitPluginCaptureActivity(managed, {
        pluginId: null,
        contributionId: managed.account.adapterContributionId,
        notice: {
          captureId: null,
          reason: 'health',
          generation: `workspace:${managed.senderId}`,
          revision: 0,
          health: {
            status: 'stopped',
            retryAttempt: 0,
            nextRetryAt: null,
            lastCaptureAt: null,
            lastError: ''
          },
          error: null
        }
      })
    }
    managed.disposed = true
    if (this.workspaces.get(managed.account.id) === managed) {
      this.workspaces.delete(managed.account.id)
    }
    if (this.senderAccounts.get(managed.senderId) === managed.account.id) {
      this.senderAccounts.delete(managed.senderId)
    }
    managed.state = { ...managed.state, loading: false, windowOpen: false, message: '浏览器窗口已关闭' }
    if (!this.mainWindow.isDestroyed()) this.mainWindow.webContents.send('browser:state', { ...managed.state })

    if (!managed.view.webContents.isDestroyed()) managed.view.webContents.close()
    if (closeWindow && !managed.window.isDestroyed()) managed.window.destroy()
  }
}

interface ApiLeaseLifecycle {
  foregroundRequested: boolean
  apiLeaseCount: number
}

function beginApiLease(workspace: ApiLeaseLifecycle): void {
  workspace.apiLeaseCount += 1
}

function endApiLease(workspace: ApiLeaseLifecycle): boolean {
  if (workspace.apiLeaseCount > 0) workspace.apiLeaseCount -= 1
  return workspace.apiLeaseCount === 0 && !workspace.foregroundRequested
}

function promoteApiWorkspace(workspace: ApiLeaseLifecycle): void {
  workspace.foregroundRequested = true
}

function isXiaohongshuCreatorPage(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname === 'creator.xiaohongshu.com' &&
      !url.username && !url.password && !url.port
  } catch {
    return false
  }
}

interface NavigationStabilityOptions {
  quietMs?: number
  timeoutMs?: number
  pollMs?: number
}

async function prepareXiaohongshuApiContents(
  contents: Pick<WebContents, 'getURL' | 'isLoading' | 'isDestroyed'>,
  loadOfficial: (url: string) => Promise<void>,
  options: NavigationStabilityOptions = {}
): Promise<void> {
  if (isXiaohongshuCreatorPage(contents.getURL()) && !isCreatorNoteUpdateRoute(contents.getURL())) {
    await waitForNavigationStable(contents, options)
    if (isStableXiaohongshuCreatorPage(contents)) return
  }

  await loadOfficial(XIAOHONGSHU_API_ROUTES.home)
  await waitForNavigationStable(contents, options)
  if (!isXiaohongshuCreatorPage(contents.getURL())) {
    throw new Error('小红书创作中心未能完成加载')
  }
}

function isStableXiaohongshuCreatorPage(
  contents: Pick<WebContents, 'getURL' | 'isLoading' | 'isDestroyed'>
): boolean {
  return !contents.isDestroyed() && !contents.isLoading() &&
    isXiaohongshuCreatorPage(contents.getURL())
}

function isZhihuApiPage(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname === 'www.zhihu.com' &&
      !url.username && !url.password && !url.port
  } catch {
    return false
  }
}

async function prepareZhihuApiContents(
  contents: Pick<WebContents, 'getURL' | 'isLoading' | 'isDestroyed'>,
  loadOfficial: (url: string) => Promise<void>,
  options: NavigationStabilityOptions = {}
): Promise<void> {
  if (isZhihuApiPage(contents.getURL())) {
    await waitForNavigationStable(contents, options)
    if (!contents.isDestroyed() && !contents.isLoading() && isZhihuApiPage(contents.getURL())) return
  }

  await loadOfficial(ZHIHU_API_HOME)
  await waitForNavigationStable(contents, options, '等待知乎页面导航稳定超时')
  if (!isZhihuApiPage(contents.getURL())) throw new Error('知乎官方页面未能完成加载')
}

async function waitForNavigationStable(
  contents: Pick<WebContents, 'getURL' | 'isLoading' | 'isDestroyed'>,
  options: NavigationStabilityOptions = {},
  timeoutMessage = '等待小红书创作中心导航稳定超时'
): Promise<void> {
  const quietMs = options.quietMs ?? API_NAVIGATION_STABLE_MS
  const timeoutMs = options.timeoutMs ?? API_NAVIGATION_TIMEOUT_MS
  const pollMs = options.pollMs ?? API_NAVIGATION_POLL_MS
  const startedAt = Date.now()
  let stableSince = 0
  let lastUrl = ''

  while (true) {
    if (contents.isDestroyed()) throw new Error('浏览器页面已关闭')
    const now = Date.now()
    const url = contents.getURL()
    const loading = contents.isLoading()
    if (loading) {
      stableSince = 0
      lastUrl = url
    } else if (url !== lastUrl || stableSince === 0) {
      lastUrl = url
      stableSince = now
    } else if (now - stableSince >= quietMs) {
      return
    }
    if (now - startedAt >= timeoutMs) throw new Error(timeoutMessage)
    await delay(Math.min(pollMs, Math.max(1, timeoutMs - (now - startedAt))))
  }
}

async function fetchZhihuPageJson(
  contents: Pick<WebContents, 'executeJavaScript' | 'getURL' | 'isDestroyed'>,
  endpointValue: string,
  timeoutMs = DIRECT_JSON_TIMEOUT_MS,
  beforeNetworkRetry: (() => Promise<void>) | null = null
): Promise<ZhihuJsonResponse> {
  const endpoint = normalizeZhihuApiEndpoint(endpointValue)
  if (contents.isDestroyed()) throw new Error('浏览器页面已关闭')
  if (!isZhihuApiPage(contents.getURL())) throw new Error('请先在账号浏览器中打开知乎官方页面')

  const source = `(async () => {
    const endpoint = ${JSON.stringify(endpoint)};
    const target = new URL(endpoint, 'https://www.zhihu.com');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ${timeoutMs});
    try {
      const response = await fetch(target.href, {
        method: 'GET',
        credentials: 'include',
        redirect: 'manual',
        headers: { Accept: 'application/json' },
        signal: controller.signal
      });
      if (response.type === 'opaqueredirect' ||
          (response.status >= 300 && response.status < 400)) {
        return { error: 'AUTH_REDIRECT' };
      }
      if (response.status === 0) return { error: 'NETWORK' };
      const contentType = response.headers.get('content-type') || '';
      const normalizedContentType = contentType.split(';', 1)[0].trim().toLowerCase();
      const isJson = normalizedContentType === 'application/json' ||
        normalizedContentType === 'text/json' || normalizedContentType.endsWith('+json');
      if (!isJson) {
        return {
          status: response.status,
          url: response.url || target.href,
          redirected: response.redirected === true,
          contentType,
          text: ''
        };
      }
      const declaredLength = Number(response.headers.get('content-length') || '0');
      if (Number.isFinite(declaredLength) && declaredLength > ${ZHIHU_JSON_LIMIT_BYTES}) {
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
        if (total > ${ZHIHU_JSON_LIMIT_BYTES}) {
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
        redirected: response.redirected === true,
        contentType,
        text: new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      };
    } catch {
      return { error: controller.signal.aborted ? 'TIMEOUT' : 'NETWORK' };
    } finally {
      clearTimeout(timeout);
    }
  })()`

  let raw: Record<string, unknown> = {}
  for (let attempt = 0; attempt < 2; attempt += 1) {
    raw = objectRecord(await withTimeout(
      contents.executeJavaScript(source),
      timeoutMs + 2_000,
      '知乎只读 API 请求超时'
    ))
    if (raw.error !== 'NETWORK' || attempt === 1) break
    if (beforeNetworkRetry) await beforeNetworkRetry()
    else await delay(API_NETWORK_RETRY_DELAY_MS)
  }

  if (raw.error === 'TIMEOUT') throw new Error('知乎只读 API 请求超时')
  if (raw.error === 'TOO_LARGE') {
    throw new ZhihuApiError('RESPONSE_TOO_LARGE', '知乎 API 响应超过 512 KiB')
  }
  if (raw.error === 'AUTH_REDIRECT') {
    throw new ZhihuApiError('AUTH_REQUIRED', '知乎登录状态已失效，请重新登录')
  }
  if (raw.error === 'NETWORK') throw new Error('知乎 API 暂时无法连接，请稍后重试')
  if (raw.error) throw new Error('知乎 API 请求失败')
  if (!Number.isInteger(raw.status) || typeof raw.url !== 'string' || typeof raw.text !== 'string') {
    throw new ZhihuApiError('MALFORMED_RESPONSE', '知乎 API 响应结构非法')
  }

  const expectedUrl = new URL(endpoint, ZHIHU_ORIGIN).href
  if (raw.redirected === true || isZhihuSigninUrl(raw.url)) {
    throw new ZhihuApiError('AUTH_REQUIRED', '知乎登录状态已失效，请重新登录')
  }
  if (raw.url !== expectedUrl) {
    throw new ZhihuApiError('MALFORMED_RESPONSE', '知乎 API 响应地址与请求不一致')
  }
  if (raw.status === 401 || raw.status === 403) {
    throw new ZhihuApiError('AUTH_REQUIRED', '知乎登录状态已失效，请重新登录')
  }
  if (raw.status === 429) {
    throw new ZhihuApiError('RATE_LIMITED', '知乎同步暂时受限，请稍后重试')
  }
  try {
    assertJsonContentType(typeof raw.contentType === 'string' ? raw.contentType : '')
  } catch {
    if (raw.status === 200) {
      throw new ZhihuApiError('AUTH_REQUIRED', '知乎登录状态已失效，请重新登录')
    }
    throw new ZhihuApiError('MALFORMED_RESPONSE', '知乎 API 未返回 JSON 数据')
  }
  if (Buffer.byteLength(raw.text, 'utf8') > ZHIHU_JSON_LIMIT_BYTES) {
    throw new ZhihuApiError('RESPONSE_TOO_LARGE', '知乎 API 响应超过 512 KiB')
  }
  return { status: raw.status as number, url: raw.url, json: parseJson(raw.text) }
}

function isZhihuSigninUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.origin === ZHIHU_ORIGIN &&
      (url.pathname === '/signin' || url.pathname.startsWith('/signin/'))
  } catch {
    return false
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function fetchXiaohongshuPageJson(
  contents: Pick<WebContents, 'executeJavaScript' | 'getURL' | 'isDestroyed'>,
  endpoint: string,
  timeoutMs = DIRECT_JSON_TIMEOUT_MS,
  beforeNetworkRetry: (() => Promise<void>) | null = null
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
        redirect: 'manual',
        headers: { Accept: 'application/json' },
        signal: controller.signal
      });
      if (response.type === 'opaqueredirect' ||
          (response.status >= 300 && response.status < 400)) {
        return { error: 'AUTH_REDIRECT' };
      }
      if (response.status === 0) return { error: 'NETWORK' };
      const contentType = response.headers.get('content-type') || '';
      const normalizedContentType = contentType.split(';', 1)[0].trim().toLowerCase();
      const isJson = normalizedContentType === 'application/json' ||
        normalizedContentType === 'text/json' || normalizedContentType.endsWith('+json');
      if (!isJson) {
        return {
          status: response.status,
          url: response.url || target.href,
          redirected: response.redirected === true,
          contentType,
          text: ''
        };
      }
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
        redirected: response.redirected === true,
        contentType,
        text: new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      };
    } catch {
      return { error: controller.signal.aborted ? 'TIMEOUT' : 'NETWORK' };
    } finally {
      clearTimeout(timeout);
    }
  })()`
  let raw: Record<string, unknown> = {}
  for (let attempt = 0; attempt < 2; attempt += 1) {
    raw = objectRecord(await withTimeout(
      contents.executeJavaScript(source),
      timeoutMs + 2_000,
      '小红书只读 API 请求超时'
    ))
    if (raw.error !== 'NETWORK' || attempt === 1) break
    if (beforeNetworkRetry) await beforeNetworkRetry()
    else await delay(API_NETWORK_RETRY_DELAY_MS)
  }
  if (raw.error === 'TIMEOUT') throw new Error('小红书只读 API 请求超时')
  if (raw.error === 'TOO_LARGE') throw new Error('小红书 API 响应超过 256 KiB')
  if (raw.error === 'AUTH_REDIRECT') {
    throw new XiaohongshuApiError('AUTH_REQUIRED', '小红书登录状态已失效，请重新登录')
  }
  if (raw.error === 'NETWORK') throw new Error('小红书 API 暂时无法连接，请稍后重试')
  if (raw.error) throw new Error('小红书 API 请求失败')
  if (!Number.isInteger(raw.status) || typeof raw.url !== 'string' || typeof raw.text !== 'string') {
    throw new Error('小红书 API 响应结构非法')
  }
  assertExactApiUrl(raw.url, endpoint)
  if (raw.redirected === true) throw new Error('小红书 API 响应发生了未允许的重定向')
  if (raw.status === 401 || raw.status === 403) {
    throw new XiaohongshuApiError('AUTH_REQUIRED', '小红书登录状态已失效，请重新登录')
  }
  assertJsonContentType(typeof raw.contentType === 'string' ? raw.contentType : '')
  if (Buffer.byteLength(raw.text, 'utf8') > DIRECT_JSON_LIMIT_BYTES) {
    throw new Error('小红书 API 响应超过 256 KiB')
  }
  return { status: raw.status as number, url: raw.url, json: parseJson(raw.text) }
}

function assertXiaohongshuPageUrl(value: string): void {
  if (isXiaohongshuCreatorPage(value)) return
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
  contents: Pick<WebContents, 'debugger' | 'executeJavaScript' | 'isDestroyed' | 'loadURL' | 'sendInputEvent'>,
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
  let captured: readonly XiaohongshuJsonResponse[]
  try {
    browserDebugger.attach('1.3')
    attached = true
    await browserDebugger.sendCommand('Network.enable', {
      maxResourceBufferSize: SIGNED_JSON_LIMIT_BYTES,
      maxTotalBufferSize: SIGNED_JSON_LIMIT_BYTES * 4
    })
    captured = await waitForSignedResponses(contents, route, kind, limit, timeoutMs, quietMs)
  } finally {
    if (attached && browserDebugger.isAttached()) {
      try { await browserDebugger.sendCommand('Network.disable') } catch {}
      try { browserDebugger.detach() } catch {}
    }
  }
  return kind === 'note_analyze_list'
    ? fetchRemainingXiaohongshuAnalyzePages(contents, captured, limit, timeoutMs)
    : captured
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
    const requestMethods = new Map<string, string>()
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
      const needsMore = kind === 'posted_notes' &&
        postedCaptureNeedsMore([...results.values()], limit)
      const shouldAdvance = needsMore && paginationAttempts < maximumPaginationAttempts
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
        const resultKey = kind === 'note_detail' ? requestId : metadata.url
        if (kind === 'note_detail' && !results.has(resultKey) && results.size >= 10) {
          throw new Error('小红书作品详情接口返回了过多响应')
        }
        const json = parseJson(text)
        results.set(resultKey, {
          status: metadata.status,
          url: metadata.url,
          json
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
      if (method === 'Network.requestWillBeSent') {
        const requestId = typeof params.requestId === 'string' ? params.requestId : ''
        const request = objectRecord(params.request)
        const url = typeof request.url === 'string' ? request.url : ''
        const requestMethod = typeof request.method === 'string' ? request.method.toUpperCase() : ''
        if (requestId && captureUrlMatches(url, kind)) requestMethods.set(requestId, requestMethod)
        return
      }
      if (method === 'Network.responseReceived') {
        const requestId = typeof params.requestId === 'string' ? params.requestId : ''
        const response = objectRecord(params.response)
        const url = typeof response.url === 'string' ? response.url : ''
        const resourceType = typeof params.type === 'string' ? params.type : ''
        if (!requestId || (resourceType !== 'Fetch' && resourceType !== 'XHR') ||
          !captureUrlMatches(url, kind) ||
          (kind === 'note_detail' && requestMethods.get(requestId) !== 'GET')) return
        if (quietTimer) clearTimeout(quietTimer)
        quietTimer = null
        const status = response.status
        if (!Number.isInteger(status) || (status as number) < 100 || (status as number) > 599) {
          fail(new Error('小红书签名接口 HTTP 状态非法'))
          return
        }
        if (kind === 'note_detail' && (status === 401 || status === 403)) {
          fail(new XiaohongshuApiError('AUTH_REQUIRED', '小红书登录状态已失效，请重新登录'))
          return
        }
        if (kind === 'note_detail' && (status === 429 || status === 461 || status === 471)) {
          fail(new XiaohongshuApiError('RISK_CONTROL', '小红书暂时限制了作品详情请求'))
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
        requestMethods.delete(requestId)
        return
      }
      if (method === 'Network.loadingFailed') {
        const requestId = typeof params.requestId === 'string' ? params.requestId : ''
        if (pending.has(requestId)) {
          pending.delete(requestId)
          fail(new Error('小红书签名接口加载失败'))
        }
        requestMethods.delete(requestId)
      }
    }
    const onDetach = (): void => fail(new Error('小红书 API 捕获通道意外断开'))

    browserDebugger.on('message', onMessage)
    browserDebugger.on('detach', onDetach)
    void contents.loadURL(route).catch(() => fail(new Error('打开小红书官方数据页面失败')))
  })
}

function assertDirectEndpoint(endpoint: string): void {
  if (endpoint !== XIAOHONGSHU_API_ENDPOINTS.personalInfo &&
    endpoint !== XIAOHONGSHU_API_ENDPOINTS.userInfo &&
    endpoint !== XIAOHONGSHU_API_ENDPOINTS.accountStats) {
    throw new Error('拒绝非白名单的小红书只读 API')
  }
}

function assertCaptureRequest(route: string, kind: XiaohongshuCaptureKind, limit: number): void {
  const validPair = kind === 'note_analyze_list'
    ? route === XIAOHONGSHU_API_ROUTES.noteAnalytics
    : kind === 'posted_notes'
      ? route === XIAOHONGSHU_API_ROUTES.noteManager
      : kind === 'note_detail' && isCreatorNoteUpdateRoute(route)
  if (!validPair) throw new Error('拒绝非固定的小红书数据请求')
  const validLimit = kind === 'note_detail'
    ? limit === 1
    : Number.isInteger(limit) && limit >= 1 && limit <= 100
  if (!validLimit) throw new Error('作品同步数量超出允许范围')
}

function captureUrlMatches(url: string, kind: XiaohongshuCaptureKind): boolean {
  if (kind === 'posted_notes') return isPostedNotesUrl(url)
  if (kind === 'note_analyze_list') return isNoteAnalyzeListUrl(url)
  return isNoteDetailApiUrl(url)
}

function assertExactApiUrl(value: string, endpoint: string): void {
  if (typeof value !== 'string' || value.length > 2_048) throw new Error('小红书 API 响应地址非法')
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('小红书 API 响应地址非法')
  }
  if (url.origin !== XIAOHONGSHU_CREATOR_ORIGIN || url.username || url.password || url.port) {
    throw new Error('小红书 API 响应来源不在白名单')
  }
  if (url.pathname === '/' || url.pathname === '/login' || url.pathname.startsWith('/login/') ||
    url.pathname === '/new/login' || url.pathname.startsWith('/new/login/')) {
    throw new XiaohongshuApiError('AUTH_REQUIRED', '小红书登录状态已失效，请重新登录')
  }
  if (url.pathname !== endpoint || url.search || url.hash) {
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
  return typeof response.mimeType === 'string' ? response.mimeType : ''
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
    for (const tags of [data.tags, nested.tags]) {
      if (!Array.isArray(tags)) continue
      for (const value of tags) {
        const count = objectRecord(value).notes_count
        if (Number.isSafeInteger(count) && (count as number) >= 0) {
          total = Math.max(total, count as number)
        }
      }
    }
    const pageCursor = data.page ?? nested.page
    lastHasMore = data.has_more === true || data.hasMore === true ||
      nested.has_more === true || nested.hasMore === true ||
      (Number.isSafeInteger(pageCursor) && pageCursor !== -1)
  }
  if (!sawNotes || ids.size >= limit) return false
  return (total > 0 && ids.size < Math.min(total, limit)) || (total === 0 && lastHasMore)
}

function analyzeCaptureNeedsMore(
  responses: readonly XiaohongshuJsonResponse[],
  limit: number
): boolean {
  let total = 0
  let sawAnalyzeResponse = false
  const ids = new Set<string>()
  for (const response of responses) {
    if (!isNoteAnalyzeListUrl(response.url)) continue
    const envelope = objectRecord(response.json)
    const data = objectRecord(envelope.data)
    if (!Array.isArray(data.note_infos)) continue
    sawAnalyzeResponse = true
    if (Number.isSafeInteger(data.total) && (data.total as number) >= 0) {
      total = Math.max(total, data.total as number)
    }
    data.note_infos.forEach((value, index) => {
      const note = objectRecord(value)
      const id = note.id
      ids.add(id === undefined || id === null || id === ''
        ? `${response.url}#${index}`
        : String(id))
    })
  }
  if (!sawAnalyzeResponse || total === 0 || ids.size >= limit) return false
  return ids.size < Math.min(total, limit)
}

async function fetchRemainingXiaohongshuAnalyzePages(
  contents: Pick<WebContents, 'executeJavaScript' | 'isDestroyed'>,
  initial: readonly XiaohongshuJsonResponse[],
  limit: number,
  timeoutMs: number
): Promise<readonly XiaohongshuJsonResponse[]> {
  const results = new Map(initial.map((response) => [response.url, response]))
  const pageSize = analyzeCapturePageSize(initial, limit)
  let attempts = 0
  while (analyzeCaptureNeedsMore([...results.values()], limit) && attempts < 100) {
    const before = analyzeCaptureIdCount([...results.values()])
    const pageNum = Math.max(1, ...[...results.values()].map((response) => pageNumber(response.url))) + 1
    if (pageNum > 100) break
    const response = await fetchXiaohongshuAnalyzePage(contents, pageNum, pageSize, timeoutMs)
    results.set(response.url, response)
    attempts += 1
    if (analyzeCaptureIdCount([...results.values()]) <= before) break
  }
  return [...results.values()].sort((left, right) => pageNumber(left.url) - pageNumber(right.url))
}

function analyzeCapturePageSize(
  responses: readonly XiaohongshuJsonResponse[],
  limit: number
): number {
  for (const response of responses) {
    try {
      const size = Number(new URL(response.url).searchParams.get('page_size') || '')
      if (Number.isInteger(size) && size >= 1 && size <= 100) return size
    } catch {}
  }
  return Math.min(10, limit)
}

function analyzeCaptureIdCount(responses: readonly XiaohongshuJsonResponse[]): number {
  const ids = new Set<string>()
  for (const response of responses) {
    const notes = objectRecord(objectRecord(response.json).data).note_infos
    if (!Array.isArray(notes)) continue
    notes.forEach((value, index) => {
      const id = objectRecord(value).id
      ids.add(id === undefined || id === null || id === ''
        ? `${response.url}#${index}`
        : String(id))
    })
  }
  return ids.size
}

async function fetchXiaohongshuAnalyzePage(
  contents: Pick<WebContents, 'executeJavaScript' | 'isDestroyed'>,
  pageNum: number,
  pageSize: number,
  timeoutMs: number
): Promise<XiaohongshuJsonResponse> {
  if (contents.isDestroyed()) throw new Error('浏览器页面已关闭')
  if (!Number.isInteger(pageNum) || pageNum < 1 || pageNum > 100 ||
    !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw new Error('小红书作品分析分页参数非法')
  }
  const target = new URL(XIAOHONGSHU_API_ENDPOINTS.noteAnalyzeList, 'https://creator.xiaohongshu.com')
  target.searchParams.set('type', '0')
  target.searchParams.set('page_size', String(pageSize))
  target.searchParams.set('page_num', String(pageNum))
  const source = `(async () => {
    const target = ${JSON.stringify(target.toString())};
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ${timeoutMs});
    try {
      const response = await fetch(target, {
        method: 'GET',
        credentials: 'include',
        redirect: 'manual',
        headers: { Accept: 'application/json, text/plain, */*' },
        signal: controller.signal
      });
      if (response.type === 'opaqueredirect' ||
          (response.status >= 300 && response.status < 400)) {
        return { error: 'AUTH_REDIRECT' };
      }
      if (response.status === 0) return { error: 'NETWORK' };
      const contentType = response.headers.get('content-type') || '';
      const declaredLength = Number(response.headers.get('content-length') || '0');
      if (Number.isFinite(declaredLength) && declaredLength > ${SIGNED_JSON_LIMIT_BYTES}) {
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
        if (total > ${SIGNED_JSON_LIMIT_BYTES}) {
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
        url: response.url || target,
        redirected: response.redirected === true,
        contentType,
        text: new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      };
    } catch {
      return { error: controller.signal.aborted ? 'TIMEOUT' : 'NETWORK' };
    } finally {
      clearTimeout(timeout);
    }
  })()`
  const raw = objectRecord(await withTimeout(
    contents.executeJavaScript(source),
    timeoutMs + 2_000,
    '小红书作品分析分页请求超时'
  ))
  if (raw.error === 'TIMEOUT') throw new Error('小红书作品分析分页请求超时')
  if (raw.error === 'TOO_LARGE') throw new Error('小红书作品分析响应超过 512 KiB')
  if (raw.error === 'AUTH_REDIRECT') {
    throw new XiaohongshuApiError('AUTH_REQUIRED', '小红书登录状态已失效，请重新登录')
  }
  if (raw.error === 'NETWORK') throw new Error('小红书作品分析接口暂时无法连接')
  if (raw.error) throw new Error('小红书作品分析接口请求失败')
  if (!Number.isInteger(raw.status) || typeof raw.url !== 'string' || typeof raw.text !== 'string') {
    throw new Error('小红书作品分析响应结构非法')
  }
  if (raw.redirected === true) throw new Error('小红书作品分析响应发生了未允许的重定向')
  if (raw.status === 401 || raw.status === 403) {
    throw new XiaohongshuApiError('AUTH_REQUIRED', '小红书登录状态已失效，请重新登录')
  }
  if (raw.status === 429 || raw.status === 461 || raw.status === 471) {
    throw new XiaohongshuApiError('RISK_CONTROL', '小红书暂时限制了作品分析请求')
  }
  assertExactAnalyzePageUrl(raw.url, pageNum, pageSize)
  assertJsonContentType(typeof raw.contentType === 'string' ? raw.contentType : '')
  if (Buffer.byteLength(raw.text, 'utf8') > SIGNED_JSON_LIMIT_BYTES) {
    throw new Error('小红书作品分析响应超过 512 KiB')
  }
  return { status: raw.status as number, url: raw.url, json: parseJson(raw.text) }
}

function assertExactAnalyzePageUrl(value: string, pageNum: number, pageSize: number): void {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('小红书作品分析响应地址非法')
  }
  const allowed = new Set(['type', 'page_size', 'page_num'])
  if (url.protocol !== 'https:' || url.hostname !== 'creator.xiaohongshu.com' ||
    url.username || url.password || url.port || url.hash ||
    url.pathname !== XIAOHONGSHU_API_ENDPOINTS.noteAnalyzeList ||
    [...url.searchParams.keys()].some((key) => !allowed.has(key)) ||
    url.searchParams.getAll('type').length !== 1 ||
    url.searchParams.getAll('page_size').length !== 1 ||
    url.searchParams.getAll('page_num').length !== 1 ||
    url.searchParams.get('type') !== '0' ||
    url.searchParams.get('page_size') !== String(pageSize) ||
    url.searchParams.get('page_num') !== String(pageNum)) {
    throw new Error('小红书作品分析响应地址不在白名单')
  }
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

function renderDeclaredUrl(
  originValue: string,
  pathTemplate: string,
  queryParameters: readonly string[],
  params: Record<string, unknown>
): string {
  const used = new Set<string>()
  const target = renderDeclaredUrlWithUsed(originValue, pathTemplate, queryParameters, params, used)
  assertNoUndeclaredParams(params, used)
  return target
}

function renderDeclaredCaptureUrls(
  declaration: PlatformCaptureDeclaration,
  params: Record<string, unknown>
): { routeUrl: string; responseUrl: string; routeParameters: Record<string, string> } {
  const used = new Set<string>()
  const route = declaredRouteTemplateParts(declaration.route)
  const renderedRoute = new URL(renderDeclaredUrlWithUsed(route.origin, route.path, [], params, used))
  renderedRoute.search = route.search
  const responseUrl = renderDeclaredUrlWithUsed(
    declaration.responseOrigin,
    declaration.responsePath,
    [],
    params,
    used
  )
  assertNoUndeclaredParams(params, used)
  const routeParameters: Record<string, string> = {}
  for (const match of route.path.matchAll(/\{([a-zA-Z][a-zA-Z0-9_-]{0,63})\}/g)) {
    const key = match[1]!
    routeParameters[key] = declaredScalar(params[key], key)
  }
  return { routeUrl: renderedRoute.href, responseUrl, routeParameters }
}

function renderDeclaredUrlWithUsed(
  originValue: string,
  pathTemplate: string,
  queryParameters: readonly string[],
  params: Record<string, unknown>,
  used: Set<string>
): string {
  const path = pathTemplate.replace(/\{([a-zA-Z][a-zA-Z0-9_-]{0,63})\}/g, (_match, key: string) => {
    const value = declaredScalar(params[key], key)
    used.add(key)
    return encodeURIComponent(value)
  })
  if (/[{}]/.test(path)) throw new Error('平台端点路径参数不完整')
  const target = new URL(path, originValue)
  if (target.origin !== new URL(originValue).origin || !target.pathname.startsWith('/')) {
    throw new Error('平台端点超出清单声明来源')
  }
  for (const key of queryParameters) {
    const value = params[key]
    if (value === undefined || value === null || value === '') continue
    used.add(key)
    target.searchParams.set(key, declaredScalar(value, key))
  }
  target.username = ''
  target.password = ''
  target.hash = ''
  return target.href
}

function declaredRouteTemplateParts(value: string): { origin: string; path: string; search: string } {
  const match = /^(https:\/\/[^/?#]+)(\/[^?#]*)?(\?[^#]*)?$/i.exec(value)
  if (!match || /[{}]/.test(match[1]!) || /[{}]/.test(match[3] ?? '')) {
    throw new Error('平台捕获页面路由模板非法')
  }
  const path = match[2] ?? '/'
  let route: URL
  try {
    route = new URL(`${match[1]}${path.replace(/\{[A-Za-z][A-Za-z0-9_]{0,63}\}/g, 'template')}${match[3] ?? ''}`)
  } catch {
    throw new Error('平台捕获页面路由模板非法')
  }
  const queryKeys = [...route.searchParams.keys()]
  if (route.protocol !== 'https:' || route.username || route.password || route.port ||
    hasExplicitRoutePort(match[1]!) || !route.hostname || path.startsWith('//') ||
    new Set(queryKeys).size !== queryKeys.length) throw new Error('平台捕获页面路由模板非法')
  return { origin: route.origin, path, search: route.search }
}

function hasExplicitRoutePort(origin: string): boolean {
  const authority = origin.slice(origin.indexOf('//') + 2)
  const host = authority.slice(authority.lastIndexOf('@') + 1)
  if (host.startsWith('[')) return host.slice(host.indexOf(']') + 1).startsWith(':')
  return host.includes(':')
}

function assertNoUndeclaredParams(params: Record<string, unknown>, used: ReadonlySet<string>): void {
  if (Object.keys(params).some((key) => !used.has(key))) throw new Error('平台端点包含未声明参数')
}

function declaredScalar(value: unknown, label: string): string {
  if ((typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') ||
    (typeof value === 'number' && !Number.isFinite(value))) throw new Error(`平台端点参数 ${label} 无效`)
  const text = String(value)
  if (text.length === 0 || text.length > 512 || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new Error(`平台端点参数 ${label} 无效`)
  }
  return text
}

async function fetchDeclaredPlatformJson(
  contents: Pick<WebContents, 'executeJavaScript' | 'isDestroyed'>,
  target: string,
  maximumBytes: number
): Promise<unknown> {
  if (contents.isDestroyed()) throw new Error('账号浏览器工作区已关闭')
  const script = `(() => {
    const target = ${JSON.stringify(target)};
    const limit = ${Math.max(1, Math.min(maximumBytes, 512 * 1024))};
    return Promise.race([
      (async () => {
        const response = await fetch(target, { method: 'GET', credentials: 'include', redirect: 'error', cache: 'no-store' });
        const reader = response.body && response.body.getReader ? response.body.getReader() : null;
        const chunks = [];
        let total = 0;
        if (reader) {
          while (true) {
            const part = await reader.read();
            if (part.done) break;
            total += part.value.byteLength;
            if (total > limit) { await reader.cancel(); throw new Error('RESPONSE_TOO_LARGE'); }
            chunks.push(part.value);
          }
        }
        const bytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        return {
          status: response.status,
          url: response.url,
          contentType: response.headers.get('content-type') || '',
          text: new TextDecoder('utf-8', { fatal: true }).decode(bytes)
        };
      })(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('REQUEST_TIMEOUT')), 12000))
    ]);
  })()`
  const result = objectRecord(await contents.executeJavaScript(script, true))
  const status = Number(result.status)
  const contentType = String(result.contentType ?? '')
  const text = String(result.text ?? '')
  const diagnosticInput = { status, contentType, body: text }
  if (status === 401 || status === 403) {
    throw pluginNetworkResponseError('平台登录状态已失效，请重新登录', diagnosticInput)
  }
  if (status === 429) {
    throw pluginNetworkResponseError('平台请求暂时受限，请稍后重试', diagnosticInput)
  }
  if (!Number.isSafeInteger(status) || status < 200 || status >= 300) {
    throw pluginNetworkResponseError('平台 JSON 端点返回异常状态', diagnosticInput)
  }
  if (String(result.url) !== target) throw new Error('平台 JSON 响应地址与清单端点不一致')
  if (!/\bjson\b/i.test(contentType)) {
    throw pluginNetworkResponseError('平台端点未返回 JSON', diagnosticInput)
  }
  if (Buffer.byteLength(text, 'utf8') > maximumBytes) {
    throw pluginNetworkResponseError('平台 JSON 响应超过大小限制', diagnosticInput)
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw pluginNetworkResponseError('平台端点返回了无效 JSON', diagnosticInput)
  }
  if (hasPluginApiError(value)) {
    throw pluginNetworkResponseError('平台 JSON 端点返回 API 错误', diagnosticInput)
  }
  return value
}

async function captureDeclaredPlatformJson(
  contents: Pick<WebContents, 'debugger' | 'isDestroyed' | 'loadURL' | 'sendInputEvent'>,
  declaration: PlatformCaptureDeclaration,
  expectedUrl: string,
  limit: number,
  routeUrl = declaration.route,
  acceptValue?: (value: unknown) => boolean
): Promise<unknown[]> {
  if (contents.isDestroyed()) throw new Error('账号浏览器工作区已关闭')
  const browserDebugger = contents.debugger
  if (browserDebugger.isAttached()) throw new Error('账号浏览器调试通道正在使用')
  const expected = new URL(expectedUrl)
  const values: unknown[] = []
  const responseDigests = new Set<string>()
  const pending = new Map<string, { status: number; contentType: string }>()
  const harvestTasks = new Set<Promise<void>>()
  const candidateLimit = Math.min(20, Math.max(limit, limit * 2))
  const requestTrackingLimit = Math.min(100, Math.max(20, candidateLimit * 4))
  const captureDeadline = Date.now() + 35_000
  let harvestTail = Promise.resolve()
  const requestMethods = new Map<string, string>()
  const maximumResponseBytes = declaration.maximumResponseBytes ?? 512 * 1024
  const maximumTotalBytes = declaration.maximumTotalBytes ?? 2 * 1024 * 1024
  let totalBytes = 0
  let lastActivity = Date.now()
  let failure: Error | null = null
  let rejectedFailure: Error | null = null
  let accepting = true

  const runBeforeDeadline = async <T>(
    operation: () => Promise<T>,
    maximumMilliseconds: number,
    message: string
  ): Promise<T> => {
    const remaining = captureDeadline - Date.now()
    if (remaining <= 0) throw new Error('平台响应捕获超时，请稍后重试')
    return await withPlatformCaptureTimeout(operation(), Math.min(maximumMilliseconds, remaining), message)
  }

  const matches = (value: string): boolean => {
    return matchesDeclaredCaptureUrl(value, declaration, expected)
  }
  const harvest = async (
    requestId: string,
    metadata: { status: number; contentType: string }
  ): Promise<void> => {
    if (failure || values.length >= limit) return
    try {
      const body = objectRecord(await runBeforeDeadline(
        async () => await browserDebugger.sendCommand('Network.getResponseBody', { requestId }),
        5_000,
        '平台响应正文读取超时，请稍后重试'
      ))
      if (failure || values.length >= limit) return
      const raw = typeof body.body === 'string' ? body.body : ''
      const bytes = body.base64Encoded === true ? Buffer.from(raw, 'base64') : Buffer.from(raw, 'utf8')
      try {
        const diagnosticInput = {
          status: metadata.status,
          contentType: metadata.contentType,
          body: bytes
        }
        if (bytes.byteLength > maximumResponseBytes) {
          throw pluginNetworkResponseError('平台捕获响应超过清单限制', diagnosticInput)
        }
        if (metadata.status === 401 || metadata.status === 403) {
          throw pluginNetworkResponseError('平台登录状态已失效，请重新登录', diagnosticInput)
        }
        if (metadata.status === 429) {
          throw pluginNetworkResponseError('平台请求暂时受限，请稍后重试', diagnosticInput)
        }
        if (metadata.status < 200 || metadata.status >= 300) {
          rejectedFailure = pluginNetworkResponseError('平台捕获端点返回异常状态', diagnosticInput)
          return
        }
        if (!/\bjson\b/i.test(metadata.contentType)) {
          rejectedFailure = pluginNetworkResponseError('平台捕获端点未返回 JSON', diagnosticInput)
          return
        }
        let value: unknown
        try {
          value = JSON.parse(bytes.toString('utf8'))
        } catch {
          rejectedFailure = pluginNetworkResponseError('平台捕获端点返回了无效 JSON', diagnosticInput)
          return
        }
        if (hasPluginApiError(value)) {
          rejectedFailure = pluginNetworkResponseError('平台捕获端点返回 API 错误', diagnosticInput)
          return
        }
        if (acceptValue && !acceptValue(value)) return
        // A valid replay proves recovery from an earlier rejected candidate,
        // but must not consume the bounded quota reserved for unique pages.
        rejectedFailure = null
        lastActivity = Date.now()
        const responseDigest = createHash('sha256').update(bytes).digest('hex')
        if (responseDigests.has(responseDigest)) return
        if (totalBytes + bytes.byteLength > maximumTotalBytes) {
          throw pluginNetworkResponseError('平台捕获响应超过清单限制', diagnosticInput)
        }
        if (values.length >= limit) return
        responseDigests.add(responseDigest)
        totalBytes += bytes.byteLength
        values.push(value)
      } finally {
        bytes.fill(0)
      }
    } catch (error) {
      failure = error instanceof Error ? error : new Error('平台响应捕获失败')
    }
  }
  const queueHarvest = (requestId: string): void => {
    const metadata = pending.get(requestId)
    if (!metadata) return
    pending.delete(requestId)
    const task = harvestTail.then(async () => await harvest(requestId, metadata))
    harvestTail = task
    harvestTasks.add(task)
    void task.finally(() => harvestTasks.delete(task))
  }
  const onMessage = (_event: Electron.Event, method: string, params: Record<string, unknown>): void => {
    if (method === 'Network.requestWillBeSent') {
      const requestId = typeof params.requestId === 'string' ? params.requestId : ''
      const request = objectRecord(params.request)
      if (accepting && requestId && requestMethods.size < requestTrackingLimit && matches(String(request.url ?? ''))) {
        requestMethods.set(requestId, String(request.method ?? '').toUpperCase())
      }
      return
    }
    if (method === 'Network.responseReceived') {
      const requestId = typeof params.requestId === 'string' ? params.requestId : ''
      const response = objectRecord(params.response)
      const resourceType = String(params.type ?? '')
      const url = String(response.url ?? '')
      const status = Number(response.status)
      const headers = objectRecord(response.headers)
      const contentType = String(headers['content-type'] ?? headers['Content-Type'] ?? '')
      if (!accepting || failure || values.length >= limit ||
        pending.size + harvestTasks.size >= candidateLimit ||
        !requestId || !matches(url) ||
        !declaration.resourceTypes.includes(resourceType as 'Fetch' | 'XHR') ||
        requestMethods.get(requestId) !== 'GET') return
      pending.set(requestId, {
        status,
        contentType
      })
      lastActivity = Date.now()
      return
    }
    if (method === 'Network.loadingFinished') {
      const requestId = typeof params.requestId === 'string' ? params.requestId : ''
      if (requestId) queueHarvest(requestId)
      requestMethods.delete(requestId)
    }
    if (method === 'Network.loadingFailed') {
      const requestId = typeof params.requestId === 'string' ? params.requestId : ''
      pending.delete(requestId)
      requestMethods.delete(requestId)
    }
  }
  const onDetach = (): void => {
    if (!accepting || failure) return
    failure = normalizePluginNetworkError(
      new Error('账号浏览器调试通道意外断开'),
      '平台响应捕获调试通道意外断开'
    )
  }

  browserDebugger.attach('1.3')
  browserDebugger.on('message', onMessage)
  browserDebugger.on('detach', onDetach)
  try {
    await runBeforeDeadline(
      async () => await browserDebugger.sendCommand('Network.enable', {
        maxTotalBufferSize: maximumTotalBytes,
        maxResourceBufferSize: maximumResponseBytes
      }),
      12_000,
      '平台响应捕获初始化超时，请稍后重试'
    )
    await runBeforeDeadline(
      async () => await contents.loadURL(routeUrl),
      20_000,
      '平台页面加载超时，请稍后重试'
    )
    const activityDeadline = Math.min(Date.now() + 20_000, captureDeadline)
    let pageMoves = 0
    while (!failure && values.length < limit && Date.now() < activityDeadline) {
      if (declaration.pagination === 'page-down' && pageMoves < 20) {
        contents.sendInputEvent({ type: 'keyDown', keyCode: 'END' })
        contents.sendInputEvent({ type: 'keyUp', keyCode: 'END' })
        pageMoves += 1
      }
      await new Promise((resolve) => setTimeout(resolve, 350))
      if (declaration.pagination !== 'page-down' &&
        values.length > 0 && pending.size === 0 && harvestTasks.size === 0 &&
        Date.now() - lastActivity >= 800) break
    }
    accepting = false
    for (const requestId of [...pending.keys()]) queueHarvest(requestId)
    while (harvestTasks.size > 0) await Promise.all([...harvestTasks])
    if (failure) throw failure
    if (rejectedFailure) throw rejectedFailure
    return values
  } finally {
    accepting = false
    browserDebugger.removeListener('message', onMessage)
    browserDebugger.removeListener('detach', onDetach)
    try {
      await withPlatformCaptureTimeout(
        browserDebugger.sendCommand('Network.disable'),
        2_000,
        '平台响应捕获清理超时'
      )
    } catch {}
    try { browserDebugger.detach() } catch {}
  }
}

function withPlatformCaptureTimeout<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), milliseconds)
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error: unknown) => { clearTimeout(timer); reject(error) }
    )
  })
}

function matchesDeclaredCaptureUrl(
  value: string,
  declaration: PlatformCaptureDeclaration,
  expectedValue: string | URL
): boolean {
  try {
    const url = new URL(value)
    const expected = typeof expectedValue === 'string' ? new URL(expectedValue) : expectedValue
    if (url.origin !== expected.origin || url.username || url.password) return false
    if (!declaration.graphqlOperationName) return url.pathname === expected.pathname
    const prefix = `${expected.pathname}/`
    if (!url.pathname.startsWith(prefix)) return false
    const suffix = url.pathname.slice(prefix.length)
    const separator = suffix.indexOf('/')
    if (separator < 1 || suffix.indexOf('/', separator + 1) !== -1) return false
    const queryId = suffix.slice(0, separator)
    const operationName = suffix.slice(separator + 1)
    return /^[A-Za-z0-9_-]{1,128}$/.test(queryId) && operationName === declaration.graphqlOperationName
  } catch {
    return false
  }
}

export const __xiaohongshuApiTransportTest = Object.freeze({
  fetchPageJson: fetchXiaohongshuPageJson,
  prepareApiPage: prepareXiaohongshuApiContents,
  captureSignedJson: captureXiaohongshuSignedJson
})

export const __zhihuApiTransportTest = Object.freeze({
  fetchPageJson: fetchZhihuPageJson,
  prepareApiPage: prepareZhihuApiContents
})

export const __browserWorkspaceLeaseTest = Object.freeze({
  begin: beginApiLease,
  end: endApiLease,
  promote: promoteApiWorkspace,
  entryUrl: interactiveWorkspaceEntryUrl,
  initializeRemote: initializeRemoteWorkspace
})

function interactiveWorkspaceEntryUrl(
  platform: Pick<PlatformDefinition, 'id' | 'loginUrl' | 'homeUrl'>
): string {
  return platform.id === 'x' ? platform.homeUrl : platform.loginUrl
}

async function initializeRemoteWorkspace(
  contents: Pick<WebContents, 'isDestroyed' | 'loadURL'>
): Promise<void> {
  if (contents.isDestroyed()) throw new Error('账号浏览器工作区已关闭')
  await contents.loadURL('about:blank')
}

export const __pluginPlatformJsonTest = Object.freeze({
  renderDeclaredUrl,
  renderDeclaredCaptureUrls,
  matchesDeclaredCaptureUrl,
  fetchDeclaredPlatformJson,
  captureDeclaredPlatformJson
})

function safeHostname(value: string): string {
  try {
    return new URL(value).hostname || '未知地址'
  } catch {
    return '无效地址'
  }
}

function displayAccountName(account: Pick<Account, 'alias' | 'remoteName'>, platformName: string): string {
  return sanitizeTitle(account.alias) || sanitizeTitle(account.remoteName) || `${platformName}账号`
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
