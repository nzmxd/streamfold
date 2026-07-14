import { ipcMain, nativeTheme, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import type { AppearanceState, ThemePreference } from '../shared/contracts'
import type { BrowserManager } from './browser-manager'
import type { BackupService } from './backup-service'
import type { SocialDatabase } from './database'
import type { ExportService } from './export-service'
import type { PluginHostService } from './plugins/plugin-host-service'
import type { PluginAutomationService } from './plugins/automation-service'
import type { PluginLifecycleService } from './plugins/plugin-lifecycle-service'
import type { PlatformAdapterRegistryService } from './plugins/platform-adapter-registry'
import type { PlatformSyncService } from './platform-sync-service'
import type { JobService } from './services/job-service'
import type { SyncBatchService } from './services/sync-batch-service'
import type { TaskQueryService } from './services/task-query-service'
import { isOfficialContentUrl, listPlatforms, registerManifestPlatforms } from './platforms'
import type { SettingsService } from './settings-service'
import type { UpdateService } from './update-service'
import { isTrustedShellUrl } from './shell-security'
import {
  parseAnalyticsQuery,
  parseBoolean,
  parseBulkUpdateAccounts,
  parseConfirmApiIdentity,
  parseEnqueueSyncBatch,
  parseCreatePluginSchedule,
  parseCreateEncryptedBackup,
  parseContentQuery,
  parseCreateAccount,
  parseCreateGroup,
  parseExportData,
  parseId,
  parseMoveGroup,
  parsePluginConfig,
  parsePluginGrant,
  parseRestoreEncryptedBackup,
  parseTaskQuery,
  parseUpdateContent,
  parseUpdateSettings,
  parseUpdateGroup,
  parseUpdateAccount
} from './validation'

export interface IpcServices {
  pluginHost: PluginHostService
  pluginLifecycle: PluginLifecycleService
  pluginAutomation: PluginAutomationService
  adapterRegistry: PlatformAdapterRegistryService
  settings: SettingsService
  exporter: ExportService
  backup: BackupService
  platformSync: PlatformSyncService
  jobs: JobService
  syncBatches: SyncBatchService
  tasks: TaskQueryService
  updates: UpdateService
}

let removeNativeThemeListener: (() => void) | null = null
let removeUpdateListener: (() => void) | null = null
let removeTaskListener: (() => void) | null = null

export function registerIpc(
  window: BrowserWindow,
  database: SocialDatabase,
  browser: BrowserManager,
  services: IpcServices
): void {
  const disconnectingAccounts = new Set<string>()
  let maintenance = false
  let maintenanceMessage = '本地数据库正在恢复，请稍候'
  let activeOperations = 0
  const idleWaiters = new Set<() => void>()
  const notifyAccountsChanged = (): void => {
    if (!window.isDestroyed()) window.webContents.send('accounts:changed')
  }
  const notifyContentChanged = (): void => {
    if (!window.isDestroyed()) window.webContents.send('content:changed')
  }
  const notifyTasksChanged = (): void => {
    if (!window.isDestroyed()) window.webContents.send('tasks:changed')
  }
  const runTracked = async <T>(handler: () => T | Promise<T>): Promise<T> => {
    if (maintenance) throw new Error(maintenanceMessage)
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
  const beginMaintenance = (message = '本地数据库正在恢复，请稍候'): Promise<void> => {
    if (maintenance) throw new Error(maintenanceMessage)
    maintenance = true
    maintenanceMessage = message
    if (activeOperations > 0) {
      return new Promise<void>((resolve) => idleWaiters.add(resolve))
    }
    return Promise.resolve()
  }
  const endMaintenance = (): void => {
    maintenance = false
    maintenanceMessage = '本地数据库正在恢复，请稍候'
  }
  const trusted = <T>(handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => T | Promise<T>) => {
    return async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<T> => {
      assertTrustedSender(window, event)
      return runTracked(() => handler(event, ...args))
    }
  }

  const broadcastAppearance = (): AppearanceState => {
    const state = currentAppearance()
    if (!window.isDestroyed()) {
      if (process.platform !== 'darwin') {
        window.setTitleBarOverlay({
          color: state.resolved === 'dark' ? '#141821' : '#ffffff',
          symbolColor: state.resolved === 'dark' ? '#f5f7fb' : '#171a24'
        })
      }
      window.webContents.send('appearance:changed', state)
    }
    browser.applyAppearance(state)
    return state
  }

  const onNativeThemeUpdated = (): void => { broadcastAppearance() }
  nativeTheme.on('updated', onNativeThemeUpdated)
  removeNativeThemeListener = () => nativeTheme.removeListener('updated', onNativeThemeUpdated)
  removeUpdateListener = services.updates.subscribe((state) => {
    if (!window.isDestroyed()) window.webContents.send('updates:changed', state)
  })
  const removeJobTaskListener = services.jobs.onChanged(() => {
    notifyTasksChanged()
    notifyAccountsChanged()
  })
  const removePluginTaskListener = services.pluginAutomation.onChanged(notifyTasksChanged)
  removeTaskListener = () => {
    removeJobTaskListener()
    removePluginTaskListener()
  }

  ipcMain.handle('appearance:get', trusted(() => currentAppearance()))
  ipcMain.handle('appearance:set', trusted((_event, value) => {
    const preference = parseThemePreference(value)
    database.setSetting('appearance.theme', preference)
    nativeTheme.themeSource = preference
    return broadcastAppearance()
  }))

  ipcMain.handle('platforms:list', trusted(() => listPlatforms()))
  ipcMain.handle('accounts:list', trusted(() => database.listAccounts()))
  ipcMain.handle('accounts:create', trusted((_event, value) => {
    const input = parseCreateAccount(value)
    if (!input.adapterContributionId) {
      const candidates = services.pluginHost.listContributions().filter((item) => (
        item.enabled && item.granted && !item.suspendedReason && item.contribution.kind === 'platform.adapter' &&
        item.contribution.platform.id === input.platformId
      ))
      if (candidates.length === 1) input.adapterContributionId = candidates[0]!.contribution.id
    }
    return database.createAccount(input)
  }))
  ipcMain.handle('accounts:update', trusted((_event, value) => database.updateAccount(parseUpdateAccount(value))))
  ipcMain.handle('accounts:bulk-update', trusted((_event, value) => (
    database.bulkUpdateAccounts(parseBulkUpdateAccounts(value))
  )))
  ipcMain.handle('accounts:disconnect', trusted(async (_event, value) => {
    const id = parseId(value)
    if (services.platformSync.isAccountActive(id)) throw new Error('账号正在同步或核验，请稍候')
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
    if (services.platformSync.isAccountActive(id)) throw new Error('账号正在同步或核验，请稍候')
    if (disconnectingAccounts.has(id)) throw new Error('账号正在处理')
    disconnectingAccounts.add(id)
    try {
      await browser.disconnect(id)
      database.disconnectAccount(id)
      await browser.purgeAccountMedia(id)
      database.removeAccount(id)
      notifyContentChanged()
    } finally {
      disconnectingAccounts.delete(id)
    }
  }))
  ipcMain.handle('accounts:verify-identity', trusted(async (_event, value) => {
    const id = parseId(value)
    if (disconnectingAccounts.has(id)) throw new Error('账号正在处理，请稍候')
    try {
      return await services.platformSync.verifyIdentity(id)
    } finally {
      notifyAccountsChanged()
    }
  }))
  ipcMain.handle('accounts:confirm-identity', trusted(async (_event, value) => {
    const input = parseConfirmApiIdentity(value)
    if (disconnectingAccounts.has(input.accountId)) throw new Error('账号正在处理，请稍候')
    try {
      return await services.platformSync.confirmIdentity(input)
    } finally {
      notifyAccountsChanged()
    }
  }))
  ipcMain.handle('accounts:sync', trusted(async (_event, value) => {
    const id = parseId(value)
    if (disconnectingAccounts.has(id)) throw new Error('账号正在处理，请稍候')
    if (database.listJobs().some((job) => job.accountId === id &&
      ['queued', 'validating', 'committing'].includes(job.status))) {
      throw new Error('该账号已有同步任务')
    }
    try {
      const result = await services.platformSync.sync(id)
      notifyContentChanged()
      return result
    } finally {
      notifyAccountsChanged()
    }
  }))
  ipcMain.handle('accounts:preview-sync-batch', trusted((_event, value) => (
    services.syncBatches.preview(parseEnqueueSyncBatch(value))
  )))
  ipcMain.handle('accounts:enqueue-sync-batch', trusted(async (_event, value) => {
    const result = await services.syncBatches.enqueue(parseEnqueueSyncBatch(value))
    notifyTasksChanged()
    notifyAccountsChanged()
    return result
  }))
  ipcMain.handle('accounts:list-adapters', trusted((_event, value) => (
    services.adapterRegistry.listForAccount(parseId(value))
  )))
  ipcMain.handle('accounts:switch-adapter', trusted(async (_event, accountId, contributionId) => {
    const account = await services.adapterRegistry.switchAdapter(parseId(accountId), parseId(contributionId))
    notifyAccountsChanged()
    return account
  }))
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
  ipcMain.handle('content:open-original', trusted(async (_event, value) => {
    const content = database.getContentDetail(parseId(value))
    if (!content.url || !isOfficialContentUrl(content.platformId, content.url, content.remoteId)) {
      throw new Error('该内容没有可用的官方原帖链接')
    }
    return browser.openAt(content.accountId, content.url)
  }))
  ipcMain.handle('content:update', trusted((_event, value) => {
    return database.updateContent(parseUpdateContent(value))
  }))
  ipcMain.handle('content:clear-account', trusted((_event, value) => {
    const result = database.clearAccountData(parseId(value))
    notifyContentChanged()
    return result
  }))
  ipcMain.handle('analytics:overview', trusted((_event, value) => database.getAnalytics(parseAnalyticsQuery(value))))
  ipcMain.handle('analytics:dashboard', trusted(() => database.getDashboard()))
  ipcMain.handle('tasks:summary', trusted((_event, value) => (
    services.tasks.summary(parseTaskQuery(value))
  )))
  ipcMain.handle('tasks:list', trusted((_event, value) => (
    services.tasks.list(parseTaskQuery(value))
  )))
  ipcMain.handle('tasks:get', trusted((_event, value) => services.tasks.get(parseId(value))))
  ipcMain.handle('tasks:list-batch', trusted((_event, value) => services.tasks.getBatch(parseId(value))))
  ipcMain.handle('tasks:list-batches', trusted(() => services.tasks.listBatches()))
  ipcMain.handle('tasks:cancel', trusted(async (_event, value) => {
    const id = parseId(value)
    const source = await services.tasks.getSource(id)
    if (!source) throw new Error('任务不存在')
    if (source.source !== 'job') throw new Error('该插件运行已开始，不能强制取消')
    await services.syncBatches.cancel(id)
    notifyTasksChanged()
    notifyAccountsChanged()
    const task = await services.tasks.get(id)
    if (!task) throw new Error('任务不存在')
    return task
  }))
  ipcMain.handle('tasks:retry', trusted(async (_event, value) => {
    const id = parseId(value)
    const source = await services.tasks.getSource(id)
    if (!source) throw new Error('任务不存在')
    let nextId = ''
    if (source.source === 'job') {
      const result = await services.syncBatches.retry(id)
      nextId = result.jobs[0]!.id
    } else {
      if (source.record.status !== 'failed' && source.record.status !== 'interrupted') {
        throw new Error('该运行记录不能重试')
      }
      const run = await services.pluginAutomation.runManual(
        source.record.pluginId,
        source.record.contributionId,
        source.record.accountId,
        source.record.attempt + 1
      )
      nextId = run.id
    }
    notifyTasksChanged()
    notifyAccountsChanged()
    const task = await services.tasks.get(nextId)
    if (!task) throw new Error('重试任务未创建')
    return task
  }))
  ipcMain.handle('plugins:packages', trusted(() => services.pluginHost.listPackages()))
  ipcMain.handle('plugins:contributions', trusted(() => services.pluginHost.listContributions()))
  ipcMain.handle('plugins:set-package-enabled', trusted((_event, id, enabled) => {
    const pluginId = parseId(id)
    const next = parseBoolean(enabled, '插件包开关')
    if (!next) services.pluginLifecycle.stop(pluginId)
    return services.pluginHost.setPackageEnabled(pluginId, next)
  }))
  ipcMain.handle('plugins:set-contribution-enabled', trusted((_event, pluginId, contributionId, enabled) => {
    const parsedPluginId = parseId(pluginId)
    const next = parseBoolean(enabled, '贡献点开关')
    if (!next) services.pluginLifecycle.stop(parsedPluginId)
    return services.pluginHost.setContributionEnabled(
      parsedPluginId,
      parseId(contributionId),
      next
    )
  }))
  ipcMain.handle('plugins:grant', trusted((_event, value) => (
    services.pluginHost.grant(parsePluginGrant(value))
  )))
  ipcMain.handle('plugins:get-config', trusted((_event, pluginId, contributionId) => (
    services.pluginHost.getConfig(parseId(pluginId), parseId(contributionId))
  )))
  ipcMain.handle('plugins:save-config', trusted((_event, value) => (
    services.pluginHost.saveConfig(parsePluginConfig(value))
  )))
  ipcMain.handle('plugins:schedules', trusted(() => services.pluginHost.listSchedules()))
  ipcMain.handle('plugins:create-schedule', trusted((_event, value) => (
    services.pluginHost.createSchedule(parseCreatePluginSchedule(value))
  )))
  ipcMain.handle('plugins:set-schedule-enabled', trusted((_event, id, enabled) => (
    services.pluginHost.updateSchedule(parseId(id), parseBoolean(enabled, '计划开关'))
  )))
  ipcMain.handle('plugins:remove-schedule', trusted((_event, id) => (
    services.pluginHost.removeSchedule(parseId(id))
  )))
  ipcMain.handle('plugins:runs', trusted(() => database.listPluginRuns()))
  ipcMain.handle('plugins:get-grant', trusted((_event, pluginId, contributionId) => (
    services.pluginHost.getGrant(parseId(pluginId), parseId(contributionId))
  )))
  ipcMain.handle('plugins:catalog', trusted(() => services.pluginLifecycle.getCatalog()))
  ipcMain.handle('plugins:refresh-catalog', trusted(async () => {
    const state = await services.pluginLifecycle.refreshCatalog()
    services.adapterRegistry.reconcile()
    return state
  }))
  ipcMain.handle('plugins:install-catalog', trusted(async (_event, pluginId) => {
    const installed = await services.pluginLifecycle.installFromCatalog(parseId(pluginId))
    registerNewManifestPlatforms(services.pluginHost)
    services.adapterRegistry.reconcile()
    return installed
  }))
  ipcMain.handle('plugins:install-development', trusted(async () => {
    const installed = await services.pluginLifecycle.installDevelopment()
    if (installed) {
      registerNewManifestPlatforms(services.pluginHost)
      services.adapterRegistry.reconcile()
    }
    return installed
  }))
  ipcMain.handle('plugins:update', trusted(async (_event, pluginId, confirmPermissionExpansion) => {
    const installed = await services.pluginLifecycle.update(
      parseId(pluginId),
      confirmPermissionExpansion === undefined
        ? false
        : parseBoolean(confirmPermissionExpansion, '更新权限确认')
    )
    registerNewManifestPlatforms(services.pluginHost)
    services.adapterRegistry.reconcile()
    return installed
  }))
  ipcMain.handle('plugins:uninstall', trusted(async (_event, pluginId) => {
    await services.pluginLifecycle.uninstall(parseId(pluginId))
    registerNewManifestPlatforms(services.pluginHost)
    services.adapterRegistry.reconcile()
  }))
  ipcMain.handle('plugins:get-developer-mode', trusted(() => services.pluginLifecycle.getDeveloperMode()))
  ipcMain.handle('plugins:set-developer-mode', trusted((_event, enabled) => (
    services.pluginLifecycle.setDeveloperMode(parseBoolean(enabled, '开发者模式'))
  )))
  ipcMain.handle('plugins:run', trusted((_event, pluginId, contributionId, accountId) => (
    services.pluginAutomation.runManual(
      parseId(pluginId),
      parseId(contributionId),
      accountId === undefined || accountId === null || accountId === '' ? null : parseId(accountId)
    )
  )))
  ipcMain.handle('plugins:retry-run', trusted((_event, value) => {
    const run = database.getPluginRun(parseId(value))
    if (!run || (run.status !== 'failed' && run.status !== 'interrupted')) throw new Error('该运行记录不能重试')
    return services.pluginAutomation.runManual(run.pluginId, run.contributionId, run.accountId, run.attempt + 1)
  }))
  ipcMain.handle('updates:get-state', trusted(() => services.updates.getState()))
  ipcMain.handle('updates:check', trusted(() => services.updates.check()))
  ipcMain.handle('updates:download', trusted(() => services.updates.download()))
  ipcMain.handle('updates:restart-and-install', async (event) => {
    assertTrustedSender(window, event)
    if (services.updates.getState().phase !== 'downloaded') throw new Error('更新尚未下载完成')
    const idle = beginMaintenance('应用正在准备安装更新，请稍候')
    try {
      services.syncBatches.stop()
      services.pluginAutomation.stop()
      await idle
      if (activeOperations > 0 || services.syncBatches.hasRunningTasks() ||
        services.pluginAutomation.hasRunningTasks()) {
        throw new Error('当前仍有任务正在运行，请稍候再安装更新')
      }
      services.updates.restartAndInstall()
    } catch (error) {
      endMaintenance()
      services.pluginAutomation.start()
      services.syncBatches.start()
      throw error
    }
  })
  ipcMain.handle('settings:overview', trusted(() => services.settings.overview()))
  ipcMain.handle('settings:update', trusted(async (_event, value) => {
    const input = parseUpdateSettings(value)
    const result = await services.settings.update(input)
    if (input.autoCheckUpdates !== undefined) {
      services.updates.setAutomaticChecks(input.autoCheckUpdates)
    }
    return result
  }))
  ipcMain.handle('settings:export', trusted(async (_event, value) => {
    const input = parseExportData(value)
    const result = await services.exporter.exportData(input)
    if (!result.cancelled) services.settings.markExportCompleted()
    return result
  }))
  ipcMain.handle('settings:backup-create', trusted((_event, value) => {
    if (services.syncBatches.hasRunningTasks() || services.pluginAutomation.hasRunningTasks()) {
      throw new Error('后台任务正在运行，请完成后再创建备份')
    }
    return services.backup.create(parseCreateEncryptedBackup(value))
  }))
  ipcMain.handle('settings:backup-restore', async (event, value) => {
    assertTrustedSender(window, event)
    const input = parseRestoreEncryptedBackup(value)
    if (maintenance) throw new Error(maintenanceMessage)
    if (services.syncBatches.hasRunningTasks() || services.pluginAutomation.hasRunningTasks()) {
      throw new Error('后台任务正在运行，请完成后再恢复备份')
    }
    services.syncBatches.stop()
    services.pluginAutomation.stop()
    try {
      await beginMaintenance()
      const result = await services.backup.restore(input)
      const restoredSettings = await services.settings.overview()
      services.updates.setAutomaticChecks(restoredSettings.autoCheckUpdates)
      notifyAccountsChanged()
      notifyContentChanged()
      return result
    } finally {
      endMaintenance()
      services.pluginAutomation.start()
      services.syncBatches.start()
    }
  })

  ipcMain.handle('browser-workspace:get-state', (event) => browser.getStateForSender(event))
  ipcMain.handle('browser-workspace:get-appearance', (event) => {
    browser.assertTrustedSender(event)
    return currentAppearance()
  })
  ipcMain.handle('browser-workspace:set-appearance', (event, value) => {
    browser.assertTrustedSender(event)
    if (maintenance) throw new Error(maintenanceMessage)
    const preference = parseThemePreference(value)
    database.setSetting('appearance.theme', preference)
    nativeTheme.themeSource = preference
    return broadcastAppearance()
  })
  ipcMain.handle('browser-workspace:back', (event) => browser.backForSender(event))
  ipcMain.handle('browser-workspace:forward', (event) => browser.forwardForSender(event))
  ipcMain.handle('browser-workspace:reload', (event) => browser.reloadForSender(event))
  ipcMain.handle('browser-workspace:home', (event) => browser.homeForSender(event))
  ipcMain.handle('browser-workspace:close', (event) => browser.closeForSender(event))
}

export function unregisterIpc(): void {
  removeNativeThemeListener?.()
  removeNativeThemeListener = null
  removeUpdateListener?.()
  removeUpdateListener = null
  removeTaskListener?.()
  removeTaskListener = null
  for (const channel of [
    'appearance:get',
    'appearance:set',
    'platforms:list',
    'accounts:list',
    'accounts:create',
    'accounts:update',
    'accounts:bulk-update',
    'accounts:disconnect',
    'accounts:purge',
    'accounts:verify-identity',
    'accounts:confirm-identity',
    'accounts:sync',
    'accounts:preview-sync-batch',
    'accounts:enqueue-sync-batch',
    'accounts:list-adapters',
    'accounts:switch-adapter',
    'groups:list',
    'groups:create',
    'groups:update',
    'groups:move',
    'groups:remove',
    'browser:open',
    'content:list',
    'content:detail',
    'content:open-original',
    'content:update',
    'content:clear-account',
    'analytics:overview',
    'analytics:dashboard',
    'tasks:summary',
    'tasks:list',
    'tasks:get',
    'tasks:cancel',
    'tasks:retry',
    'tasks:list-batch',
    'tasks:list-batches',
    'plugins:packages',
    'plugins:contributions',
    'plugins:set-package-enabled',
    'plugins:set-contribution-enabled',
    'plugins:grant',
    'plugins:get-config',
    'plugins:save-config',
    'plugins:schedules',
    'plugins:create-schedule',
    'plugins:set-schedule-enabled',
    'plugins:remove-schedule',
    'plugins:runs',
    'plugins:get-grant',
    'plugins:catalog',
    'plugins:refresh-catalog',
    'plugins:install-catalog',
    'plugins:install-development',
    'plugins:update',
    'plugins:uninstall',
    'plugins:get-developer-mode',
    'plugins:set-developer-mode',
    'plugins:run',
    'plugins:retry-run',
    'updates:get-state',
    'updates:check',
    'updates:download',
    'updates:restart-and-install',
    'settings:overview',
    'settings:update',
    'settings:export',
    'settings:backup-create',
    'settings:backup-restore',
    'browser-workspace:get-state',
    'browser-workspace:get-appearance',
    'browser-workspace:set-appearance',
    'browser-workspace:back',
    'browser-workspace:forward',
    'browser-workspace:reload',
    'browser-workspace:home',
    'browser-workspace:close'
  ]) ipcMain.removeHandler(channel)
}

function currentAppearance(): AppearanceState {
  return {
    preference: nativeTheme.themeSource,
    resolved: nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
  }
}

function parseThemePreference(value: unknown): ThemePreference {
  if (value === 'light' || value === 'dark' || value === 'system') return value
  throw new Error('主题设置无效')
}

function assertTrustedSender(window: BrowserWindow, event: IpcMainInvokeEvent): void {
  if (event.sender.id !== window.webContents.id) throw new Error('拒绝来自远程页面的请求')
  if (event.senderFrame !== window.webContents.mainFrame) throw new Error('拒绝来自子框架的请求')

  if (!isTrustedShellUrl(event.senderFrame.url)) throw new Error('管理界面来源无效')
}

function registerNewManifestPlatforms(host: PluginHostService): void {
  registerManifestPlatforms(host.extensionRegistry().platformDefinitions().map((platform) => ({
    id: platform.id,
    name: platform.name,
    shortName: platform.shortName,
    loginUrl: platform.loginUrl,
    homeUrl: platform.homeUrl,
    officialHosts: platform.navigationHosts,
    contentUrls: platform.contentUrls,
    riskNote: platform.riskNote
  })))
}
