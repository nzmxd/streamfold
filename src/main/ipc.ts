import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import type { BrowserManager } from './browser-manager'
import type { BackupService } from './backup-service'
import type { SocialDatabase } from './database'
import type { ExportService } from './export-service'
import type { PluginService } from './plugin-service'
import { listPlatforms } from './platforms'
import type { SettingsService } from './settings-service'
import type { ImportService } from './services/import-service'
import type { ManagedAdapterService } from './managed-adapter-service'
import type { JobService } from './services/job-service'
import { isTrustedShellUrl } from './shell-security'
import {
  parseAnalyticsQuery,
  parseBoolean,
  parseBulkUpdateAccounts,
  parseCommitFileImport,
  parseConfirmManagedIdentity,
  parseCreateEncryptedBackup,
  parseContentQuery,
  parseCreateAccount,
  parseCreateGroup,
  parseExportData,
  parseId,
  parseMoveGroup,
  parseRestoreEncryptedBackup,
  parseUpdateContent,
  parseUpdateSettings,
  parseUpdateGroup,
  parseUpdateAccount
} from './validation'

export interface IpcServices {
  imports: ImportService
  jobs: JobService
  plugins: PluginService
  settings: SettingsService
  exporter: ExportService
  backup: BackupService
  adapters: ManagedAdapterService
}

let removeJobListener: (() => void) | null = null

export function registerIpc(
  window: BrowserWindow,
  database: SocialDatabase,
  browser: BrowserManager,
  services: IpcServices
): void {
  const disconnectingAccounts = new Set<string>()
  let maintenance = false
  let activeOperations = 0
  const idleWaiters = new Set<() => void>()
  const runTracked = async <T>(handler: () => T | Promise<T>): Promise<T> => {
    if (maintenance) throw new Error('本地数据库正在恢复，请稍候')
    activeOperations += 1
    try {
      return await handler()
    } finally {
      activeOperations -= 1
      if (activeOperations === 0) {
        for (const resolve of idleWaiters) resolve()
        idleWaiters.clear()
      }
    }
  }
  const beginMaintenance = async (): Promise<void> => {
    if (maintenance) throw new Error('本地数据库正在恢复')
    maintenance = true
    if (activeOperations > 0) {
      await new Promise<void>((resolve) => idleWaiters.add(resolve))
    }
  }
  const trusted = <T>(handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => T | Promise<T>) => {
    return async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<T> => {
      assertTrustedSender(window, event)
      return runTracked(() => handler(event, ...args))
    }
  }

  ipcMain.handle('platforms:list', trusted(() => listPlatforms()))
  ipcMain.handle('accounts:list', trusted(() => database.listAccounts()))
  ipcMain.handle('accounts:create', trusted((_event, value) => database.createAccount(parseCreateAccount(value))))
  ipcMain.handle('accounts:update', trusted((_event, value) => database.updateAccount(parseUpdateAccount(value))))
  ipcMain.handle('accounts:bulk-update', trusted((_event, value) => (
    database.bulkUpdateAccounts(parseBulkUpdateAccounts(value))
  )))
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
  ipcMain.handle('accounts:verify-identity', trusted((_event, value) => (
    services.adapters.verifyIdentity(parseId(value))
  )))
  ipcMain.handle('accounts:confirm-identity', trusted((_event, value) => (
    services.adapters.confirmIdentity(parseConfirmManagedIdentity(value))
  )))
  ipcMain.handle('groups:list', trusted(() => database.listGroups()))
  ipcMain.handle('groups:create', trusted((_event, value) => database.createGroup(parseCreateGroup(value))))
  ipcMain.handle('groups:update', trusted((_event, value) => database.updateGroup(parseUpdateGroup(value))))
  ipcMain.handle('groups:move', trusted((_event, value) => database.moveGroup(parseMoveGroup(value))))
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
  ipcMain.handle('settings:backup-create', trusted((_event, value) => (
    services.backup.create(parseCreateEncryptedBackup(value))
  )))
  ipcMain.handle('settings:backup-restore', async (event, value) => {
    assertTrustedSender(window, event)
    const input = parseRestoreEncryptedBackup(value)
    await beginMaintenance()
    try {
      return await services.backup.restore(input)
    } finally {
      maintenance = false
    }
  })

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
  ipcMain.handle('browser-workspace:verify-identity', (event) => runTracked(() => {
    const state = browser.getStateForSender(event)
    if (!state.accountId) throw new Error('浏览器窗口未绑定账号')
    return services.adapters.verifyIdentity(state.accountId)
  }))
  ipcMain.handle('browser-workspace:confirm-identity', (event, value) => runTracked(() => {
    const state = browser.getStateForSender(event)
    const input = parseConfirmManagedIdentity(value)
    if (!state.accountId || input.accountId !== state.accountId) throw new Error('身份确认与浏览器账号不匹配')
    return services.adapters.confirmIdentity(input)
  }))
}

export function unregisterIpc(): void {
  removeJobListener?.()
  removeJobListener = null
  for (const channel of [
    'platforms:list',
    'accounts:list',
    'accounts:create',
    'accounts:update',
    'accounts:bulk-update',
    'accounts:disconnect',
    'accounts:purge',
    'accounts:verify-identity',
    'accounts:confirm-identity',
    'groups:list',
    'groups:create',
    'groups:update',
    'groups:move',
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
    'settings:backup-create',
    'settings:backup-restore',
    'browser-workspace:get-state',
    'browser-workspace:back',
    'browser-workspace:forward',
    'browser-workspace:reload',
    'browser-workspace:home',
    'browser-workspace:close',
    'browser-workspace:verify-identity',
    'browser-workspace:confirm-identity'
  ]) ipcMain.removeHandler(channel)
}

function assertTrustedSender(window: BrowserWindow, event: IpcMainInvokeEvent): void {
  if (event.sender.id !== window.webContents.id) throw new Error('拒绝来自远程页面的请求')
  if (event.senderFrame !== window.webContents.mainFrame) throw new Error('拒绝来自子框架的请求')

  if (!isTrustedShellUrl(event.senderFrame.url)) throw new Error('管理界面来源无效')
}
