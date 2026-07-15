import type {
  AppearanceState,
  AppNavigationTarget,
  BrowserState,
  SocialVaultApi,
  SocialVaultBridge,
  SocialVaultEventChannel,
  SocialVaultInvokeChannel,
  UpdateState
} from '../../../shared/contracts'
import { serializeIpcArgs } from './plain-data'

export function createSocialVaultApi(bridge: SocialVaultBridge): SocialVaultApi {
  const invoke = <T>(channel: SocialVaultInvokeChannel, ...args: unknown[]): Promise<T> => (
    bridge.invoke(channel, serializeIpcArgs(channel, args)) as Promise<T>
  )
  const subscribe = (
    channel: SocialVaultEventChannel,
    callback: (payload?: unknown) => void
  ): (() => void) => bridge.on(channel, callback)

  return {
    runtime: bridge.runtime,
    appearance: {
      get: () => invoke('appearance:get'),
      set: (preference) => invoke('appearance:set', preference),
      onChanged: (callback) => subscribe('appearance:changed', (state) => callback(state as AppearanceState))
    },
    updates: {
      getState: () => invoke('updates:get-state'),
      check: () => invoke('updates:check'),
      download: () => invoke('updates:download'),
      restartAndInstall: () => invoke('updates:restart-and-install'),
      onChanged: (callback) => subscribe('updates:changed', (state) => callback(state as UpdateState))
    },
    navigation: {
      onRequested: (callback) => subscribe(
        'navigation:requested',
        (target) => callback(target as AppNavigationTarget)
      )
    },
    platforms: {
      list: () => invoke('platforms:list')
    },
    accounts: {
      list: () => invoke('accounts:list'),
      onChanged: (callback) => subscribe('accounts:changed', () => callback()),
      create: (input) => invoke('accounts:create', input),
      update: (input) => invoke('accounts:update', input),
      bulkUpdate: (input) => invoke('accounts:bulk-update', input),
      disconnect: (id) => invoke('accounts:disconnect', id),
      purge: (id) => invoke('accounts:purge', id),
      verifyIdentity: (id) => invoke('accounts:verify-identity', id),
      confirmIdentity: (input) => invoke('accounts:confirm-identity', input),
      sync: (id) => invoke('accounts:sync', id),
      previewSyncBatch: (input) => invoke('accounts:preview-sync-batch', input),
      enqueueSyncBatch: (input) => invoke('accounts:enqueue-sync-batch', input),
      listAdapters: (id) => invoke('accounts:list-adapters', id),
      switchAdapter: (id, contributionId) => invoke('accounts:switch-adapter', id, contributionId)
    },
    groups: {
      list: () => invoke('groups:list'),
      create: (input) => invoke('groups:create', input),
      update: (input) => invoke('groups:update', input),
      move: (input) => invoke('groups:move', input),
      remove: (id) => invoke('groups:remove', id)
    },
    browser: {
      open: (accountId) => invoke('browser:open', accountId),
      onState: (callback) => subscribe('browser:state', (state) => callback(state as BrowserState))
    },
    content: {
      onChanged: (callback) => subscribe('content:changed', () => callback()),
      list: (query) => invoke('content:list', query),
      detail: (id) => invoke('content:detail', id),
      openOriginal: (id) => invoke('content:open-original', id),
      update: (input) => invoke('content:update', input),
      clearAccount: (accountId) => invoke('content:clear-account', accountId)
    },
    analytics: {
      overview: (query) => invoke('analytics:overview', query),
      accountMetrics: (query) => invoke('analytics:account-metrics', query),
      dashboard: () => invoke('analytics:dashboard')
    },
    tasks: {
      summary: (query) => invoke('tasks:summary', query),
      list: (query) => invoke('tasks:list', query),
      get: (id) => invoke('tasks:get', id),
      cancel: (id) => invoke('tasks:cancel', id),
      retry: (id) => invoke('tasks:retry', id),
      listBatch: (batchId) => invoke('tasks:list-batch', batchId),
      listBatches: () => invoke('tasks:list-batches'),
      onChanged: (callback) => subscribe('tasks:changed', () => callback())
    },
    plugins: {
      listPackages: () => invoke('plugins:packages'),
      listContributions: () => invoke('plugins:contributions'),
      setPackageEnabled: (id, enabled) => invoke('plugins:set-package-enabled', id, enabled),
      setContributionEnabled: (pluginId, contributionId, enabled) => (
        invoke('plugins:set-contribution-enabled', pluginId, contributionId, enabled)
      ),
      grant: (input) => invoke('plugins:grant', input),
      getConfig: (pluginId, contributionId) => invoke('plugins:get-config', pluginId, contributionId),
      saveConfig: (input) => invoke('plugins:save-config', input),
      listSchedules: () => invoke('plugins:schedules'),
      createSchedule: (input) => invoke('plugins:create-schedule', input),
      setScheduleEnabled: (id, enabled) => invoke('plugins:set-schedule-enabled', id, enabled),
      removeSchedule: (id) => invoke('plugins:remove-schedule', id),
      listRuns: () => invoke('plugins:runs'),
      getGrant: (pluginId, contributionId) => invoke('plugins:get-grant', pluginId, contributionId),
      refreshCatalog: () => invoke('plugins:refresh-catalog'),
      getCatalog: () => invoke('plugins:catalog'),
      installFromCatalog: (pluginId) => invoke('plugins:install-catalog', pluginId),
      installDevelopment: () => invoke('plugins:install-development'),
      update: (pluginId, confirmPermissionExpansion = false) => (
        invoke('plugins:update', pluginId, confirmPermissionExpansion)
      ),
      uninstall: (pluginId) => invoke('plugins:uninstall', pluginId),
      getDeveloperMode: () => invoke('plugins:get-developer-mode'),
      setDeveloperMode: (enabled) => invoke('plugins:set-developer-mode', enabled),
      run: (pluginId, contributionId, accountId) => invoke(
        'plugins:run',
        pluginId,
        contributionId,
        accountId
      ),
      retryRun: (id) => invoke('plugins:retry-run', id)
    },
    settings: {
      overview: () => invoke('settings:overview'),
      update: (input) => invoke('settings:update', input),
      exportData: (input) => invoke('settings:export', input),
      createBackup: (input) => invoke('settings:backup-create', input),
      restoreBackup: (input) => invoke('settings:backup-restore', input)
    }
  }
}

export function installSocialVaultApi(): SocialVaultApi {
  const api = createSocialVaultApi(window.socialVaultBridge)
  Object.defineProperty(window, 'socialVault', {
    configurable: false,
    enumerable: true,
    writable: false,
    value: api
  })
  return api
}
