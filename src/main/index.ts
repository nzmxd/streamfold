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
import { BackupService } from './backup-service'
import { SocialDatabase } from './database'
import { ExportService } from './export-service'
import { loadApplicationIcon, loadTrayIcon } from './icon-assets'
import { registerIpc, unregisterIpc } from './ipc'
import { PluginService } from './plugin-service'
import { PlatformSyncService } from './platform-sync-service'
import { ProfileMediaStore } from './profile-media'
import { SettingsService } from './settings-service'
import { JobService } from './services/job-service'
import { XiaohongshuApiService } from './xiaohongshu-api-service'
import { ZhihuApiService } from './zhihu-api-service'
import { isTrustedShellUrl } from './shell-security'
import { ElectronUpdateClient } from './electron-update-client'
import { UpdateService } from './update-service'

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
let removeTrayUpdateListener: (() => void) | null = null
let trayMenuSignature = ''

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

app.whenReady().then(async () => {
  applicationIcon = loadApplicationIcon()
  profileMediaStore = new ProfileMediaStore(join(app.getPath('userData'), 'profile-media'))
  await registerShellProtocol(profileMediaStore)
  updateService = createUpdateService()
  removeTrayUpdateListener = updateService.subscribe(refreshTrayMenu)
  createWindow()
  updateService.start()
  if (!smokeMode) createTray()
  nativeTheme.on('updated', updateTrayIcon)

  app.on('activate', () => {
    showMainWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  nativeTheme.off('updated', updateTrayIcon)
  tray?.destroy()
  tray = null
  removeTrayUpdateListener?.()
  removeTrayUpdateListener = null
  updateService?.destroy()
  updateService = null
  browserManager?.destroy()
  browserManager = null
  unregisterIpc()
  database?.close()
  database = null
})

function showMainWindow(): void {
  if (!app.isReady()) return
  if (!mainWindow || mainWindow.isDestroyed()) {
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
  if (!tray || !updateService) return
  const state = updateService.getState()
  const signature = `${state.phase}:${state.availableVersion ?? ''}:${state.unsupportedReason ?? ''}`
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

function updateTrayIcon(): void {
  if (!tray) return
  const icon = loadTrayIcon()
  if (icon) tray.setImage(icon)
}

function createWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed()) return
  if (!profileMediaStore) throw new Error('头像媒体缓存尚未初始化')
  if (!updateService) throw new Error('更新服务尚未初始化')

  database = new SocialDatabase(join(app.getPath('userData'), 'social-vault.sqlite'))
  updateService.setAutomaticChecks(readAutomaticUpdatePreference(database))
  database.recoverInterruptedJobs()
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
    minWidth: 920,
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
  const pluginService = new PluginService(database)
  pluginService.initialize()
  const jobService = new JobService(database)
  const xiaohongshuApiService = new XiaohongshuApiService({
    repository: database,
    browser: browserManager,
    plugins: pluginService,
    jobs: jobService
  })
  const zhihuApiService = new ZhihuApiService({
    repository: database,
    browser: browserManager,
    plugins: pluginService,
    jobs: jobService
  })
  const platformSyncService = new PlatformSyncService({
    repository: database,
    adapters: {
      xiaohongshu: xiaohongshuApiService,
      zhihu: zhihuApiService
    }
  })
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
    beforeRestore: () => {
      restorePartitions = database!.listAccounts().map((account) => account.sessionPartition)
      browserManager?.closeAll()
      platformSyncService.invalidatePreviews()
    },
    afterRestore: () => pluginService.initialize(),
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
    plugins: pluginService,
    settings: settingsService,
    exporter: exportService,
    backup: backupService,
    platformSync: platformSyncService,
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
        const plugins = hasApi ? await window.socialVault.plugins.list() : []
        const contents = hasApi ? await window.socialVault.content.list() : []
        const dashboard = hasApi ? await window.socialVault.analytics.dashboard() : null
        const settings = hasApi ? await window.socialVault.settings.overview() : null
        const appearance = hasApi ? await window.socialVault.appearance.get() : null
        const updates = hasApi ? await window.socialVault.updates.getState() : null
        return {
          title: document.title,
          hasApi,
          hasApp: Boolean(document.querySelector('#app')),
          platformCount: platforms.length,
          accountCount: accounts.length,
          pluginCount: plugins.length,
          contentCount: contents.length,
          jobCount: 0,
          dashboardReady: Boolean(dashboard),
          settingsReady: Boolean(settings?.appVersion),
          appearanceReady: appearance?.resolved === 'light' || appearance?.resolved === 'dark',
          updatesReady: Boolean(updates?.currentVersion) && typeof window.socialVault.updates.check === 'function',
          v04ApiReady: typeof window.socialVault.accounts.verifyIdentity === 'function' &&
            typeof window.socialVault.accounts.confirmIdentity === 'function' &&
            typeof window.socialVault.accounts.sync === 'function' &&
            typeof window.socialVault.accounts.bulkUpdate === 'function' &&
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
        v04ApiReady?: boolean
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
      if (
        !shell?.hasApi || !shell.hasApp || !shell.dashboardReady || !shell.settingsReady ||
        !shell.appearanceReady || !shell.updatesReady || !shell.v04ApiReady ||
        !workspace?.hasApi || !workspace.accountId || !workspace.appearanceReady ||
        !zhihuWorkspace?.hasApi || !zhihuWorkspace.accountId ||
        !zhihuWorkspace.remoteUserAgent?.includes(`Chrome/${process.versions.chrome}`) ||
        zhihuWorkspace.remoteUserAgent.includes('Electron/') ||
        zhihuWorkspace.remoteUserAgent.includes(`${app.getName()}/`) || !partitionIsolation ||
        !iconResult.applicationReady || !iconResult.trayReady || !iconResult.nativeTrayReady
      ) {
        console.error(`SOCIAL_VAULT_SMOKE_FAILED ${JSON.stringify(smokePayload)}`)
        app.exit(1)
        return
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
    unregisterIpc()
    database?.close()
    database = null
    mainWindow = null
  })
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
  if (!existsSync(join(process.resourcesPath, 'app-update.yml'))) return 'missing-source'
  if (process.platform === 'linux' && !process.env.APPIMAGE) return 'unsupported-package'
  return null
}

function readAutomaticUpdatePreference(repository: SocialDatabase): boolean {
  const stored = repository.getSetting<unknown>('updates.auto_check')
  return stored !== false && stored !== 'false'
}
