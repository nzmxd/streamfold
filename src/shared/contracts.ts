export const platformIds = ['xiaohongshu', 'weibo', 'douyin', 'zhihu'] as const
export type PlatformId = (typeof platformIds)[number]

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
  riskNote: string
}

export interface Account {
  id: string
  platformId: PlatformId
  alias: string
  remoteName: string
  remoteId: string | null
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
  alias: string
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
    verifyIdentity(id: string): Promise<import('./xiaohongshu-api-contracts').ApiIdentityCheckResult>
    confirmIdentity(input: import('./xiaohongshu-api-contracts').ConfirmApiIdentityInput): Promise<import('./xiaohongshu-api-contracts').ApiIdentityCheckResult>
    sync(id: string): Promise<import('./xiaohongshu-api-contracts').XiaohongshuSyncResult>
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
    list(query?: import('./content-contracts').ContentQuery): Promise<import('./content-contracts').ContentSummary[]>
    detail(id: string): Promise<import('./content-contracts').ContentDetail>
    update(input: import('./content-contracts').UpdateContentInput): Promise<import('./content-contracts').ContentDetail>
    clearAccount(accountId: string): Promise<void>
  }
  analytics: {
    overview(query?: import('./content-contracts').AnalyticsQuery): Promise<import('./content-contracts').AnalyticsOverview>
    dashboard(): Promise<import('./content-contracts').DashboardOverview>
  }
  plugins: {
    list(): Promise<import('./plugin-contracts').PluginInstallation[]>
    setEnabled(id: string, enabled: boolean): Promise<import('./plugin-contracts').PluginInstallation>
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
export * from './plugin-contracts'
export * from './settings-contracts'
export * from './backup-contracts'
export * from './xiaohongshu-api-contracts'
