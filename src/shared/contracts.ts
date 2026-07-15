/** Runtime-validated identifier; third-party platform adapters are not compile-time enums. */
export type PlatformId = string

export const accountStatuses = [
  'pending',
  'ready',
  'paused',
  'expired',
  'mismatch',
  'cooldown',
  'unsupported'
] as const
export type AccountStatus = (typeof accountStatuses)[number]

export const connectionStatuses = ['pending', 'ready', 'expired', 'mismatch', 'disconnected'] as const
export type ConnectionStatus = (typeof connectionStatuses)[number]
export const ownershipStatuses = ['unconfirmed', 'user_confirmed', 'plugin_verified'] as const
export type OwnershipStatus = (typeof ownershipStatuses)[number]
export const syncStatuses = ['idle', 'queued', 'running', 'cooldown', 'failed', 'unsupported'] as const
export type SyncStatus = (typeof syncStatuses)[number]

export type SyncMode = 'profile_only' | 'recent_20' | 'recent_100' | 'disabled'

export interface PlatformDefinition {
  id: PlatformId
  name: string
  shortName: string
  loginUrl: string
  homeUrl: string
  officialHosts: string[]
  contentUrls?: import('./plugin-host-contracts').PlatformContentUrlDeclaration[]
  riskNote: string
}

export interface Account {
  id: string
  platformId: PlatformId
  adapterContributionId: string | null
  alias: string
  aliasCustomized: boolean
  remoteName: string
  remoteId: string | null
  avatarUrl: string
  bio: string
  creatorLevel: number | null
  latestSnapshot: import('./content-contracts').AccountSnapshot | null
  status: AccountStatus
  connectionStatus: ConnectionStatus
  ownershipStatus: OwnershipStatus
  syncEnabled: boolean
  syncStatus: SyncStatus
  cooldownUntil: string | null
  lastSyncError: string
  ownershipConfirmedAt: string | null
  identityVerifiedAt: string | null
  note: string
  tags: string[]
  groupIds: string[]
  sessionPartition: string
  syncMode: SyncMode
  isDefault: boolean
  createdAt: string
  updatedAt: string
  lastSyncedAt: string | null
}

export interface Group {
  id: string
  name: string
  color: string
  sortOrder: number
  accountCount: number
}

export interface CreateAccountInput {
  platformId: PlatformId
  adapterContributionId?: string
  alias?: string
  syncMode: SyncMode
}

export interface UpdateAccountInput {
  id: string
  alias?: string
  note?: string
  tags?: string[]
  groupIds?: string[]
  syncEnabled?: boolean
  syncMode?: SyncMode
  isDefault?: boolean
}

export interface CreateGroupInput {
  name: string
  color: string
}

export interface UpdateGroupInput {
  id: string
  name?: string
  color?: string
}

export interface MoveGroupInput {
  id: string
  direction: 'up' | 'down'
}

export interface BulkUpdateAccountsInput {
  accountIds: string[]
  groupChange?: {
    groupId: string
    action: 'add' | 'remove'
  }
  syncEnabled?: boolean
}

export interface BrowserState {
  accountId: string | null
  platformId: PlatformId | null
  accountAlias: string
  platformName: string
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  official: boolean
  windowOpen: boolean
  message: string
}

export type ThemePreference = 'light' | 'dark' | 'system'
export type ResolvedTheme = Exclude<ThemePreference, 'system'>
export type RuntimePlatform = 'win32' | 'darwin' | 'linux'
export type AppNavigationTarget = 'dashboard' | 'accounts' | 'content' | 'analytics' | 'tasks' | 'plugins' | 'settings'

export interface AppearanceState {
  preference: ThemePreference
  resolved: ResolvedTheme
}

export interface AppearanceApi {
  get(): Promise<AppearanceState>
  set(preference: ThemePreference): Promise<AppearanceState>
  onChanged(callback: (state: AppearanceState) => void): () => void
}

export interface SocialVaultApi {
  runtime: { platform: RuntimePlatform }
  appearance: AppearanceApi
  updates: import('./update-contracts').UpdateApi
  navigation: {
    onRequested(callback: (target: AppNavigationTarget) => void): () => void
  }
  platforms: {
    list(): Promise<PlatformDefinition[]>
  }
  accounts: {
    list(): Promise<Account[]>
    onChanged(callback: () => void): () => void
    create(input: CreateAccountInput): Promise<Account>
    update(input: UpdateAccountInput): Promise<Account>
    bulkUpdate(input: BulkUpdateAccountsInput): Promise<Account[]>
    disconnect(id: string): Promise<void>
    purge(id: string): Promise<void>
    verifyIdentity(id: string): Promise<import('./session-api-contracts').SessionApiIdentityCheckResult>
    confirmIdentity(input: import('./session-api-contracts').ConfirmSessionApiIdentityInput): Promise<import('./session-api-contracts').SessionApiIdentityCheckResult>
    sync(id: string): Promise<import('./session-api-contracts').SessionApiSyncResult>
    previewSyncBatch(input: import('./job-contracts').EnqueueSyncBatchInput): Promise<import('./job-contracts').SyncBatchPreview>
    enqueueSyncBatch(input: import('./job-contracts').EnqueueSyncBatchInput): Promise<import('./job-contracts').EnqueueSyncBatchResult>
    listAdapters(id: string): Promise<import('./plugin-host-contracts').AccountAdapterOption[]>
    switchAdapter(id: string, contributionId: string): Promise<Account>
  }
  groups: {
    list(): Promise<Group[]>
    create(input: CreateGroupInput): Promise<Group>
    update(input: UpdateGroupInput): Promise<Group>
    move(input: MoveGroupInput): Promise<Group[]>
    remove(id: string): Promise<void>
  }
  browser: {
    open(accountId: string): Promise<BrowserState>
    onState(callback: (state: BrowserState) => void): () => void
  }
  content: {
    onChanged(callback: () => void): () => void
    list(query?: import('./content-contracts').ContentQuery): Promise<import('./content-contracts').ContentSummary[]>
    detail(id: string): Promise<import('./content-contracts').ContentDetail>
    openOriginal(id: string): Promise<BrowserState>
    update(input: import('./content-contracts').UpdateContentInput): Promise<import('./content-contracts').ContentDetail>
    clearAccount(accountId: string): Promise<void>
  }
  analytics: {
    overview(query?: import('./content-contracts').AnalyticsQuery): Promise<import('./content-contracts').AnalyticsOverview>
    accountMetrics(query: import('./content-contracts').AccountMetricQuery): Promise<import('./content-contracts').AccountMetricHistory>
    dashboard(): Promise<import('./content-contracts').DashboardOverview>
  }
  tasks: {
    summary(query?: import('./job-contracts').TaskQuery): Promise<import('./job-contracts').TaskSummary>
    list(query?: import('./job-contracts').TaskQuery): Promise<import('./job-contracts').TaskListResult>
    get(id: string): Promise<import('./job-contracts').TaskView | null>
    cancel(id: string): Promise<import('./job-contracts').TaskView>
    retry(id: string): Promise<import('./job-contracts').TaskView>
    markHandled(input: import('./job-contracts').MarkTaskHandledInput): Promise<import('./job-contracts').TaskView>
    listBatch(batchId: string): Promise<import('./job-contracts').TaskBatchView | null>
    listBatches(): Promise<import('./job-contracts').TaskBatchView[]>
    onChanged(callback: () => void): () => void
  }
  plugins: {
    listPackages(): Promise<import('./plugin-host-contracts').InstalledPluginPackage[]>
    listContributions(): Promise<import('./plugin-host-contracts').PluginContributionState[]>
    setPackageEnabled(id: string, enabled: boolean): Promise<import('./plugin-host-contracts').InstalledPluginPackage>
    setContributionEnabled(pluginId: string, contributionId: string, enabled: boolean): Promise<import('./plugin-host-contracts').PluginContributionState>
    grant(input: import('./plugin-host-contracts').UpsertPluginGrantInput): Promise<import('./plugin-host-contracts').PluginGrant>
    getConfig(pluginId: string, contributionId: string): Promise<import('./plugin-host-contracts').PluginConfigView>
    saveConfig(input: import('./plugin-host-contracts').SavePluginConfigInput): Promise<import('./plugin-host-contracts').PluginConfigView>
    listSchedules(): Promise<import('./plugin-host-contracts').PluginSchedule[]>
    createSchedule(input: import('./plugin-host-contracts').CreatePluginScheduleInput): Promise<import('./plugin-host-contracts').PluginSchedule>
    setScheduleEnabled(id: string, enabled: boolean): Promise<import('./plugin-host-contracts').PluginSchedule>
    removeSchedule(id: string): Promise<void>
    listRuns(): Promise<import('./plugin-host-contracts').PluginRunRecord[]>
    getGrant(pluginId: string, contributionId: string): Promise<import('./plugin-host-contracts').PluginGrant | null>
    refreshCatalog(): Promise<import('./plugin-host-contracts').PluginCatalogState>
    getCatalog(): Promise<import('./plugin-host-contracts').PluginCatalogState>
    installFromCatalog(pluginId: string): Promise<import('./plugin-host-contracts').InstalledPluginPackage>
    installDevelopment(): Promise<import('./plugin-host-contracts').InstalledPluginPackage | null>
    update(pluginId: string, confirmPermissionExpansion?: boolean): Promise<import('./plugin-host-contracts').InstalledPluginPackage>
    uninstall(pluginId: string): Promise<void>
    getDeveloperMode(): Promise<import('./plugin-host-contracts').PluginDeveloperState>
    setDeveloperMode(enabled: boolean): Promise<import('./plugin-host-contracts').PluginDeveloperState>
    run(pluginId: string, contributionId: string, accountId?: string): Promise<import('./plugin-host-contracts').PluginRunRecord>
    retryRun(id: string): Promise<import('./plugin-host-contracts').PluginRunRecord>
  }
  settings: {
    overview(): Promise<import('./settings-contracts').StorageOverview>
    update(input: import('./settings-contracts').UpdateSettingsInput): Promise<import('./settings-contracts').StorageOverview>
    exportData(input: import('./settings-contracts').ExportDataInput): Promise<import('./settings-contracts').ExportDataResult>
    createBackup(input: import('./backup-contracts').CreateEncryptedBackupInput): Promise<import('./backup-contracts').EncryptedBackupResult>
    restoreBackup(input: import('./backup-contracts').RestoreEncryptedBackupInput): Promise<import('./backup-contracts').EncryptedBackupResult>
  }
}

export interface BrowserWorkspaceApi {
  runtime: { platform: RuntimePlatform }
  appearance: AppearanceApi
  getState(): Promise<BrowserState>
  back(): Promise<void>
  forward(): Promise<void>
  reload(): Promise<void>
  home(): Promise<void>
  close(): Promise<void>
  onState(callback: (state: BrowserState) => void): () => void
}

export * from './content-contracts'
export * from './job-contracts'
export * from './plugin-host-contracts'
export * from './settings-contracts'
export * from './backup-contracts'
export * from './session-api-contracts'
export * from './xiaohongshu-api-contracts'
export * from './update-contracts'
export * from './ipc-bridge-contracts'
