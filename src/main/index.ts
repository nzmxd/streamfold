import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { readFileSync, writeFileSync } from 'node:fs'
import {
  app,
  BrowserWindow,
  dialog,
  net,
  protocol,
  session
} from 'electron'
import { BrowserManager } from './browser-manager'
import { BackupService } from './backup-service'
import { SocialDatabase } from './database'
import { ExportService } from './export-service'
import { registerIpc, unregisterIpc } from './ipc'
import { PluginService } from './plugin-service'
import { SettingsService } from './settings-service'
import { JobService } from './services/job-service'
import { XiaohongshuApiService } from './xiaohongshu-api-service'
import { isTrustedShellUrl } from './shell-security'

const currentDir = dirname(fileURLToPath(import.meta.url))
const smokeMode = process.env.SOCIAL_VAULT_SMOKE === '1'
const reviewMode = process.env.SOCIAL_VAULT_REVIEW === '1'
if (smokeMode) app.disableHardwareAcceleration()
if (smokeMode || reviewMode) {
  app.setPath('userData', join(tmpdir(), `social-vault-${smokeMode ? 'smoke' : 'review'}-${process.pid}`))
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
let smokeVisualAccountId: string | null = null

app.on('second-instance', () => {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.focus()
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
  await registerShellProtocol()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  browserManager?.destroy()
  browserManager = null
  unregisterIpc()
  database?.close()
  database = null
})

function createWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed()) return

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 920,
    minHeight: 640,
    title: 'Social Vault',
    backgroundColor: '#f7f8fa',
    show: false,
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

  mainWindow.removeMenu()
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

  database = new SocialDatabase(join(app.getPath('userData'), 'social-vault.sqlite'))
  database.recoverInterruptedJobs()
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
    !smokeMode
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
      xiaohongshuApiService.invalidatePreviews()
    },
    afterRestore: () => pluginService.initialize(),
    afterCommit: async () => {
      try {
        const restoredPartitions = database!.listAccounts().map((account) => account.sessionPartition)
        await browserManager?.clearPartitions([...restorePartitions, ...restoredPartitions])
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
    xiaohongshuApi: xiaohongshuApiService
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
          v04ApiReady: typeof window.socialVault.accounts.verifyIdentity === 'function' &&
            typeof window.socialVault.accounts.confirmIdentity === 'function' &&
            typeof window.socialVault.accounts.sync === 'function' &&
            typeof window.socialVault.accounts.bulkUpdate === 'function' &&
            typeof window.socialVault.groups.update === 'function' &&
            typeof window.socialVault.settings.createBackup === 'function' &&
            typeof window.socialVault.settings.restoreBackup === 'function',
          text: document.body.innerText.slice(0, 80)
        }
      })()`)
      let workspaceResult: unknown = null
      let partitionIsolation = false
      if (database && browserManager) {
        const first = database.createAccount({ platformId: 'xiaohongshu', alias: 'Smoke A', syncMode: 'disabled' })
        const second = database.createAccount({ platformId: 'xiaohongshu', alias: 'Smoke B', syncMode: 'disabled' })
        workspaceResult = await browserManager.smokeWorkspace(first.id)
        partitionIsolation = await verifyPartitionIsolation(first.sessionPartition, second.sessionPartition)
        await browserManager.disconnect(first.id)
        await browserManager.disconnect(second.id)
        database.removeAccount(first.id)
        database.removeAccount(second.id)
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
        smokeVisualAccountId = null
      }
      const smokePayload = {
        shell: shellResult,
        workspace: workspaceResult,
        partitionIsolation,
        capturePath: capturePath ?? null
      }
      const shell = shellResult as {
        hasApi?: boolean
        hasApp?: boolean
        dashboardReady?: boolean
        settingsReady?: boolean
        v04ApiReady?: boolean
      } | null
      const workspace = workspaceResult as {
        hasApi?: boolean
        accountId?: string
      } | null
      if (
        !shell?.hasApi || !shell.hasApp || !shell.dashboardReady || !shell.settingsReady || !shell.v04ApiReady ||
        !workspace?.hasApi || !workspace.accountId || !partitionIsolation
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

async function registerShellProtocol(): Promise<void> {
  const rendererRoot = resolve(currentDir, '../renderer')
  await protocol.handle('app', (request) => {
    const url = new URL(request.url)
    if (!['shell', 'browser'].includes(url.hostname)) return new Response('Not found', { status: 404 })

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
