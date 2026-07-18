import { dialog, ipcMain, nativeTheme, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { DEFAULT_THEME_COLOR, type AppearanceState, type ThemePreference } from '../shared/contracts'
import type { BrowserManager } from './browser-manager'
import type { BackupService } from './backup-service'
import type { AppLogService } from './app-log-service'
import type { SocialDatabase } from './database'
import type { ExportService } from './export-service'
import { wasErrorReported } from './error-reporting'
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
  parseAccountMetricQuery,
  parseAppLogQuery,
  parseRendererErrorLog,
  parseAnalyticsComparisonQuery,
  parseAnalyticsQuery,
  parseAnalyticsSummaryQuery,
  parseBoolean,
  parseBulkUpdateAccounts,
  parseConfirmApiIdentity,
  parseEnqueueSyncBatch,
  parseCreatePluginSchedule,
  parseCreateEncryptedBackup,
  parseContentQuery,
  parseContentLifecycleQuery,
  parseContentSearchQuery,
  parseContentTagFacetQuery,
  parseBulkUpdateContents,
  parseCreateAccount,
  parseCreateGroup,
  parseExportData,
  parseExportFilteredContents,
  parseId,
  parseMarkTaskHandled,
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
  logs: AppLogService
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
let removeLogListener: (() => void) | null = null
let removePluginCaptureListener: (() => void) | null = null

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
  let themeColor = storedThemeColor(database)
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
  const discoveryStates = new Map<string, {
    latestSequence: number
    processedSequence: number
    lastActivitySequence: number
    running: boolean
    bootstrapped: boolean
    lastTrigger: 'navigation' | 'capture'
    retryAttempt: number
    busyRetryAttempt: number
    lastErrorSignature: string
    retryTimer: ReturnType<typeof setTimeout> | null
  }>()
  const captureHealthStates = new Map<string, string>()
  const backgroundDiscoveryTasks = new Set<Promise<void>>()
  let backgroundDiscoveryPaused = false
  let removeBackgroundBootstrapListener: (() => void) | null = null
  const clearBackgroundCaptureState = (accountId: string, preserveResume = false): void => {
    const discovery = discoveryStates.get(accountId)
    if (discovery?.retryTimer) clearTimeout(discovery.retryTimer)
    browser.stopPluginCapture(accountId, preserveResume)
    discoveryStates.delete(accountId)
    captureHealthStates.delete(accountId)
  }
  const declaredBackgroundAdapterForAccount = (accountId: string) => {
    const account = database.getAccount(accountId)
    if (!account?.adapterContributionId) return null
    const state = services.pluginHost.listContributions().find((item) => (
      item.contribution.kind === 'platform.adapter' &&
      item.contribution.id === account.adapterContributionId &&
      item.contribution.platform.id === account.platformId
    ))
    if (!state || state.contribution.kind !== 'platform.adapter' ||
      !state.contribution.backgroundCapture) return null
    return { account, state, background: state.contribution.backgroundCapture }
  }
  const backgroundAdapterForAccount = (accountId: string) => {
    const declared = declaredBackgroundAdapterForAccount(accountId)
    if (!declared || declared.account.connectionStatus === 'disconnected' ||
      !declared.state.enabled || !declared.state.granted ||
      declared.state.suspendedReason) return null
    const { account, state } = declared
    const grant = services.pluginHost.getGrant(state.pluginId, state.contribution.id)
    const accountAllowed = Boolean(grant?.permissions.includes('platform.session-json') && (
      grant.accountIds.includes(account.id) ||
      (account.groupIds ?? []).some((groupId) => grant.groupIds.includes(groupId))
    ))
    if (!accountAllowed) return null
    return declared
  }
  const shouldPreserveBackgroundResume = (accountId: string): boolean => {
    const declared = declaredBackgroundAdapterForAccount(accountId)
    return Boolean(declared && !declared.account.remoteId && declared.background.identityDiscovery)
  }
  const deferIdentityDiscovery = (accountId: string, delayMs: number): void => {
    const state = discoveryStates.get(accountId)
    if (!state || state.retryTimer) return
    state.latestSequence += 1
    state.retryTimer = setTimeout(() => {
      state.retryTimer = null
      runIdentityDiscovery(accountId)
    }, Math.max(1_000, delayMs))
    state.retryTimer.unref?.()
  }
  const runIdentityDiscovery = (accountId: string): void => {
    if (backgroundDiscoveryPaused) return
    const state = discoveryStates.get(accountId)
    if (!state || state.running) return
    if (state.retryTimer) {
      clearTimeout(state.retryTimer)
      state.retryTimer = null
    }
    state.running = true
    let deferred = false
    const task = (async () => {
      try {
        while (state.processedSequence < state.latestSequence) {
          const sequence = state.latestSequence
          const trigger = state.lastTrigger
          const resolved = backgroundAdapterForAccount(accountId)
          if (!resolved || resolved.account.remoteId || !resolved.background.identityDiscovery) {
            clearBackgroundCaptureState(accountId, shouldPreserveBackgroundResume(accountId))
            return
          }
          if (services.platformSync.isAccountActive(accountId)) {
            state.busyRetryAttempt += 1
            const initialDelay = resolved.background.retryIntervalSeconds * 1_000
            const maximumDelay = resolved.background.maximumRetryIntervalSeconds * 1_000
            const delay = Math.min(
              maximumDelay,
              initialDelay * (2 ** Math.min(state.busyRetryAttempt - 1, 20))
            )
            deferred = true
            deferIdentityDiscovery(accountId, delay)
            return
          }
          state.busyRetryAttempt = 0
          if (trigger === 'navigation') state.bootstrapped = true
          state.processedSequence = sequence
          try {
            const result = await services.platformSync.discoverIdentity(accountId)
            state.retryAttempt = 0
            state.lastErrorSignature = ''
            if (result.status !== 'confirmation_required' || !result.confirmationToken ||
                !result.remoteId || !result.remoteName) continue
            const current = backgroundAdapterForAccount(accountId)
            if (discoveryStates.get(accountId) !== state || !current || current.account.remoteId ||
              current.state.pluginId !== resolved.state.pluginId ||
              current.state.contribution.id !== resolved.state.contribution.id) return
            if (!window.isDestroyed()) window.webContents.send('accounts:identity-preview', result)
          } catch (error) {
            const current = backgroundAdapterForAccount(accountId)
            if (discoveryStates.get(accountId) !== state || !current || current.account.remoteId ||
              current.state.pluginId !== resolved.state.pluginId ||
              current.state.contribution.id !== resolved.state.contribution.id) return
            const signature = identityDiscoveryErrorSignature(error)
            if (signature !== state.lastErrorSignature) {
              state.lastErrorSignature = signature
              services.logs.captureError('sync', error, {
                accountId,
                pluginId: current.state.pluginId,
                contributionId: current.state.contribution.id,
                stage: '后台身份发现'
              })
            }
            state.bootstrapped = false
            if (trigger === 'navigation') {
              state.retryAttempt += 1
              const initialDelay = current.background.retryIntervalSeconds * 1_000
              const maximumDelay = current.background.maximumRetryIntervalSeconds * 1_000
              const delay = Math.min(
                maximumDelay,
                initialDelay * (2 ** Math.min(state.retryAttempt - 1, 20))
              )
              deferred = true
              deferIdentityDiscovery(accountId, delay)
            }
            return
          }
        }
      } finally {
        state.running = false
        if (!deferred && discoveryStates.get(accountId) === state &&
          state.processedSequence < state.latestSequence) runIdentityDiscovery(accountId)
      }
    })()
    backgroundDiscoveryTasks.add(task)
    void task.then(
      () => backgroundDiscoveryTasks.delete(task),
      (error) => {
        backgroundDiscoveryTasks.delete(task)
        services.logs.captureError('sync', error, {
          accountId,
          stage: '后台身份发现调度'
        })
      }
    )
  }
  removePluginCaptureListener?.()
  const removeCaptureActivityListener = browser.onPluginCaptureActivity((activity) => {
    if (activity.reason === 'health' && activity.health) {
      if (activity.health.status === 'stopped') {
        const discovery = discoveryStates.get(activity.accountId)
        if (discovery?.retryTimer) clearTimeout(discovery.retryTimer)
        discoveryStates.delete(activity.accountId)
        captureHealthStates.delete(activity.accountId)
        return
      }
      const previous = captureHealthStates.get(activity.accountId)
      const previousStatus = previous?.split(':', 1)[0]
      const signature = `${activity.health.status}:${activity.health.lastError}:${captureErrorSignature(activity.error)}`
      captureHealthStates.set(activity.accountId, signature)
      if (previous !== signature) {
        const context = {
          accountId: activity.accountId,
          pluginId: activity.pluginId,
          contributionId: activity.contributionId,
          status: activity.health.status,
          retryAttempt: activity.health.retryAttempt,
          nextRetryAt: activity.health.nextRetryAt
        }
        if (activity.health.status === 'degraded' || activity.health.status === 'retrying') {
          if (activity.error) {
            services.logs.captureError('plugin', activity.error, {
              ...context,
              stage: '平台后台监听'
            })
          } else {
            services.logs.warn(
              'plugin',
              activity.health.lastError || '平台后台监听正在自动重连',
              { context }
            )
          }
        } else if (activity.health.status === 'listening' &&
            (previousStatus === 'degraded' || previousStatus === 'retrying')) {
          services.logs.info('plugin', '平台后台监听已恢复', { context })
        }
      }
      return
    }
    const resolved = backgroundAdapterForAccount(activity.accountId)
    const discovery = resolved?.background.identityDiscovery
    if (!resolved || resolved.account.remoteId || !discovery) {
      clearBackgroundCaptureState(
        activity.accountId,
        shouldPreserveBackgroundResume(activity.accountId)
      )
      return
    }
    if ((activity.pluginId && activity.pluginId !== resolved.state.pluginId) ||
      (activity.contributionId && activity.contributionId !== resolved.state.contribution.id)) {
      clearBackgroundCaptureState(activity.accountId)
      return
    }
    const state = discoveryStates.get(activity.accountId) ?? {
      latestSequence: 0,
      processedSequence: 0,
      lastActivitySequence: 0,
      running: false,
      bootstrapped: false,
      lastTrigger: 'navigation',
      retryAttempt: 0,
      busyRetryAttempt: 0,
      lastErrorSignature: '',
      retryTimer: null
    }
    if (activity.sequence <= state.lastActivitySequence) return
    state.lastActivitySequence = activity.sequence
    const bootstrap = activity.reason === 'navigation' && !state.bootstrapped
    if (bootstrap) state.bootstrapped = true
    const shouldDiscover = activity.reason === 'capture'
      ? Boolean(activity.captureId && discovery.captureIds.includes(activity.captureId))
      : activity.reason === 'navigation' &&
        (bootstrap || discovery.strategy === 'on-navigation-and-capture')
    if (!shouldDiscover) return
    state.lastTrigger = activity.reason === 'capture' ? 'capture' : 'navigation'
    state.retryAttempt = 0
    state.busyRetryAttempt = 0
    state.latestSequence += 1
    discoveryStates.set(activity.accountId, state)
    runIdentityDiscovery(activity.accountId)
  })
  removePluginCaptureListener = () => {
    removeBackgroundBootstrapListener?.()
    removeBackgroundBootstrapListener = null
    removeCaptureActivityListener()
    for (const state of discoveryStates.values()) {
      if (state.retryTimer) clearTimeout(state.retryTimer)
    }
    discoveryStates.clear()
    captureHealthStates.clear()
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
  const stopCapturesForPlugin = (pluginId: string, preserveResume = false): void => {
    const contributionIds = new Set(services.pluginHost.listContributions()
      .filter((item) => item.pluginId === pluginId && item.contribution.kind === 'platform.adapter')
      .map((item) => item.contribution.id))
    if (contributionIds.size === 0) return
    for (const account of database.listAccounts()) {
      if (account.adapterContributionId && contributionIds.has(account.adapterContributionId)) {
        clearBackgroundCaptureState(account.id, preserveResume)
      }
    }
  }
  const reconcileBackgroundCaptureAccounts = (accountIds?: readonly string[]): void => {
    const selected = accountIds
      ? new Set(accountIds)
      : null
    for (const account of database.listAccounts()) {
      if (selected && !selected.has(account.id)) continue
      const resolved = backgroundAdapterForAccount(account.id)
      if (!resolved || resolved.account.remoteId || !resolved.background.identityDiscovery) {
        clearBackgroundCaptureState(account.id, shouldPreserveBackgroundResume(account.id))
        continue
      }
      browser.bootstrapPluginCapture(account.id, {
        pluginId: resolved.state.pluginId,
        retryInitialDelayMs: resolved.background.retryIntervalSeconds * 1_000,
        retryMaximumDelayMs: resolved.background.maximumRetryIntervalSeconds * 1_000
      })
    }
  }
  const waitForBackgroundDiscoveryIdle = async (): Promise<void> => {
    while (backgroundDiscoveryTasks.size > 0) {
      await Promise.allSettled([...backgroundDiscoveryTasks])
    }
  }
  const bootstrapBackgroundCaptureAccounts = (): void => reconcileBackgroundCaptureAccounts()
  window.webContents.on('did-finish-load', bootstrapBackgroundCaptureAccounts)
  removeBackgroundBootstrapListener = () => {
    if (!window.webContents.isDestroyed()) {
      window.webContents.off('did-finish-load', bootstrapBackgroundCaptureAccounts)
    }
  }
  const registerIpcHandler = ipcMain.handle.bind(ipcMain)
  const trusted = <T>(handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => T | Promise<T>) => {
    return async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<T> => {
      assertTrustedSender(window, event)
      return await runTracked(() => handler(event, ...args))
    }
  }
  const handleIpc = (
    channel: string,
    handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown
  ): void => {
    registerIpcHandler(channel, async (event, ...args) => {
      try {
        return await handler(event, ...args)
      } catch (error) {
        if (!wasErrorReported(error)) {
          try {
            services.logs.captureError('ipc', error, {
              channel,
              senderUrl: (event.senderFrame?.url ?? 'unknown').split(/[?#]/, 1)[0]
            })
          } catch {}
        }
        throw error
      }
    })
  }

  const currentAppearance = (): AppearanceState => ({
    preference: nativeTheme.themeSource,
    resolved: nativeTheme.shouldUseDarkColors ? 'dark' : 'light',
    themeColor
  })
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
  removeLogListener = services.logs.onChanged(() => {
    if (window.isDestroyed() || window.webContents.isDestroyed() || window.webContents.mainFrame.detached) return
    try {
      window.webContents.send('logs:changed')
    } catch {}
  })

  handleIpc('appearance:get', trusted(() => currentAppearance()))
  handleIpc('appearance:set', trusted((_event, value) => {
    const preference = parseThemePreference(value)
    database.setSetting('appearance.theme', preference)
    nativeTheme.themeSource = preference
    return broadcastAppearance()
  }))
  handleIpc('appearance:set-theme-color', trusted((_event, value) => {
    themeColor = parseThemeColor(value)
    database.setSetting('appearance.themeColor', themeColor)
    return broadcastAppearance()
  }))

  handleIpc('platforms:list', trusted(() => listPlatforms()))
  handleIpc('accounts:list', trusted(() => database.listAccounts()))
  handleIpc('accounts:create', trusted((_event, value) => {
    const input = parseCreateAccount(value)
    if (!input.adapterContributionId) {
      const candidates = services.pluginHost.listContributions().filter((item) => (
        item.enabled && item.granted && !item.suspendedReason && item.contribution.kind === 'platform.adapter' &&
        item.contribution.platform.id === input.platformId
      ))
      if (candidates.length === 1) input.adapterContributionId = candidates[0]!.contribution.id
    }
    const account = database.createAccount(input)
    reconcileBackgroundCaptureAccounts([account.id])
    return account
  }))
  handleIpc('accounts:update', trusted((_event, value) => {
    const input = parseUpdateAccount(value)
    const account = database.updateAccount(input)
    if (input.groupIds !== undefined) reconcileBackgroundCaptureAccounts([input.id])
    return account
  }))
  handleIpc('accounts:bulk-update', trusted((_event, value) => {
    const input = parseBulkUpdateAccounts(value)
    const accounts = database.bulkUpdateAccounts(input)
    if (input.groupChange) reconcileBackgroundCaptureAccounts(input.accountIds)
    return accounts
  }))
  handleIpc('accounts:disconnect', trusted(async (_event, value) => {
    const id = parseId(value)
    if (services.platformSync.isAccountActive(id)) throw new Error('账号正在同步或核验，请稍候')
    if (disconnectingAccounts.has(id)) throw new Error('账号正在断开')
    disconnectingAccounts.add(id)
    try {
      clearBackgroundCaptureState(id)
      await browser.disconnect(id)
      database.disconnectAccount(id)
    } finally {
      reconcileBackgroundCaptureAccounts([id])
      disconnectingAccounts.delete(id)
    }
  }))
  handleIpc('accounts:purge', trusted(async (_event, value) => {
    const id = parseId(value)
    if (services.platformSync.isAccountActive(id)) throw new Error('账号正在同步或核验，请稍候')
    if (disconnectingAccounts.has(id)) throw new Error('账号正在处理')
    disconnectingAccounts.add(id)
    try {
      clearBackgroundCaptureState(id)
      await browser.disconnect(id)
      database.disconnectAccount(id)
      await browser.purgeAccountMedia(id)
      database.removeAccount(id)
      notifyContentChanged()
    } finally {
      disconnectingAccounts.delete(id)
    }
  }))
  handleIpc('accounts:verify-identity', trusted(async (_event, value) => {
    const id = parseId(value)
    if (disconnectingAccounts.has(id)) throw new Error('账号正在处理，请稍候')
    try {
      return await services.platformSync.verifyIdentity(id)
    } finally {
      reconcileBackgroundCaptureAccounts([id])
      notifyAccountsChanged()
    }
  }))
  handleIpc('accounts:confirm-identity', trusted(async (_event, value) => {
    const input = parseConfirmApiIdentity(value)
    if (disconnectingAccounts.has(input.accountId)) throw new Error('账号正在处理，请稍候')
    try {
      const result = await services.platformSync.confirmIdentity(input)
      if (result.status === 'verified') clearBackgroundCaptureState(input.accountId)
      return result
    } finally {
      reconcileBackgroundCaptureAccounts([input.accountId])
      notifyAccountsChanged()
    }
  }))
  handleIpc('accounts:sync', trusted(async (_event, value) => {
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
  handleIpc('accounts:preview-sync-batch', trusted((_event, value) => (
    services.syncBatches.preview(parseEnqueueSyncBatch(value))
  )))
  handleIpc('accounts:enqueue-sync-batch', trusted(async (_event, value) => {
    const result = await services.syncBatches.enqueue(parseEnqueueSyncBatch(value))
    notifyTasksChanged()
    notifyAccountsChanged()
    return result
  }))
  handleIpc('accounts:list-adapters', trusted((_event, value) => (
    services.adapterRegistry.listForAccount(parseId(value))
  )))
  handleIpc('accounts:switch-adapter', trusted(async (_event, accountId, contributionId) => {
    const parsedAccountId = parseId(accountId)
    const account = await services.adapterRegistry.switchAdapter(parsedAccountId, parseId(contributionId))
    clearBackgroundCaptureState(parsedAccountId)
    reconcileBackgroundCaptureAccounts([parsedAccountId])
    notifyAccountsChanged()
    return account
  }))
  handleIpc('groups:list', trusted(() => database.listGroups()))
  handleIpc('groups:create', trusted((_event, value) => database.createGroup(parseCreateGroup(value))))
  handleIpc('groups:update', trusted((_event, value) => database.updateGroup(parseUpdateGroup(value))))
  handleIpc('groups:move', trusted((_event, value) => database.moveGroup(parseMoveGroup(value))))
  handleIpc('groups:remove', trusted((_event, value) => {
    database.removeGroup(parseId(value))
    reconcileBackgroundCaptureAccounts()
  }))
  handleIpc('browser:open', trusted(async (_event, accountId) => {
    const id = parseId(accountId)
    if (disconnectingAccounts.has(id)) throw new Error('账号正在断开，请稍候')
    const state = await browser.open(id)
    database.beginReconnect(id)
    reconcileBackgroundCaptureAccounts([id])
    return state
  }))

  handleIpc('content:list', trusted((_event, value) => database.listContents(parseContentQuery(value))))
  handleIpc('content:search', trusted((_event, value) => (
    database.searchContents(parseContentSearchQuery(value))
  )))
  handleIpc('content:bulk-update', trusted((_event, value) => {
    const result = database.bulkUpdateContents(parseBulkUpdateContents(value))
    notifyContentChanged()
    return result
  }))
  handleIpc('content:list-tags', trusted((_event, value) => (
    database.listContentTags(parseContentTagFacetQuery(value))
  )))
  handleIpc('content:export-filtered', trusted(async (_event, value) => {
    const result = await services.exporter.exportFiltered(parseExportFilteredContents(value))
    if (!result.cancelled) services.settings.markExportCompleted()
    return result
  }))
  handleIpc('content:detail', trusted((_event, value) => database.getContentDetail(parseId(value))))
  handleIpc('content:open-original', trusted(async (_event, value) => {
    const content = database.getContentDetail(parseId(value))
    if (!content.url || !isOfficialContentUrl(content.platformId, content.url, content.remoteId)) {
      throw new Error('该内容没有可用的官方原帖链接')
    }
    return browser.openAt(content.accountId, content.url)
  }))
  handleIpc('content:update', trusted((_event, value) => {
    const result = database.updateContent(parseUpdateContent(value))
    notifyContentChanged()
    return result
  }))
  handleIpc('content:clear-account', trusted((_event, value) => {
    const result = database.clearAccountData(parseId(value))
    notifyContentChanged()
    return result
  }))
  handleIpc('analytics:overview', trusted((_event, value) => database.getAnalytics(parseAnalyticsQuery(value))))
  handleIpc('analytics:summary', trusted((_event, value) => (
    database.getAnalyticsSummary(parseAnalyticsSummaryQuery(value))
  )))
  handleIpc('analytics:compare', trusted((_event, value) => (
    database.getAnalyticsComparison(parseAnalyticsComparisonQuery(value))
  )))
  handleIpc('analytics:content-lifecycle', trusted((_event, value) => (
    database.getContentLifecycle(parseContentLifecycleQuery(value))
  )))
  handleIpc('analytics:account-metrics', trusted((_event, value) => (
    database.getAccountMetricHistory(parseAccountMetricQuery(value))
  )))
  handleIpc('analytics:dashboard', trusted(() => database.getDashboard()))
  handleIpc('tasks:summary', trusted((_event, value) => (
    services.tasks.summary(parseTaskQuery(value))
  )))
  handleIpc('tasks:list', trusted((_event, value) => (
    services.tasks.list(parseTaskQuery(value))
  )))
  handleIpc('tasks:get', trusted((_event, value) => services.tasks.get(parseId(value))))
  handleIpc('tasks:list-batch', trusted((_event, value) => services.tasks.getBatch(parseId(value))))
  handleIpc('tasks:list-batches', trusted(() => services.tasks.listBatches()))
  handleIpc('tasks:cancel', trusted(async (_event, value) => {
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
  handleIpc('tasks:retry', trusted(async (_event, value) => {
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
  handleIpc('tasks:mark-handled', trusted(async (_event, value) => {
    const task = await services.tasks.markHandled(parseMarkTaskHandled(value))
    notifyTasksChanged()
    return task
  }))
  handleIpc('logs:list', trusted((_event, value) => (
    services.logs.list(parseAppLogQuery(value))
  )))
  handleIpc('logs:export', trusted(async (_event, value) => {
    const query = parseAppLogQuery(value)
    const result = await dialog.showSaveDialog(window, {
      title: '导出诊断日志',
      defaultPath: `streamfold-diagnostics-${new Date().toISOString().slice(0, 10)}.jsonl`,
      filters: [{ name: 'JSON Lines', extensions: ['jsonl'] }]
    })
    if (result.canceled || !result.filePath) {
      return { cancelled: true, fileName: null, exportedCount: 0 }
    }
    return services.logs.exportTo(result.filePath, query)
  }))
  handleIpc('logs:clear', trusted(() => services.logs.clear()))
  handleIpc('logs:record-renderer-error', trusted((_event, value) => {
    const input = parseRendererErrorLog(value)
    services.logs.error('renderer', input.message, {
      code: input.code ?? (input.source === 'vue' ? 'VUE_RENDER_ERROR' : 'RENDERER_ERROR'),
      details: [input.stack, input.details].filter(Boolean).join('\n') || null,
      context: {
        source: input.source,
        file: input.file ?? null,
        line: input.line ?? null,
        column: input.column ?? null,
        componentInfo: input.componentInfo ?? null
      }
    })
  }))
  handleIpc('plugins:packages', trusted(() => services.pluginHost.listPackages()))
  handleIpc('plugins:contributions', trusted(() => services.pluginHost.listContributions()))
  handleIpc('plugins:set-package-enabled', trusted((_event, id, enabled) => {
    const pluginId = parseId(id)
    const next = parseBoolean(enabled, '插件包开关')
    const result = services.pluginHost.setPackageEnabled(pluginId, next)
    if (!next) {
      stopCapturesForPlugin(pluginId, true)
      services.pluginLifecycle.stop(pluginId)
    } else reconcileBackgroundCaptureAccounts()
    return result
  }))
  handleIpc('plugins:set-contribution-enabled', trusted((_event, pluginId, contributionId, enabled) => {
    const parsedPluginId = parseId(pluginId)
    const next = parseBoolean(enabled, '贡献点开关')
    const parsedContributionId = parseId(contributionId)
    const result = services.pluginHost.setContributionEnabled(
      parsedPluginId,
      parsedContributionId,
      next
    )
    if (!next) {
      stopCapturesForPlugin(parsedPluginId, true)
      services.pluginLifecycle.stop(parsedPluginId)
    } else reconcileBackgroundCaptureAccounts()
    return result
  }))
  handleIpc('plugins:grant', trusted((_event, value) => {
    const grant = parsePluginGrant(value)
    const result = services.pluginHost.grant(grant)
    stopCapturesForPlugin(grant.pluginId, true)
    services.pluginLifecycle.stop(grant.pluginId)
    reconcileBackgroundCaptureAccounts()
    return result
  }))
  handleIpc('plugins:get-config', trusted((_event, pluginId, contributionId) => (
    services.pluginHost.getConfig(parseId(pluginId), parseId(contributionId))
  )))
  handleIpc('plugins:save-config', trusted((_event, value) => {
    const input = parsePluginConfig(value)
    const result = services.pluginHost.saveConfig(input)
    stopCapturesForPlugin(input.pluginId, true)
    services.pluginLifecycle.stop(input.pluginId)
    reconcileBackgroundCaptureAccounts()
    return result
  }))
  handleIpc('plugins:schedules', trusted(() => services.pluginHost.listSchedules()))
  handleIpc('plugins:create-schedule', trusted((_event, value) => (
    services.pluginHost.createSchedule(parseCreatePluginSchedule(value))
  )))
  handleIpc('plugins:set-schedule-enabled', trusted((_event, id, enabled) => (
    services.pluginHost.updateSchedule(parseId(id), parseBoolean(enabled, '计划开关'))
  )))
  handleIpc('plugins:remove-schedule', trusted((_event, id) => (
    services.pluginHost.removeSchedule(parseId(id))
  )))
  handleIpc('plugins:runs', trusted(() => database.listPluginRuns()))
  handleIpc('plugins:get-grant', trusted((_event, pluginId, contributionId) => (
    services.pluginHost.getGrant(parseId(pluginId), parseId(contributionId))
  )))
  handleIpc('plugins:catalog', trusted(() => services.pluginLifecycle.getCatalog()))
  handleIpc('plugins:refresh-catalog', trusted(async () => {
    try {
      const state = await services.pluginLifecycle.refreshCatalog()
      services.adapterRegistry.reconcile()
      return state
    } finally {
      reconcileBackgroundCaptureAccounts()
    }
  }))
  handleIpc('plugins:install-catalog', trusted(async (_event, pluginId) => {
    try {
      const installed = await services.pluginLifecycle.installFromCatalog(parseId(pluginId))
      registerNewManifestPlatforms(services.pluginHost)
      services.adapterRegistry.reconcile()
      return installed
    } finally {
      reconcileBackgroundCaptureAccounts()
    }
  }))
  handleIpc('plugins:install-development', trusted(async () => {
    try {
      const installed = await services.pluginLifecycle.installDevelopment()
      if (installed) {
        registerNewManifestPlatforms(services.pluginHost)
        services.adapterRegistry.reconcile()
      }
      return installed
    } finally {
      reconcileBackgroundCaptureAccounts()
    }
  }))
  handleIpc('plugins:update', trusted(async (_event, pluginId, confirmPermissionExpansion) => {
    const parsedPluginId = parseId(pluginId)
    try {
      const installed = await services.pluginLifecycle.update(
        parsedPluginId,
        confirmPermissionExpansion === undefined
          ? false
          : parseBoolean(confirmPermissionExpansion, '更新权限确认')
      )
      registerNewManifestPlatforms(services.pluginHost)
      services.adapterRegistry.reconcile()
      return installed
    } finally {
      reconcileBackgroundCaptureAccounts()
    }
  }))
  handleIpc('plugins:uninstall', trusted(async (_event, pluginId) => {
    const parsedPluginId = parseId(pluginId)
    try {
      await services.pluginLifecycle.uninstall(parsedPluginId)
      registerNewManifestPlatforms(services.pluginHost)
      services.adapterRegistry.reconcile()
    } finally {
      reconcileBackgroundCaptureAccounts()
    }
  }))
  handleIpc('plugins:get-developer-mode', trusted(() => services.pluginLifecycle.getDeveloperMode()))
  handleIpc('plugins:set-developer-mode', trusted((_event, enabled) => (
    services.pluginLifecycle.setDeveloperMode(parseBoolean(enabled, '开发者模式'))
  )))
  handleIpc('plugins:run', trusted((_event, pluginId, contributionId, accountId) => (
    services.pluginAutomation.runManual(
      parseId(pluginId),
      parseId(contributionId),
      accountId === undefined || accountId === null || accountId === '' ? null : parseId(accountId)
    )
  )))
  handleIpc('plugins:retry-run', trusted((_event, value) => {
    const run = database.getPluginRun(parseId(value))
    if (!run || (run.status !== 'failed' && run.status !== 'interrupted')) throw new Error('该运行记录不能重试')
    return services.pluginAutomation.runManual(run.pluginId, run.contributionId, run.accountId, run.attempt + 1)
  }))
  handleIpc('updates:get-state', trusted(() => services.updates.getState()))
  handleIpc('updates:check', trusted(() => services.updates.check()))
  handleIpc('updates:download', trusted(() => services.updates.download()))
  handleIpc('updates:restart-and-install', async (event) => {
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
  handleIpc('settings:overview', trusted(() => services.settings.overview()))
  handleIpc('settings:update', trusted(async (_event, value) => {
    const input = parseUpdateSettings(value)
    const result = await services.settings.update(input)
    if (input.autoCheckUpdates !== undefined) {
      services.updates.setAutomaticChecks(input.autoCheckUpdates)
    }
    return result
  }))
  handleIpc('settings:export', trusted(async (_event, value) => {
    const input = parseExportData(value)
    const result = await services.exporter.exportData(input)
    if (!result.cancelled) services.settings.markExportCompleted()
    return result
  }))
  handleIpc('settings:backup-create', trusted((_event, value) => {
    if (services.syncBatches.hasRunningTasks() || services.pluginAutomation.hasRunningTasks()) {
      throw new Error('后台任务正在运行，请完成后再创建备份')
    }
    return services.backup.create(parseCreateEncryptedBackup(value))
  }))
  handleIpc('settings:backup-restore', async (event, value) => {
    assertTrustedSender(window, event)
    const input = parseRestoreEncryptedBackup(value)
    if (maintenance) throw new Error(maintenanceMessage)
    if (services.syncBatches.hasRunningTasks() || services.pluginAutomation.hasRunningTasks()) {
      throw new Error('后台任务正在运行，请完成后再恢复备份')
    }
    services.syncBatches.stop()
    services.pluginAutomation.stop()
    backgroundDiscoveryPaused = true
    try {
      await beginMaintenance()
      await waitForBackgroundDiscoveryIdle()
      const result = await services.backup.restore(input)
      const restoredSettings = await services.settings.overview()
      services.updates.setAutomaticChecks(restoredSettings.autoCheckUpdates)
      const restoredTheme = database.getSetting<string>('appearance.theme', 'system')
      nativeTheme.themeSource = restoredTheme === 'light' || restoredTheme === 'dark' || restoredTheme === 'system'
        ? restoredTheme
        : 'system'
      themeColor = storedThemeColor(database)
      broadcastAppearance()
      notifyAccountsChanged()
      notifyContentChanged()
      return result
    } finally {
      endMaintenance()
      backgroundDiscoveryPaused = false
      reconcileBackgroundCaptureAccounts()
      services.pluginAutomation.start()
      services.syncBatches.start()
    }
  })

  handleIpc('browser-workspace:get-state', (event) => browser.getStateForSender(event))
  handleIpc('browser-workspace:get-appearance', (event) => {
    browser.assertTrustedSender(event)
    return currentAppearance()
  })
  handleIpc('browser-workspace:set-appearance', (event, value) => {
    browser.assertTrustedSender(event)
    if (maintenance) throw new Error(maintenanceMessage)
    const preference = parseThemePreference(value)
    database.setSetting('appearance.theme', preference)
    nativeTheme.themeSource = preference
    return broadcastAppearance()
  })
  handleIpc('browser-workspace:set-theme-color', (event, value) => {
    browser.assertTrustedSender(event)
    if (maintenance) throw new Error(maintenanceMessage)
    themeColor = parseThemeColor(value)
    database.setSetting('appearance.themeColor', themeColor)
    return broadcastAppearance()
  })
  handleIpc('browser-workspace:back', (event) => browser.backForSender(event))
  handleIpc('browser-workspace:forward', (event) => browser.forwardForSender(event))
  handleIpc('browser-workspace:reload', (event) => browser.reloadForSender(event))
  handleIpc('browser-workspace:home', (event) => browser.homeForSender(event))
  handleIpc('browser-workspace:close', (event) => browser.closeForSender(event))
}

export function unregisterIpc(): void {
  removeNativeThemeListener?.()
  removeNativeThemeListener = null
  removeUpdateListener?.()
  removeUpdateListener = null
  removeTaskListener?.()
  removeTaskListener = null
  removeLogListener?.()
  removeLogListener = null
  removePluginCaptureListener?.()
  removePluginCaptureListener = null
  for (const channel of [
    'appearance:get',
    'appearance:set',
    'appearance:set-theme-color',
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
    'content:search',
    'content:bulk-update',
    'content:list-tags',
    'content:export-filtered',
    'content:detail',
    'content:open-original',
    'content:update',
    'content:clear-account',
    'analytics:overview',
    'analytics:summary',
    'analytics:compare',
    'analytics:content-lifecycle',
    'analytics:account-metrics',
    'analytics:dashboard',
    'tasks:summary',
    'tasks:list',
    'tasks:get',
    'tasks:cancel',
    'tasks:retry',
    'tasks:list-batch',
    'tasks:list-batches',
    'tasks:mark-handled',
    'logs:list',
    'logs:export',
    'logs:clear',
    'logs:record-renderer-error',
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
    'browser-workspace:set-theme-color',
    'browser-workspace:back',
    'browser-workspace:forward',
    'browser-workspace:reload',
    'browser-workspace:home',
    'browser-workspace:close'
  ]) ipcMain.removeHandler(channel)
}

function parseThemePreference(value: unknown): ThemePreference {
  if (value === 'light' || value === 'dark' || value === 'system') return value
  throw new Error('主题设置无效')
}

function captureErrorSignature(error: Error | null): string {
  if (!error) return ''
  const diagnostic = error as Error & {
    status?: unknown
    contentType?: unknown
    apiError?: unknown
    responseBody?: unknown
    responseBytes?: unknown
  }
  return JSON.stringify([
    diagnostic.name,
    diagnostic.message,
    diagnostic.status ?? null,
    diagnostic.contentType ?? null,
    diagnostic.apiError ?? null,
    diagnostic.responseBody ?? null,
    diagnostic.responseBytes ?? null
  ]).slice(0, 12_000)
}

function identityDiscoveryErrorSignature(error: unknown): string {
  if (error instanceof Error) return captureErrorSignature(error)
  try {
    return `${typeof error}:${String(error)}`.slice(0, 12_000)
  } catch {
    return `[${typeof error}]`
  }
}

function parseThemeColor(value: unknown): string {
  if (typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)) return value.toLowerCase()
  throw new Error('主题色无效')
}

function storedThemeColor(database: SocialDatabase): string {
  const value = database.getSetting<unknown>('appearance.themeColor', DEFAULT_THEME_COLOR)
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)
    ? value.toLowerCase()
    : DEFAULT_THEME_COLOR
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
