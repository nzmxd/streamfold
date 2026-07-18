import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  net,
  nativeTheme,
  protocol,
  session,
  Tray,
  type NativeImage
} from 'electron'
import electronUpdater from 'electron-updater'
import type { UpdateUnsupportedReason } from '../shared/contracts'
import { BrowserManager } from './browser-manager'
import { AppLogService } from './app-log-service'
import { BackupService } from './backup-service'
import { SocialDatabase } from './database'
import { ExportService } from './export-service'
import { loadApplicationIcon, loadTrayIcon } from './icon-assets'
import { registerIpc, unregisterIpc } from './ipc'
import { PluginHostService } from './plugins/plugin-host-service'
import { ElectronPluginSecretStore } from './plugins/plugin-secret-store'
import { PluginAutomationService } from './plugins/automation-service'
import { BrowserPlatformJsonProxy } from './plugins/browser-platform-json-proxy'
import { PluginEntryResolver, PluginEntryStore } from './plugins/plugin-entry-store'
import { PluginLifecycleService } from './plugins/plugin-lifecycle-service'
import {
  OFFICIAL_DEFAULT_PLATFORM_PLUGIN_IDS,
  verifyAndStageOfficialPluginResources
} from './plugins/official-plugin-resources'
import { PlatformAdapterRegistryService } from './plugins/platform-adapter-registry'
import type { VerifiedPluginPackage } from './plugins/plugin-package'
import { PluginRuntimeExecutor } from './plugins/plugin-runtime-executor'
import { DEFAULT_SANDBOX_LIMITS } from './plugins/sandbox-protocol'
import { UtilityProcessSandboxManager } from './plugins/utility-process-manager'
import { pluginCatalogReleaseConfig } from './plugins/release-config'
import { PlatformSyncService } from './platform-sync-service'
import { registerManifestPlatforms } from './platforms'
import { ProfileMediaStore } from './profile-media'
import { SettingsService } from './settings-service'
import { JobService } from './services/job-service'
import { AccountExecutionCoordinator } from './services/account-execution-coordinator'
import { SyncBatchService } from './services/sync-batch-service'
import { TaskQueryService } from './services/task-query-service'
import { XiaohongshuApiService } from './xiaohongshu-api-service'
import { ZhihuApiService } from './zhihu-api-service'
import { isTrustedShellUrl } from './shell-security'
import { ElectronUpdateClient } from './electron-update-client'
import { UpdateService } from './update-service'
import { consumeErrorReportContext, setErrorReporter } from './error-reporting'

declare const __STREAMFOLD_AUTO_UPDATE_ENABLED__: boolean

const currentDir = dirname(fileURLToPath(import.meta.url))
const smokeMode = process.env.SOCIAL_VAULT_SMOKE === '1'
const reviewMode = process.env.SOCIAL_VAULT_REVIEW === '1'
app.setName('Streamfold')
if (process.platform === 'win32') app.setAppUserModelId('com.streamfold.app')
if (smokeMode) app.disableHardwareAcceleration()
if (smokeMode || reviewMode) {
  app.setPath('userData', join(tmpdir(), `social-vault-${smokeMode ? 'smoke' : 'review'}-${process.pid}`))
} else {
  // Keep the original directory so rebranding never strands existing accounts,
  // Chromium partitions, backups metadata, or historical statistics.
  app.setPath('userData', join(app.getPath('appData'), 'social-vault'))
}
const gotSingleInstanceLock = app.requestSingleInstanceLock()
const appLogger = new AppLogService(join(app.getPath('userData'), 'logs'))
setErrorReporter((error, metadata) => {
  appLogger.captureError(metadata.scope, error, metadata.context)
})
if (gotSingleInstanceLock) {
  appLogger.sanitizeStoredLogs()
  appLogger.info('app', '应用进程启动', {
    context: { version: app.getVersion(), platform: process.platform, pid: process.pid }
  })
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: false,
      stream: true
    }
  }
])

if (!gotSingleInstanceLock) app.quit()

let mainWindow: BrowserWindow | null = null
let database: SocialDatabase | null = null
let browserManager: BrowserManager | null = null
let profileMediaStore: ProfileMediaStore | null = null
let smokeVisualAccountId: string | null = null
let applicationIcon: NativeImage | null = null
let tray: Tray | null = null
let updateService: UpdateService | null = null
let pluginAutomationService: PluginAutomationService | null = null
let syncBatchService: SyncBatchService | null = null
let taskQueryService: TaskQueryService | null = null
let pluginEntryStore: PluginEntryStore | null = null
let officialPluginPackages: readonly VerifiedPluginPackage[] | null = null
let removeTrayUpdateListener: (() => void) | null = null
let removeTrayTaskListener: (() => void) | null = null
let trayMenuSignature = ''
let trayRefreshSequence = 0

app.on('second-instance', () => {
  showMainWindow()
})

app.on('certificate-error', (event, _contents, _url, _error, _certificate, callback) => {
  event.preventDefault()
  callback(false)
})

app.on('login', (event, _contents, _details, _authInfo, callback) => {
  event.preventDefault()
  callback()
})

app.on('web-contents-created', (_event, contents) => {
  contents.on('will-attach-webview', (event) => event.preventDefault())
})

app.on('render-process-gone', (_event, contents, details) => {
  appLogger.error('renderer', '渲染进程已停止', {
    code: details.reason,
    context: {
      exitCode: details.exitCode,
      webContentsId: contents.id,
      origin: diagnosticOrigin(contents.getURL())
    }
  })
})

app.on('child-process-gone', (_event, details) => {
  if (details.reason === 'killed') return
  const metadata = {
    code: details.reason,
    context: { exitCode: details.exitCode, processType: details.type, serviceName: details.serviceName ?? null }
  }
  if (details.reason === 'clean-exit') appLogger.debug('process', 'Electron 子进程已结束', metadata)
  else appLogger.error('process', 'Electron 子进程异常停止', metadata)
})

process.on('uncaughtExceptionMonitor', (error, origin) => {
  appLogger.captureError('process', error, { origin })
})
process.on('unhandledRejection', (reason) => {
  appLogger.captureError('process', reason, { origin: 'unhandledRejection' })
  setImmediate(() => process.exit(1))
})

void app.whenReady().then(async () => {
  applicationIcon = loadApplicationIcon()
  profileMediaStore = new ProfileMediaStore(join(app.getPath('userData'), 'profile-media'))
  await registerShellProtocol(profileMediaStore)
  pluginEntryStore = new PluginEntryStore(join(app.getPath('userData'), 'plugins'))
  officialPluginPackages = await verifyAndStageOfficialPluginResources(
    app.isPackaged ? process.resourcesPath : resolve(currentDir, '../../resources'),
    pluginEntryStore
  )
  updateService = createUpdateService()
  removeTrayUpdateListener = updateService.subscribe(refreshTrayMenu)
  createWindow()
  updateService.start()
  if (!smokeMode) createTray()
  nativeTheme.on('updated', updateTrayIcon)

  app.on('activate', () => {
    showMainWindow()
  })
}).catch((error: unknown) => {
  const entry = appLogger.captureError('bootstrap', error)
  console.error(`STREAMFOLD_BOOTSTRAP_FAILED ${entry.id}`)
  if (!smokeMode) {
    dialog.showErrorBox('归页无法启动', '应用资源校验失败，请重新安装可信来源的最新版本。')
  }
  app.exit(1)
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  appLogger.info('app', '应用进程退出')
  nativeTheme.off('updated', updateTrayIcon)
  tray?.destroy()
  tray = null
  removeTrayUpdateListener?.()
  removeTrayUpdateListener = null
  removeTrayTaskListener?.()
  removeTrayTaskListener = null
  updateService?.destroy()
  updateService = null
  browserManager?.destroy()
  browserManager = null
  pluginAutomationService?.stop()
  pluginAutomationService = null
  syncBatchService?.stop()
  syncBatchService = null
  taskQueryService = null
  unregisterIpc()
  database?.close()
  database = null
})

function showMainWindow(): void {
  if (!app.isReady()) return
  if (!mainWindow || mainWindow.isDestroyed()) {
    if (!profileMediaStore || !updateService || !pluginEntryStore || !officialPluginPackages) return
    createWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function createTray(): void {
  if (tray) return
  const icon = loadTrayIcon()
  if (!icon) return

  tray = new Tray(icon)
  tray.setToolTip('归页 · Streamfold')
  trayMenuSignature = ''
  refreshTrayMenu()
  tray.on('click', showMainWindow)
}

function refreshTrayMenu(): void {
  const sequence = ++trayRefreshSequence
  void refreshTrayMenuAsync(sequence)
}

async function refreshTrayMenuAsync(sequence: number): Promise<void> {
  if (!tray || !updateService) return
  const state = updateService.getState()
  const taskSummary = taskQueryService
    ? await taskQueryService.summary().catch(() => null)
    : null
  if (sequence !== trayRefreshSequence || !tray || !updateService) return
  const automationPaused = pluginAutomationService?.isPaused() ?? false
  const signature = [
    state.phase,
    state.availableVersion ?? '',
    state.unsupportedReason ?? '',
    taskSummary?.runningCount ?? 0,
    taskSummary?.queuedCount ?? 0,
    taskSummary?.needsAttentionCount ?? 0,
    automationPaused ? 1 : 0
  ].join(':')
  if (trayMenuSignature === signature) return
  trayMenuSignature = signature

  const updateBusy = state.phase === 'checking' || state.phase === 'downloading'
  const updateReady = state.phase === 'downloaded'
  const updateLabel = updateReady
    ? `更新 v${state.availableVersion} 已准备好`
    : state.phase === 'checking'
      ? '正在检查更新…'
      : state.phase === 'downloading'
        ? `正在下载 v${state.availableVersion}…`
        : '检查软件更新'

  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示归页', click: showMainWindow },
    {
      label: `任务 · 运行 ${taskSummary?.runningCount ?? 0} · 排队 ${taskSummary?.queuedCount ?? 0}`,
      enabled: false
    },
    { label: '打开任务中心', click: openTaskCenter },
    {
      label: automationPaused ? '恢复自动任务' : '暂停新的自动任务',
      click: (): void => {
        const next = !(pluginAutomationService?.isPaused() ?? false)
        pluginAutomationService?.setPaused(next)
        database?.setSetting('automation.paused', next)
        refreshTrayMenu()
      }
    },
    ...((taskSummary?.needsAttentionCount ?? 0) > 0
      ? [{
          label: `需要处理 · ${taskSummary!.needsAttentionCount} 项`,
          click: openTaskCenter
        }]
      : []),
    { type: 'separator' as const },
    ...(!state.unsupportedReason
      ? [{
          label: updateLabel,
          enabled: !updateBusy,
          click: (): void => {
            showMainWindow()
            if (!updateReady) void updateService?.check()
          }
        }]
      : []),
    { type: 'separator' as const },
    { label: '退出', click: () => app.quit() }
  ]))
}

function openTaskCenter(): void {
  showMainWindow()
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('navigation:requested', 'tasks')
  }
}

function updateTrayIcon(): void {
  if (!tray) return
  const icon = loadTrayIcon()
  if (icon) tray.setImage(icon)
}

function createWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed()) return
  if (!profileMediaStore) throw new Error('头像媒体缓存尚未初始化')
  if (!updateService) throw new Error('更新服务尚未初始化')
  if (!pluginEntryStore || !officialPluginPackages) throw new Error('官方插件资源尚未验证')

  database = new SocialDatabase(join(app.getPath('userData'), 'social-vault.sqlite'))
  updateService.setAutomaticChecks(readAutomaticUpdatePreference(database))
  const recoveredJobs = database.recoverInterruptedJobs()
  const smokeTheme = process.env.SOCIAL_VAULT_SMOKE_THEME
  const savedTheme = database.getSetting<string>('appearance.theme', 'system')
  const initialTheme = smokeMode && (smokeTheme === 'light' || smokeTheme === 'dark')
    ? smokeTheme
    : savedTheme
  if (initialTheme === 'light' || initialTheme === 'dark' || initialTheme === 'system') {
    nativeTheme.themeSource = initialTheme
  }

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 760,
    minHeight: 640,
    title: '归页 · Streamfold',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0d1016' : '#f6f7fb',
    show: false,
    autoHideMenuBar: process.platform !== 'darwin',
    ...(applicationIcon ? { icon: applicationIcon } : {}),
    ...(process.platform === 'darwin'
      ? {
          titleBarStyle: 'hiddenInset' as const,
          trafficLightPosition: { x: 16, y: 17 }
        }
      : {
          titleBarStyle: 'hidden' as const,
          titleBarOverlay: {
            color: nativeTheme.shouldUseDarkColors ? '#141821' : '#ffffff',
            symbolColor: nativeTheme.shouldUseDarkColors ? '#f5f7fb' : '#171a24',
            height: 48
          }
        }),
    webPreferences: {
      preload: join(currentDir, '../preload/index.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      navigateOnDragDrop: false
    }
  })

  if (process.platform !== 'darwin') mainWindow.removeMenu()
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (details) => {
    if (!isTrustedShellUrl(details.url)) details.preventDefault()
  })
  mainWindow.webContents.on('will-frame-navigate', (details) => {
    if (!details.isMainFrame || !isTrustedShellUrl(details.url)) details.preventDefault()
  })
  mainWindow.once('ready-to-show', () => {
    if (!smokeMode) mainWindow?.show()
  })

  if (smokeMode && process.env.SOCIAL_VAULT_SMOKE_CAPTURE) {
    smokeVisualAccountId = database.createAccount({
      platformId: 'xiaohongshu',
      alias: '个人品牌号',
      syncMode: 'profile_only'
    }).id
  }
  browserManager = new BrowserManager(
    mainWindow,
    (id) => database?.getAccount(id) ?? null,
    join(currentDir, '../preload/browser.cjs'),
    process.env.ELECTRON_RENDERER_URL
      ? new URL('browser.html', process.env.ELECTRON_RENDERER_URL).toString()
      : 'app://browser/browser.html',
    !smokeMode,
    profileMediaStore,
    applicationIcon
  )
  const pluginSecretStore = new ElectronPluginSecretStore()
  installOfficialPluginPackages(database, officialPluginPackages)
  const pluginHostService = new PluginHostService(database, pluginSecretStore)
  pluginHostService.initialize(OFFICIAL_DEFAULT_PLATFORM_PLUGIN_IDS)
  registerManifestPlatforms(pluginHostService.extensionRegistry().platformDefinitions().map((platform) => ({
    id: platform.id,
    name: platform.name,
    shortName: platform.shortName,
    loginUrl: platform.loginUrl,
    homeUrl: platform.homeUrl,
    officialHosts: platform.navigationHosts,
    contentUrls: platform.contentUrls,
    riskNote: platform.riskNote
  })))
  const jobService = new JobService(database)
  const recoveredJobIds = new Set(recoveredJobs.map((job) => job.id))
  const terminalJobIds = new Set(database.listJobs()
    .filter((job) => (
      ['succeeded', 'succeeded_with_warnings', 'failed', 'cancelled', 'interrupted'].includes(job.status) &&
      !recoveredJobIds.has(job.id)
    ))
    .map((job) => job.id))
  const logTerminalJob = (job: ReturnType<SocialDatabase['listJobs']>[number]) => {
    if (!['succeeded', 'succeeded_with_warnings', 'failed', 'cancelled', 'interrupted'].includes(job.status) || terminalJobIds.has(job.id)) return
    terminalJobIds.add(job.id)
    const metadata = {
      code: job.errorCode || null,
      context: {
        jobId: job.id,
        accountId: job.accountId,
        pluginId: job.pluginId,
        contributionId: job.contributionId,
        status: job.status,
        attempt: job.attempt
      }
    }
    if (job.status === 'failed' || job.status === 'interrupted') {
      if (!consumeErrorReportContext('jobId', job.id)) {
        appLogger.error('sync', job.errorMessage || job.stage || '同步任务失败', metadata)
      }
    } else if (job.status === 'succeeded_with_warnings') {
      appLogger.warn('sync', job.stage || '同步任务部分完成', {
        ...metadata,
        context: {
          ...metadata.context,
          coverage: job.result?.coverage ?? null,
          warningCount: Array.isArray(job.result?.warnings) ? job.result.warnings.length : 0
        }
      })
    } else {
      appLogger.info('sync', job.stage || `同步任务${job.status === 'succeeded' ? '完成' : '取消'}`, metadata)
    }
  }
  const removeJobLogListener = jobService.onChanged(logTerminalJob)
  for (const recovered of recoveredJobs) logTerminalJob(recovered)
  const accountCoordinator = new AccountExecutionCoordinator()
  const xiaohongshuApiService = new XiaohongshuApiService({
    repository: database,
    browser: browserManager,
    plugins: pluginHostService,
    jobs: jobService
  })
  const zhihuApiService = new ZhihuApiService({
    repository: database,
    browser: browserManager,
    plugins: pluginHostService,
    jobs: jobService
  })
  let platformSyncRef: PlatformSyncService | null = null
  let runtimeExecutor!: PluginRuntimeExecutor
  const pluginEntryResolver = new PluginEntryResolver(pluginEntryStore)
  const sandboxManager = new UtilityProcessSandboxManager({
    runnerPath: join(currentDir, 'plugin-sandbox.js'),
    hostCall: (call, identity) => runtimeExecutor.hostCall(call, identity)
  })
  const platformJsonProxy = new BrowserPlatformJsonProxy(browserManager)
  runtimeExecutor = new PluginRuntimeExecutor(
    pluginHostService,
    database,
    pluginEntryResolver,
    sandboxManager,
    platformJsonProxy,
    undefined,
    {
      execute: async (request, contribution) => {
        if (contribution.kind !== 'platform.adapter' || !request.accountId || !platformSyncRef) {
          throw new Error('内置贡献点没有可执行的手动动作')
        }
        await platformSyncRef.sync(request.accountId, request.trigger === 'schedule' ? 'schedule' : 'manual')
        return null
      }
    }
  )
  const platformSyncService = new PlatformSyncService({
    repository: database,
    coordinator: accountCoordinator,
    adapters: {
      xiaohongshu: xiaohongshuApiService,
      zhihu: zhihuApiService,
      'xiaohongshu-session-api.platform': xiaohongshuApiService,
      'zhihu-session-api.platform': zhihuApiService
    }
  })
  platformSyncRef = platformSyncService
  const adapterRegistry = new PlatformAdapterRegistryService(
    database,
    pluginHostService,
    runtimeExecutor,
    jobService,
    platformSyncService,
    platformJsonProxy
  )
  adapterRegistry.reconcile()
  syncBatchService = new SyncBatchService(database, platformSyncService, jobService)
  taskQueryService = new TaskQueryService(database)
  const pluginLifecycle = new PluginLifecycleService({
    repository: database,
    host: pluginHostService,
    entries: pluginEntryStore,
    catalogUrl: pluginCatalogReleaseConfig.catalogUrl,
    catalogRootPublicKey: pluginCatalogReleaseConfig.catalogRootPublicKey,
    catalogCachePath: join(app.getPath('userData'), 'plugins', 'catalog.json'),
    appVersion: readApplicationVersion(),
    terminatePlugin: (pluginId) => {
      runtimeExecutor.terminatePlugin(pluginId)
      browserManager?.stopPluginCapturesForPlugin(pluginId)
    },
    chooseDevelopmentPackage: async () => {
      const result = await dialog.showOpenDialog(mainWindow!, {
        title: '安装开发插件',
        properties: ['openFile'],
        filters: [{ name: '归页插件包', extensions: ['streamfold-plugin'] }]
      })
      return result.canceled ? null : result.filePaths[0] ?? null
    }
  })
  void pluginLifecycle.initialize()
  pluginAutomationService = new PluginAutomationService(database, pluginHostService, runtimeExecutor)
  pluginAutomationService.setAccountCoordinator(accountCoordinator)
  pluginAutomationService.setPaused(database.getSetting<boolean>('automation.paused', false) === true)
  const pluginTerminalStatuses = ['succeeded', 'failed', 'cancelled', 'interrupted']
  const terminalPluginRunIds = new Set(database.listPluginRuns()
    .filter((run) => pluginTerminalStatuses.includes(run.status))
    .map((run) => run.id))
  const logPluginRunChanges = () => {
    for (const run of database!.listPluginRuns()) {
      if (!pluginTerminalStatuses.includes(run.status) || terminalPluginRunIds.has(run.id)) continue
      terminalPluginRunIds.add(run.id)
      const metadata = {
        code: run.errorCode || null,
        context: {
          runId: run.id,
          pluginId: run.pluginId,
          contributionId: run.contributionId,
          accountId: run.accountId,
          trigger: run.trigger,
          status: run.status,
          attempt: run.attempt
        }
      }
      if (run.status === 'failed' || run.status === 'interrupted') {
        if (!consumeErrorReportContext('runId', run.id)) {
          appLogger.error('plugin', run.errorMessage || '插件运行失败', metadata)
        }
      } else {
        appLogger.info('plugin', `插件运行${run.status === 'succeeded' ? '完成' : '取消'}`, metadata)
      }
    }
  }
  const removePluginLogListener = pluginAutomationService.onChanged(logPluginRunChanges)
  pluginAutomationService.start()
  logPluginRunChanges()
  syncBatchService.start()
  removeTrayTaskListener?.()
  const removeTrayJobListener = jobService.onChanged(refreshTrayMenu)
  const removeTrayPluginListener = pluginAutomationService.onChanged(refreshTrayMenu)
  removeTrayTaskListener = () => {
    removeTrayJobListener()
    removeTrayPluginListener()
    removePluginLogListener()
    removeJobLogListener()
  }
  refreshTrayMenu()
  const settingsService = new SettingsService({
    getStorageCounts: () => database!.getStorageCounts(),
    getSetting: (key) => database!.getSetting<string>(key),
    setSetting: (key, value) => { database!.setSetting(key, value) }
  }, database.databasePath, {
    appVersion: readApplicationVersion(),
    electronVersion: process.versions.electron,
    chromiumVersion: process.versions.chrome,
    nodeVersion: process.versions.node
  })
  const exportService = new ExportService(mainWindow, database)
  let restorePartitions: string[] = []
  const backupService = new BackupService({
    dialog: {
      showSaveDialog: (options) => dialog.showSaveDialog(mainWindow!, options),
      showOpenDialog: (options) => dialog.showOpenDialog(mainWindow!, options)
    },
    repository: database,
    beforeRestore: async () => {
      pluginAutomationService?.stop()
      syncBatchService?.stop()
      restorePartitions = database!.listAccounts().map((account) => account.sessionPartition)
      await browserManager?.closeAll()
      platformSyncService.invalidatePreviews()
    },
    afterRestore: () => {
      installOfficialPluginPackages(database!, officialPluginPackages!)
      pluginHostService.initialize(OFFICIAL_DEFAULT_PLATFORM_PLUGIN_IDS)
      registerManifestPlatforms(pluginHostService.extensionRegistry().platformDefinitions().map((platform) => ({
        id: platform.id,
        name: platform.name,
        shortName: platform.shortName,
        loginUrl: platform.loginUrl,
        homeUrl: platform.homeUrl,
        officialHosts: platform.navigationHosts,
        contentUrls: platform.contentUrls,
        riskNote: platform.riskNote
      })))
      adapterRegistry.reconcile()
      pluginAutomationService?.setPaused(database!.getSetting<boolean>('automation.paused', false) === true)
      pluginAutomationService?.start()
      syncBatchService?.start()
    },
    afterCommit: async () => {
      try {
        const restoredAccounts = database!.listAccounts()
        const restoredPartitions = restoredAccounts.map((account) => account.sessionPartition)
        await browserManager?.clearPartitions([...restorePartitions, ...restoredPartitions])
        // Avatar files are intentionally outside encrypted database backups. Restore clears
        // their database keys, so remove every pre-restore cache before the next sync.
        await browserManager?.pruneAccountMedia(new Set())
      } finally {
        restorePartitions = []
      }
    }
  })
  registerIpc(mainWindow, database, browserManager, {
    logs: appLogger,
    pluginHost: pluginHostService,
    pluginLifecycle,
    pluginAutomation: pluginAutomationService,
    adapterRegistry,
    settings: settingsService,
    exporter: exportService,
    backup: backupService,
    platformSync: platformSyncService,
    jobs: jobService,
    syncBatches: syncBatchService,
    tasks: taskQueryService,
    updates: updateService
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadURL('app://shell/index.html')
  }

  if (smokeMode) {
    mainWindow.webContents.once('did-finish-load', async () => {
      const shellResult = await mainWindow?.webContents.executeJavaScript(`(async () => {
        const hasApi = typeof window.socialVault === 'object'
        const platforms = hasApi ? await window.socialVault.platforms.list() : []
        const accounts = hasApi ? await window.socialVault.accounts.list() : []
        const plugins = hasApi ? await window.socialVault.plugins.listPackages() : []
        const contents = hasApi ? await window.socialVault.content.list() : []
        const dashboard = hasApi ? await window.socialVault.analytics.dashboard() : null
        const settings = hasApi ? await window.socialVault.settings.overview() : null
        const appearance = hasApi ? await window.socialVault.appearance.get() : null
        const updates = hasApi ? await window.socialVault.updates.getState() : null
        const catalog = hasApi ? await window.socialVault.plugins.getCatalog() : null
        const tasks = hasApi ? await window.socialVault.tasks.list({ limit: 1 }) : null
        const taskSummary = hasApi ? await window.socialVault.tasks.summary() : null
        return {
          title: document.title,
          hasApi,
          hasApp: Boolean(document.querySelector('#app')),
          platformCount: platforms.length,
          accountCount: accounts.length,
          pluginCount: plugins.length,
          contentCount: contents.length,
          jobCount: tasks?.total ?? 0,
          dashboardReady: Boolean(dashboard),
          settingsReady: Boolean(settings?.appVersion),
          appearanceReady: appearance?.resolved === 'light' || appearance?.resolved === 'dark',
          updatesReady: Boolean(updates?.currentVersion) && typeof window.socialVault.updates.check === 'function',
          catalogReady: typeof catalog?.configured === 'boolean',
          tasksReady: typeof taskSummary?.queuedCount === 'number' &&
            typeof window.socialVault.accounts.enqueueSyncBatch === 'function' &&
            typeof window.socialVault.tasks.cancel === 'function',
          pluginV2ApiReady: typeof window.socialVault.accounts.verifyIdentity === 'function' &&
            typeof window.socialVault.accounts.confirmIdentity === 'function' &&
            typeof window.socialVault.accounts.sync === 'function' &&
            typeof window.socialVault.accounts.bulkUpdate === 'function' &&
            typeof window.socialVault.accounts.previewSyncBatch === 'function' &&
            typeof window.socialVault.groups.update === 'function' &&
            typeof window.socialVault.settings.createBackup === 'function' &&
            typeof window.socialVault.settings.restoreBackup === 'function' &&
            typeof window.socialVault.appearance.set === 'function',
          text: document.body.innerText.slice(0, 80)
        }
      })()`)
      let workspaceResult: unknown = null
      let zhihuWorkspaceResult: unknown = null
      let partitionIsolation = false
      const sandboxResult = await sandboxManager.invoke({
        protocolVersion: 1,
        type: 'invoke',
        invocationId: 'smoke_invocation_0001',
        pluginId: 'streamfold.smoke',
        contributionId: 'streamfold.smoke.action',
        entrySource: 'module.exports = { run() { return { quickjs: true } } }',
        method: 'run',
        input: null,
        context: {},
        allowedOperations: [],
        limits: { ...DEFAULT_SANDBOX_LIMITS }
      })
      if (database && browserManager) {
        const first = database.createAccount({ platformId: 'xiaohongshu', alias: 'Smoke A', syncMode: 'disabled' })
        const second = database.createAccount({ platformId: 'xiaohongshu', alias: 'Smoke B', syncMode: 'disabled' })
        const zhihu = database.createAccount({ platformId: 'zhihu', alias: 'Smoke Zhihu', syncMode: 'disabled' })
        workspaceResult = await browserManager.smokeWorkspace(first.id)
        zhihuWorkspaceResult = await browserManager.smokeWorkspace(zhihu.id)
        partitionIsolation = await verifyPartitionIsolation(first.sessionPartition, second.sessionPartition)
        await browserManager.disconnect(first.id)
        await browserManager.disconnect(second.id)
        await browserManager.disconnect(zhihu.id)
        database.removeAccount(first.id)
        database.removeAccount(second.id)
        database.removeAccount(zhihu.id)
        await browserManager.purgeAccountMedia(first.id)
        await browserManager.purgeAccountMedia(second.id)
        await browserManager.purgeAccountMedia(zhihu.id)
      }
      const capturePath = process.env.SOCIAL_VAULT_SMOKE_CAPTURE
      if (capturePath && mainWindow) {
        const captureWidth = Number(process.env.SOCIAL_VAULT_SMOKE_WIDTH)
        if (Number.isSafeInteger(captureWidth) && captureWidth >= 920 && captureWidth <= 1920) {
          mainWindow.setSize(captureWidth, 720)
        }
        const captureSection = process.env.SOCIAL_VAULT_SMOKE_SECTION
        if (captureSection) {
          await mainWindow.webContents.executeJavaScript(`(() => {
            const label = ${JSON.stringify(captureSection)}
            const button = [...document.querySelectorAll('.main-nav nav button')]
              .find((item) => item.textContent?.trim().endsWith(label))
            if (button instanceof HTMLButtonElement) button.click()
          })()`)
        }
        await mainWindow.webContents.executeJavaScript(`new Promise((resolve) => {
          const deadline = Date.now() + 2000
          const check = () => {
            if (!document.querySelector('.feature-loading') || Date.now() >= deadline) resolve(undefined)
            else setTimeout(check, 25)
          }
          check()
        })`)
        await mainWindow.webContents.executeJavaScript(
          'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))'
        )
        writeFileSync(capturePath, (await mainWindow.webContents.capturePage()).toPNG())
      }
      if (smokeVisualAccountId && database) {
        database.removeAccount(smokeVisualAccountId)
        await browserManager?.purgeAccountMedia(smokeVisualAccountId)
        smokeVisualAccountId = null
      }
      const smokeTrayIcon = loadTrayIcon()
      let nativeTrayReady = false
      if (smokeTrayIcon && !smokeTrayIcon.isEmpty()) {
        const validationTray = new Tray(smokeTrayIcon)
        nativeTrayReady = !validationTray.isDestroyed()
        validationTray.destroy()
      }
      const iconResult = {
        applicationReady: Boolean(applicationIcon && !applicationIcon.isEmpty()),
        applicationSize: applicationIcon?.getSize() ?? null,
        trayReady: Boolean(smokeTrayIcon && !smokeTrayIcon.isEmpty()),
        traySize: smokeTrayIcon?.getSize() ?? null,
        nativeTrayReady
      }
      const smokePayload = {
        shell: shellResult,
        workspace: workspaceResult,
        zhihuWorkspace: zhihuWorkspaceResult,
        sandbox: sandboxResult,
        partitionIsolation,
        icons: iconResult,
        capturePath: capturePath ?? null
      }
      const shell = shellResult as {
        hasApi?: boolean
        hasApp?: boolean
        dashboardReady?: boolean
        settingsReady?: boolean
        appearanceReady?: boolean
        updatesReady?: boolean
        catalogReady?: boolean
        tasksReady?: boolean
        pluginV2ApiReady?: boolean
      } | null
      const workspace = workspaceResult as {
        hasApi?: boolean
        appearanceReady?: boolean
        accountId?: string
      } | null
      const zhihuWorkspace = zhihuWorkspaceResult as {
        hasApi?: boolean
        accountId?: string
        remoteUserAgent?: string
      } | null
      const sandbox = sandboxResult as { quickjs?: boolean } | null
      if (
        !shell?.hasApi || !shell.hasApp || !shell.dashboardReady || !shell.settingsReady ||
        !shell.appearanceReady || !shell.updatesReady || !shell.catalogReady || !shell.tasksReady ||
        !shell.pluginV2ApiReady ||
        !workspace?.hasApi || !workspace.accountId || !workspace.appearanceReady ||
        !zhihuWorkspace?.hasApi || !zhihuWorkspace.accountId ||
        !zhihuWorkspace.remoteUserAgent?.includes(`Chrome/${process.versions.chrome}`) ||
        zhihuWorkspace.remoteUserAgent.includes('Electron/') ||
        zhihuWorkspace.remoteUserAgent.includes(`${app.getName()}/`) || !partitionIsolation ||
        !sandbox?.quickjs || !iconResult.applicationReady || !iconResult.trayReady || !iconResult.nativeTrayReady
      ) {
        console.error(`SOCIAL_VAULT_SMOKE_FAILED ${JSON.stringify(smokePayload)}`)
        app.exit(1)
        return
      }
      if (process.env.SOCIAL_VAULT_SMOKE_RESULT) {
        writeFileSync(process.env.SOCIAL_VAULT_SMOKE_RESULT, JSON.stringify(smokePayload))
      }
      console.log(`SOCIAL_VAULT_SMOKE_OK ${JSON.stringify(smokePayload)}`)
      app.quit()
    })
    mainWindow.webContents.once('did-fail-load', (_event, code, description) => {
      console.error(`SOCIAL_VAULT_SMOKE_FAILED ${code} ${description}`)
      app.exit(1)
    })
  }

  mainWindow.on('closed', () => {
    browserManager?.destroy()
    browserManager = null
    removeTrayTaskListener?.()
    removeTrayTaskListener = null
    pluginAutomationService?.stop()
    pluginAutomationService = null
    syncBatchService?.stop()
    syncBatchService = null
    taskQueryService = null
    unregisterIpc()
    database?.close()
    database = null
    mainWindow = null
  })
}

function installOfficialPluginPackages(
  repository: SocialDatabase,
  verifiedPackages: readonly VerifiedPluginPackage[]
): void {
  for (const verified of verifiedPackages) {
    repository.upsertPluginPackage(verified.manifest, {
      source: 'builtin',
      status: 'active',
      packageHash: verified.archiveHash,
      publisherKeyId: verified.manifest.publisher.keyId,
      development: false
    })
  }
}

async function registerShellProtocol(profileMedia: ProfileMediaStore): Promise<void> {
  const rendererRoot = resolve(currentDir, '../renderer')
  await protocol.handle('app', async (request) => {
    const url = new URL(request.url)
    if (!['shell', 'browser'].includes(url.hostname)) return new Response('Not found', { status: 404 })

    if (url.hostname === 'shell' && url.pathname.startsWith('/media/')) {
      if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 })
      const media = await profileMedia.readAppUrl(request.url)
      if (!media) return new Response('Not found', { status: 404 })
      return new Response(media.bytes.slice().buffer as ArrayBuffer, {
        status: 200,
        headers: {
          'content-type': media.mime,
          'content-length': String(media.bytes.byteLength),
          'cache-control': 'private, max-age=31536000, immutable',
          'x-content-type-options': 'nosniff'
        }
      })
    }

    const relativePath = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html'
    const target = resolve(rendererRoot, relativePath)
    if (!isWithin(rendererRoot, target)) return new Response('Forbidden', { status: 403 })
    return net.fetch(pathToFileURL(target).toString())
  })
}

function isWithin(root: string, target: string): boolean {
  const value = relative(root, target)
  return value === '' || (!value.startsWith('..') && !isAbsolute(value))
}

function diagnosticOrigin(value: string): string {
  try {
    const url = new URL(value)
    return `${url.protocol}//${url.host}`.slice(0, 300)
  } catch {
    return 'unknown'
  }
}

async function verifyPartitionIsolation(firstPartition: string, secondPartition: string): Promise<boolean> {
  const first = session.fromPartition(firstPartition)
  const second = session.fromPartition(secondPartition)
  const url = 'https://social-vault-smoke.invalid/'
  await first.cookies.set({ url, name: 'partition-smoke', value: 'first', secure: true })
  const firstCookies = await first.cookies.get({ url, name: 'partition-smoke' })
  const secondCookies = await second.cookies.get({ url, name: 'partition-smoke' })
  return firstCookies.length === 1 && secondCookies.length === 0
}

function readApplicationVersion(): string {
  try {
    const value = JSON.parse(readFileSync(resolve(currentDir, '../../package.json'), 'utf8')) as {
      version?: unknown
    }
    if (typeof value.version === 'string' && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value.version)) {
      return value.version
    }
  } catch {
    // Packaged builds may provide version metadata without a readable package.json.
  }
  return app.getVersion()
}

function createUpdateService(): UpdateService {
  const currentVersion = readApplicationVersion()
  const unsupportedReason = updateUnsupportedReason()
  return new UpdateService({
    currentVersion,
    automaticChecks: true,
    unsupportedReason,
    client: unsupportedReason ? null : new ElectronUpdateClient(electronUpdater.autoUpdater, currentVersion)
  })
}

function updateUnsupportedReason(): UpdateUnsupportedReason | null {
  if (!app.isPackaged || smokeMode || reviewMode) return 'development'
  if (!__STREAMFOLD_AUTO_UPDATE_ENABLED__) return 'manual-update-only'
  if (!existsSync(join(process.resourcesPath, 'app-update.yml'))) return 'missing-source'
  if (process.platform === 'linux' && !process.env.APPIMAGE) return 'unsupported-package'
  return null
}

function readAutomaticUpdatePreference(repository: SocialDatabase): boolean {
  const stored = repository.getSetting<unknown>('updates.auto_check')
  return stored !== false && stored !== 'false'
}
