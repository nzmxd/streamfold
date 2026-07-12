import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { writeFileSync } from 'node:fs'
import {
  app,
  BrowserWindow,
  net,
  protocol,
  session
} from 'electron'
import { BrowserManager } from './browser-manager'
import { SocialDatabase } from './database'
import { registerIpc, unregisterIpc } from './ipc'
import { isTrustedShellUrl } from './shell-security'

const currentDir = dirname(fileURLToPath(import.meta.url))
const smokeMode = process.env.SOCIAL_VAULT_SMOKE === '1'
const reviewMode = process.env.SOCIAL_VAULT_REVIEW === '1'
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
  registerIpc(mainWindow, database, browserManager)

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
        return {
          title: document.title,
          hasApi,
          hasApp: Boolean(document.querySelector('#app')),
          platformCount: platforms.length,
          accountCount: accounts.length,
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
        await mainWindow.webContents.executeJavaScript(
          'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))'
        )
        writeFileSync(capturePath, (await mainWindow.webContents.capturePage()).toPNG())
      }
      if (smokeVisualAccountId && database) {
        database.removeAccount(smokeVisualAccountId)
        smokeVisualAccountId = null
      }
      console.log(`SOCIAL_VAULT_SMOKE_OK ${JSON.stringify({ shell: shellResult, workspace: workspaceResult, partitionIsolation, capturePath: capturePath ?? null })}`)
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
