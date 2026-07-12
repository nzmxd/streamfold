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
  status?: AccountStatus
  syncMode?: SyncMode
  isDefault?: boolean
}

export interface CreateGroupInput {
  name: string
  color: string
}

export interface BrowserState {
  accountId: string | null
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

export interface SocialVaultApi {
  platforms: {
    list(): Promise<PlatformDefinition[]>
  }
  accounts: {
    list(): Promise<Account[]>
    create(input: CreateAccountInput): Promise<Account>
    update(input: UpdateAccountInput): Promise<Account>
    disconnect(id: string): Promise<void>
  }
  groups: {
    list(): Promise<Group[]>
    create(input: CreateGroupInput): Promise<Group>
    remove(id: string): Promise<void>
  }
  browser: {
    open(accountId: string): Promise<BrowserState>
    onState(callback: (state: BrowserState) => void): () => void
  }
}

export interface BrowserWorkspaceApi {
  getState(): Promise<BrowserState>
  back(): Promise<void>
  forward(): Promise<void>
  reload(): Promise<void>
  home(): Promise<void>
  close(): Promise<void>
  onState(callback: (state: BrowserState) => void): () => void
}
