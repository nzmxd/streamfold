import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import type { BrowserManager } from './browser-manager'
import type { SocialDatabase } from './database'
import type { ExportService } from './export-service'
import type { PluginService } from './plugin-service'
import { listPlatforms } from './platforms'
import type { SettingsService } from './settings-service'
import type { ImportService } from './services/import-service'
import type { JobService } from './services/job-service'
import { isTrustedShellUrl } from './shell-security'
import {
  parseAnalyticsQuery,
  parseBoolean,
  parseCommitFileImport,
  parseContentQuery,
  parseCreateAccount,
  parseCreateGroup,
  parseExportData,
  parseId,
  parseUpdateContent,
  parseUpdateSettings,
  parseUpdateAccount
} from './validation'

export interface IpcServices {
  imports: ImportService
  jobs: JobService
  plugins: PluginService
  settings: SettingsService
  exporter: ExportService
}

let removeJobListener: (() => void) | null = null

export function registerIpc(
  window: BrowserWindow,
  database: SocialDatabase,
  browser: BrowserManager,
  services: IpcServices
): void {
  const disconnectingAccounts = new Set<string>()
  const trusted = <T>(handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => T | Promise<T>) => {
    return (event: IpcMainInvokeEvent, ...args: unknown[]): T | Promise<T> => {
      assertTrustedSender(window, event)
      return handler(event, ...args)
    }
  }

  ipcMain.handle('platforms:list', trusted(() => listPlatforms()))
  ipcMain.handle('accounts:list', trusted(() => database.listAccounts()))
  ipcMain.handle('accounts:create', trusted((_event, value) => database.createAccount(parseCreateAccount(value))))
  ipcMain.handle('accounts:update', trusted((_event, value) => database.updateAccount(parseUpdateAccount(value))))
  ipcMain.handle('accounts:disconnect', trusted(async (_event, value) => {
    const id = parseId(value)
    if (disconnectingAccounts.has(id)) throw new Error('账号正在断开')
    disconnectingAccounts.add(id)
    try {
      await browser.disconnect(id)
      database.disconnectAccount(id)
    } finally {
      disconnectingAccounts.delete(id)
    }
  }))
  ipcMain.handle('accounts:purge', trusted(async (_event, value) => {
    const id = parseId(value)
    if (disconnectingAccounts.has(id)) throw new Error('账号正在处理')
    disconnectingAccounts.add(id)
    try {
      await browser.disconnect(id)
      database.removeAccount(id)
    } finally {
      disconnectingAccounts.delete(id)
    }
  }))
  ipcMain.handle('groups:list', trusted(() => database.listGroups()))
  ipcMain.handle('groups:create', trusted((_event, value) => database.createGroup(parseCreateGroup(value))))
  ipcMain.handle('groups:remove', trusted((_event, value) => database.removeGroup(parseId(value))))
  ipcMain.handle('browser:open', trusted(async (_event, accountId) => {
    const id = parseId(accountId)
    if (disconnectingAccounts.has(id)) throw new Error('账号正在断开，请稍候')
    const state = await browser.open(id)
    database.beginReconnect(id)
    return state
  }))

  ipcMain.handle('content:list', trusted((_event, value) => database.listContents(parseContentQuery(value))))
  ipcMain.handle('content:detail', trusted((_event, value) => database.getContentDetail(parseId(value))))
  ipcMain.handle('content:update', trusted((_event, value) => database.updateContent(parseUpdateContent(value))))
  ipcMain.handle('content:clear-account', trusted((_event, value) => database.clearAccountData(parseId(value))))
  ipcMain.handle('analytics:overview', trusted((_event, value) => database.getAnalytics(parseAnalyticsQuery(value))))
  ipcMain.handle('analytics:dashboard', trusted(() => database.getDashboard()))
  ipcMain.handle('plugins:list', trusted(() => services.plugins.list()))
  ipcMain.handle('plugins:set-enabled', trusted((_event, id, enabled) => (
    services.plugins.setEnabled(parseId(id), parseBoolean(enabled, '插件开关'))
  )))
  ipcMain.handle('imports:preview', trusted((_event, accountId) => services.imports.preview(parseId(accountId))))
  ipcMain.handle('imports:commit', trusted((_event, value) => services.imports.commit(parseCommitFileImport(value))))
  ipcMain.handle('jobs:list', trusted(() => services.jobs.list()))
  ipcMain.handle('jobs:cancel', trusted((_event, id) => services.jobs.cancel(parseId(id))))
  ipcMain.handle('settings:overview', trusted(() => services.settings.overview()))
  ipcMain.handle('settings:update', trusted((_event, value) => services.settings.update(parseUpdateSettings(value))))
  ipcMain.handle('settings:export', trusted(async (_event, value) => {
    const input = parseExportData(value)
    const result = await services.exporter.exportData(input)
    if (!result.cancelled) services.settings.markExportCompleted()
    return result
  }))

  removeJobListener?.()
  removeJobListener = services.jobs.onChanged((job) => {
    if (!window.isDestroyed()) window.webContents.send('jobs:changed', job)
  })

  ipcMain.handle('browser-workspace:get-state', (event) => browser.getStateForSender(event))
  ipcMain.handle('browser-workspace:back', (event) => browser.backForSender(event))
  ipcMain.handle('browser-workspace:forward', (event) => browser.forwardForSender(event))
  ipcMain.handle('browser-workspace:reload', (event) => browser.reloadForSender(event))
  ipcMain.handle('browser-workspace:home', (event) => browser.homeForSender(event))
  ipcMain.handle('browser-workspace:close', (event) => browser.closeForSender(event))
}

export function unregisterIpc(): void {
  removeJobListener?.()
  removeJobListener = null
  for (const channel of [
    'platforms:list',
    'accounts:list',
    'accounts:create',
    'accounts:update',
    'accounts:disconnect',
    'accounts:purge',
    'groups:list',
    'groups:create',
    'groups:remove',
    'browser:open',
    'content:list',
    'content:detail',
    'content:update',
    'content:clear-account',
    'analytics:overview',
    'analytics:dashboard',
    'plugins:list',
    'plugins:set-enabled',
    'imports:preview',
    'imports:commit',
    'jobs:list',
    'jobs:cancel',
    'settings:overview',
    'settings:update',
    'settings:export',
    'browser-workspace:get-state',
    'browser-workspace:back',
    'browser-workspace:forward',
    'browser-workspace:reload',
    'browser-workspace:home',
    'browser-workspace:close'
  ]) ipcMain.removeHandler(channel)
}

function assertTrustedSender(window: BrowserWindow, event: IpcMainInvokeEvent): void {
  if (event.sender.id !== window.webContents.id) throw new Error('拒绝来自远程页面的请求')
  if (event.senderFrame !== window.webContents.mainFrame) throw new Error('拒绝来自子框架的请求')

  if (!isTrustedShellUrl(event.senderFrame.url)) throw new Error('管理界面来源无效')
}
