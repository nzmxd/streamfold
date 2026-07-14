import { randomUUID } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import type {
  Account,
  AccountStatus,
  BulkUpdateAccountsInput,
  ConnectionStatus,
  CreateAccountInput,
  CreateGroupInput,
  Group,
  MoveGroupInput,
  OwnershipStatus,
  PlatformId,
  SyncMode,
  SyncStatus,
  UpdateAccountInput,
  UpdateGroupInput
} from '../shared/contracts'
import type {
  AccountSnapshot,
  AnalyticsOverview,
  AnalyticsQuery,
  ContentDetail,
  ContentQuery,
  ContentSnapshot,
  ContentSummary,
  ContentType,
  DashboardOverview,
  MetricValues,
  UpdateContentInput
} from '../shared/content-contracts'
import type { JobKind, JobRecord, JobStatus } from '../shared/job-contracts'
import type {
  InstalledPluginPackage,
  PluginEventDelivery,
  PluginEventEnvelope,
  PluginGrant,
  PluginManifestV2,
  PluginPackageSource,
  PluginPackageStatus,
  PluginRunRecord as ExtensionRunRecord,
  PluginSchedule
} from '../shared/plugin-host-contracts'
import type {
  DatasetCommitStats,
  StandardContent,
  StandardDataset,
  StandardProfile
} from './plugins/types'
import { CURRENT_SCHEMA_VERSION, migrateDatabase, readUserVersion } from './storage/migrations'

export interface CreateJobInput {
  id?: string
  kind: JobKind
  accountId: string
  pluginId: string
  status?: JobStatus
  progress?: number
  stage?: string
  result?: Record<string, unknown> | null
  errorCode?: string
  errorMessage?: string
  createdAt?: string
  startedAt?: string | null
  finishedAt?: string | null
}

export type UpdateJobInput = Partial<Omit<JobRecord, 'id'>>

export interface ManagedSyncCommitMetadata {
  accountId: string
  pluginId: string
  jobId: string
  authorizedMode: Exclude<SyncMode, 'disabled'>
  payloadMode: Exclude<SyncMode, 'disabled'>
  finishedAt: string
}

export interface ManagedSyncCommitResult {
  stats: DatasetCommitStats
  job: JobRecord
}

export interface UpsertPluginPackageOptions {
  source: PluginPackageSource
  status?: PluginPackageStatus
  packageHash?: string
  publisherKeyId?: string
  enabled?: boolean
  development?: boolean
}

export interface PluginConfigRecord {
  pluginId: string
  contributionId: string
  publicConfig: Record<string, unknown>
  encryptedSecrets: Record<string, string>
  updatedAt: string
}

export interface PluginContributionRecord {
  pluginId: string
  contributionId: string
  kind: string
  enabled: boolean
  runtime: string
  consecutiveFailures: number
  suspendedReason: string
  updatedAt: string
}

export interface StorageCounts {
  accountCount: number
  contentCount: number
  contentSnapshotCount: number
  accountSnapshotCount: number
  jobCount: number
}

interface AccountRow {
  id: string
  platform_id: PlatformId
  adapter_contribution_id: string | null
  alias: string
  alias_customized: number
  remote_name: string
  remote_id: string | null
  avatar_cache_key: string | null
  avatar_mime: string | null
  bio: string
  creator_level: number | null
  status: AccountStatus
  connection_status: ConnectionStatus
  ownership_status: OwnershipStatus
  sync_enabled: number
  sync_status: SyncStatus
  cooldown_until: string | null
  last_sync_error: string
  ownership_confirmed_at: string | null
  identity_verified_at: string | null
  note: string
  tags_json: string
  session_partition: string
  sync_mode: SyncMode
  is_default: number
  created_at: string
  updated_at: string
  last_synced_at: string | null
}

interface GroupRow {
  id: string
  name: string
  color: string
  sort_order: number
  account_count: number
}

interface ContentRow {
  id: string
  account_id: string
  account_alias: string
  platform_id: PlatformId
  remote_id: string
  type: ContentType
  title: string
  body_excerpt: string
  url: string
  published_at: string | null
  first_captured_at: string
  updated_at: string
  note: string
  tags_json: string
}

interface SnapshotRow {
  views: number | null
  likes: number | null
  comments: number | null
  shares: number | null
  favorites: number | null
  captured_at: string
}

interface AccountSnapshotRow extends SnapshotRow {
  account_id: string
  followers: number | null
  following: number | null
  content_count: number | null
  views_total: number | null
  likes_favorites_total: number | null
}

interface JobRow {
  id: string
  kind: JobKind
  account_id: string
  plugin_id: string
  status: JobStatus
  progress: number
  stage: string
  result_json: string | null
  error_code: string
  error_message: string
  created_at: string
  started_at: string | null
  finished_at: string | null
}

interface PluginRow {
  plugin_id: string
  manifest_json: string
  enabled: number
  availability: 'available' | 'planned' | 'disabled'
  installed_at: string | null
  last_run_at: string | null
  success_count: number
  failure_count: number
  last_error: string
}

/** Read-only bridge used once to migrate a pre-v10 enable flag into Manifest v2. */
export interface LegacyPluginState {
  enabled: boolean
  availability: 'available' | 'planned' | 'disabled'
  installedAt: string | null
  lastRunAt: string | null
  successCount: number
  failureCount: number
  lastError: string
}

interface PluginPackageRow extends PluginRow {
  package_manifest_json: string
  source: PluginPackageSource
  package_status: PluginPackageStatus
  package_hash: string
  publisher_key_id: string
  update_available: string | null
  development: number
  updated_at: string
}

interface PluginScheduleRow {
  id: string
  plugin_id: string
  contribution_id: string
  account_ids_json: string
  group_ids_json: string
  interval_minutes: number
  enabled: number
  next_run_at: string | null
  last_run_at: string | null
  consecutive_failures: number
  suspended_reason: string
  created_at: string
  updated_at: string
}

interface PluginRunRow {
  id: string
  plugin_id: string
  contribution_id: string
  trigger_kind: ExtensionRunRecord['trigger']
  status: ExtensionRunRecord['status']
  account_id: string | null
  event_id: string | null
  attempt: number
  started_at: string | null
  finished_at: string | null
  next_attempt_at: string | null
  error_code: string
  error_message: string
  created_at: string
}

interface PluginEventRow {
  id: string
  type: PluginEventEnvelope['type']
  schema_version: 1
  source_plugin_id: string | null
  account_id: string | null
  content_id: string | null
  payload_json: string
  occurred_at: string
}

interface PluginDeliveryRow {
  id: string
  event_id: string
  plugin_id: string
  contribution_id: string
  status: PluginEventDelivery['status']
  attempt: number
  next_attempt_at: string | null
  error_code: string
  error_message: string
  created_at: string
  updated_at: string
}

export class SocialDatabase {
  private db: DatabaseSync
  readonly databasePath: string

  constructor(path: string) {
    this.databasePath = path
    this.db = openDatabase(path)
  }

  get path(): string {
    return this.databasePath
  }

  close(): void {
    if (this.db.isOpen) this.db.close()
  }

  createBackupImage(): Buffer {
    if (this.databasePath === ':memory:') throw new Error('内存数据库不能创建文件备份')
    checkpointDatabase(this.db)
    const temporaryPath = `${this.databasePath}.portable-backup-${randomUUID()}.tmp`
    try {
      copyFileSync(this.databasePath, temporaryPath)
      const portable = new DatabaseSync(temporaryPath)
      try {
        portable.exec('PRAGMA journal_mode = DELETE; PRAGMA foreign_keys = ON;')
        sanitizePortablePluginState(portable)
      } finally {
        portable.close()
      }
      const size = statSync(temporaryPath).size
      if (size <= 0 || size > 48 * 1024 * 1024) throw new Error('本地数据库超过 48 MB 备份上限')
      return readFileSync(temporaryPath)
    } finally {
      rmSync(temporaryPath, { force: true })
      removeSqliteSidecars(temporaryPath)
    }
  }

  restoreBackupImage(image: Uint8Array, afterReplace?: () => void): void {
    if (this.databasePath === ':memory:') throw new Error('内存数据库不能恢复文件备份')
    const bytes = Buffer.from(image)
    if (bytes.length < 100 || bytes.subarray(0, 16).toString('utf8') !== 'SQLite format 3\0') {
      bytes.fill(0)
      throw new Error('备份中的数据库格式无效')
    }

    const temporaryPath = `${this.databasePath}.restore-${randomUUID()}.tmp`
    const previousPath = `${this.databasePath}.before-restore-${randomUUID()}.tmp`
    let movedCurrent = false
    try {
      writeFileSync(temporaryPath, bytes, { flag: 'wx', mode: 0o600 })
      validateBackupDatabase(temporaryPath)

      checkpointDatabase(this.db)
      this.db.close()
      removeSqliteSidecars(this.databasePath)
      renameSync(this.databasePath, previousPath)
      movedCurrent = true
      renameSync(temporaryPath, this.databasePath)

      this.db = openDatabase(this.databasePath)
      sanitizePortablePluginState(this.db)
      const now = new Date().toISOString()
      this.db.prepare(`
        UPDATE accounts SET connection_status = 'pending', status = 'pending', sync_enabled = 0,
          sync_status = 'idle', cooldown_until = NULL, avatar_cache_key = NULL, avatar_mime = NULL,
          last_sync_error = '备份已恢复，请重新打开官方页面并核验登录身份', updated_at = ?
      `).run(now)
      this.recoverInterruptedJobs()
      afterReplace?.()
      rmSync(previousPath, { force: true })
      movedCurrent = false
    } catch {
      if (this.db.isOpen) this.db.close()
      removeSqliteSidecars(this.databasePath)
      if (movedCurrent && existsSync(previousPath)) {
        rmSync(this.databasePath, { force: true })
        renameSync(previousPath, this.databasePath)
        movedCurrent = false
      }
      this.db = openDatabase(this.databasePath)
      throw new Error('备份恢复失败，原数据库已保留')
    } finally {
      bytes.fill(0)
      rmSync(temporaryPath, { force: true })
      if (movedCurrent) rmSync(previousPath, { force: true })
    }
  }

  getSchemaVersion(): number {
    return readUserVersion(this.db)
  }

  listAccounts(): Account[] {
    const rows = this.db.prepare('SELECT * FROM accounts ORDER BY updated_at DESC').all() as unknown as AccountRow[]
    const latestSnapshots = this.latestAccountSnapshots()
    const groupStatement = this.db.prepare(
      'SELECT group_id FROM account_groups WHERE account_id = ? ORDER BY group_id'
    )
    return rows.map((row) => {
      const groups = groupStatement.all(row.id) as unknown as Array<{ group_id: string }>
      return mapAccount(row, groups.map((item) => item.group_id), latestSnapshots.get(row.id) ?? null)
    })
  }

  getAccount(id: string): Account | null {
    const row = this.db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as unknown as AccountRow | undefined
    if (!row) return null
    const groups = this.db.prepare(
      'SELECT group_id FROM account_groups WHERE account_id = ? ORDER BY group_id'
    ).all(id) as unknown as Array<{ group_id: string }>
    return mapAccount(row, groups.map((item) => item.group_id), this.latestAccountSnapshot(id))
  }

  accountExists(id: string): boolean {
    return this.db.prepare('SELECT 1 FROM accounts WHERE id = ?').get(id) !== undefined
  }

  createAccount(input: CreateAccountInput): Account {
    const id = randomUUID()
    const now = new Date().toISOString()
    const partition = `persist:social:${id}`
    const alias = input.alias ?? ''
    const aliasCustomized = alias.length > 0
    // A newly-created account has neither a verified identity nor a ready login
    // connection. Synchronization is an explicit, per-account authorization that
    // can only be granted after both conditions have been established.
    const syncEnabled = false
    const status = deriveAccountStatus({
      connectionStatus: 'pending',
      syncEnabled,
      syncStatus: 'idle',
      syncMode: input.syncMode
    })
    this.db.prepare(`
      INSERT INTO accounts (
        id, platform_id, adapter_contribution_id, alias, alias_customized, remote_name, remote_id, status, connection_status,
        ownership_status, sync_enabled, sync_status, cooldown_until, last_sync_error,
        ownership_confirmed_at, identity_verified_at, note, tags_json, session_partition, sync_mode, is_default,
        created_at, updated_at, last_synced_at
      ) VALUES (?, ?, ?, ?, ?, '', NULL, ?, 'pending', 'unconfirmed', ?, 'idle', NULL, '',
        NULL, NULL, '', '[]', ?, ?, 0, ?, ?, NULL)
    `).run(
      id, input.platformId, input.adapterContributionId ?? defaultAdapterContributionId(input.platformId), alias,
      aliasCustomized ? 1 : 0, status,
      syncEnabled ? 1 : 0, partition, input.syncMode, now, now
    )
    return requireAccount(this.getAccount(id))
  }

  updateAccount(input: UpdateAccountInput): Account {
    const current = requireAccount(this.getAccount(input.id))
    const alias = input.alias ?? current.alias
    const aliasCustomized = input.alias === undefined
      ? current.aliasCustomized
      : input.alias.length === 0
        ? false
        : input.alias === current.alias
          ? current.aliasCustomized
          : true
    const next = {
      alias,
      aliasCustomized,
      note: input.note ?? current.note,
      tags: input.tags ?? current.tags,
      syncEnabled: input.syncEnabled ?? current.syncEnabled,
      syncMode: input.syncMode ?? current.syncMode,
      isDefault: input.isDefault ?? current.isDefault,
      groupIds: [...new Set(input.groupIds ?? current.groupIds)]
    }
    if (next.syncEnabled && !canEnableManagedSync(current, next.syncMode)) next.syncEnabled = false
    const status = deriveAccountStatus({
      connectionStatus: current.connectionStatus,
      syncEnabled: next.syncEnabled,
      syncStatus: current.syncStatus,
      syncMode: next.syncMode
    })
    const now = new Date().toISOString()

    this.transaction(() => {
      if (next.isDefault) {
        this.db.prepare('UPDATE accounts SET is_default = 0 WHERE platform_id = ?').run(current.platformId)
      }
      this.db.prepare(`
        UPDATE accounts SET alias = ?, alias_customized = ?, note = ?, tags_json = ?, status = ?, sync_enabled = ?,
          sync_mode = ?, is_default = ?, updated_at = ? WHERE id = ?
      `).run(
        next.alias,
        next.aliasCustomized ? 1 : 0,
        next.note,
        JSON.stringify(next.tags),
        status,
        next.syncEnabled ? 1 : 0,
        next.syncMode,
        next.isDefault ? 1 : 0,
        now,
        current.id
      )

      if (input.groupIds !== undefined) {
        this.db.prepare('DELETE FROM account_groups WHERE account_id = ?').run(current.id)
        const insert = this.db.prepare('INSERT INTO account_groups (account_id, group_id) VALUES (?, ?)')
        for (const groupId of next.groupIds) insert.run(current.id, groupId)
      }
      this.enqueuePluginEvent({
        id: randomUUID(),
        type: 'account.updated.v1',
        schemaVersion: 1,
        occurredAt: now,
        source: { app: 'streamfold', pluginId: null },
        subject: { accountId: current.id, contentId: null },
        data: {
          accountId: current.id,
          platformId: current.platformId,
          alias: next.alias,
          note: next.note,
          tags: next.tags,
          groupIds: next.groupIds,
          syncEnabled: next.syncEnabled,
          syncMode: next.syncMode
        }
      })
    })
    return requireAccount(this.getAccount(input.id))
  }

  setAccountAdapterContribution(
    accountId: string,
    contributionId: string,
    expectedContributionId: string | null
  ): Account {
    if (!/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/.test(contributionId)) throw new Error('适配器贡献点 ID 无效')
    const account = requireAccount(this.getAccount(accountId))
    const now = new Date().toISOString()
    const result = this.transaction(() => {
      const updated = this.db.prepare(`
        UPDATE accounts SET adapter_contribution_id = ?, sync_status = 'idle',
          cooldown_until = NULL, last_sync_error = '', updated_at = ?
        WHERE id = ? AND adapter_contribution_id IS ?
      `).run(contributionId, now, accountId, expectedContributionId)
      if (Number(updated.changes) !== 1) throw new Error('账号适配器绑定已变化，请刷新后重试')
      this.enqueuePluginEvent({
        id: randomUUID(),
        type: 'account.updated.v1',
        schemaVersion: 1,
        occurredAt: now,
        source: { app: 'streamfold', pluginId: null },
        subject: { accountId, contentId: null },
        data: {
          accountId,
          platformId: account.platformId,
          adapterContributionId: contributionId,
          previousAdapterContributionId: expectedContributionId
        }
      })
    })
    void result
    return requireAccount(this.getAccount(accountId))
  }

  bulkUpdateAccounts(input: BulkUpdateAccountsInput): Account[] {
    const accountIds = [...new Set(input.accountIds)]
    if (accountIds.length === 0) throw new Error('请至少选择一个账号')
    if (input.groupChange === undefined && input.syncEnabled === undefined) {
      throw new Error('没有需要执行的批量操作')
    }

    const accounts = accountIds.map((id) => requireAccount(this.getAccount(id)))
    if (input.groupChange && !this.db.prepare('SELECT 1 FROM groups WHERE id = ?').get(input.groupChange.groupId)) {
      throw new Error('分组不存在')
    }

    const now = new Date().toISOString()
    this.transaction(() => {
      if (input.groupChange) {
        const { groupId, action } = input.groupChange
        if (action === 'add') {
          const insert = this.db.prepare(
            'INSERT OR IGNORE INTO account_groups (account_id, group_id) VALUES (?, ?)'
          )
          for (const account of accounts) insert.run(account.id, groupId)
        } else {
          const remove = this.db.prepare(
            'DELETE FROM account_groups WHERE account_id = ? AND group_id = ?'
          )
          for (const account of accounts) remove.run(account.id, groupId)
        }
      }

      if (input.syncEnabled !== undefined) {
        const update = this.db.prepare(`
          UPDATE accounts SET sync_enabled = ?, status = ?, updated_at = ? WHERE id = ?
        `)
        for (const account of accounts) {
          const syncEnabled = input.syncEnabled && canEnableManagedSync(account, account.syncMode)
          const status = deriveAccountStatus({
            connectionStatus: account.connectionStatus,
            syncEnabled,
            syncStatus: account.syncStatus,
            syncMode: account.syncMode
          })
          update.run(syncEnabled ? 1 : 0, status, now, account.id)
        }
      } else if (input.groupChange) {
        const touch = this.db.prepare('UPDATE accounts SET updated_at = ? WHERE id = ?')
        for (const account of accounts) touch.run(now, account.id)
      }
    })

    return accountIds.map((id) => requireAccount(this.getAccount(id)))
  }

  disconnectAccount(id: string): Account {
    requireAccount(this.getAccount(id))
    const now = new Date().toISOString()
    this.db.prepare(`
      UPDATE accounts SET connection_status = 'disconnected', sync_enabled = 0,
        sync_status = 'idle', cooldown_until = NULL, last_sync_error = '',
        status = 'paused', updated_at = ? WHERE id = ?
    `).run(now, id)
    return requireAccount(this.getAccount(id))
  }

  beginReconnect(id: string): Account {
    const account = requireAccount(this.getAccount(id))
    if (account.connectionStatus !== 'disconnected') return account
    const now = new Date().toISOString()
    this.db.prepare(`
      UPDATE accounts SET connection_status = 'pending', sync_status = 'idle',
        cooldown_until = NULL, last_sync_error = '', status = 'paused', updated_at = ?
      WHERE id = ? AND connection_status = 'disconnected'
    `).run(now, id)
    return requireAccount(this.getAccount(id))
  }

  applyManagedIdentity(
    accountId: string,
    identity: {
      remoteId: string
      remoteName: string
      avatarCacheKey?: string | null
      avatarMime?: string | null
      bio?: string
      creatorLevel?: number | null
    },
    verifiedAt: string
  ): Account {
    const account = requireAccount(this.getAccount(accountId))
    const duplicate = this.db.prepare(`
      SELECT id FROM accounts WHERE platform_id = ? AND remote_id = ? AND id <> ? LIMIT 1
    `).get(account.platformId, identity.remoteId, accountId) as unknown as { id: string } | undefined
    const mismatch = Boolean(
      account.remoteId && account.remoteId !== identity.remoteId || duplicate
    )
    if (mismatch) {
      this.db.prepare(`
        UPDATE accounts SET connection_status = 'mismatch', status = 'mismatch', sync_enabled = 0,
          sync_status = 'idle', last_sync_error = ?, updated_at = ? WHERE id = ?
      `).run('当前登录身份与本地账号绑定不一致，已停止同步', verifiedAt, accountId)
      return requireAccount(this.getAccount(accountId))
    }

    const status = deriveAccountStatus({
      connectionStatus: 'ready',
      syncEnabled: account.syncEnabled,
      syncStatus: 'idle',
      syncMode: account.syncMode
    })
    const hasAvatarCacheKey = identity.avatarCacheKey !== undefined
    const hasAvatarMime = identity.avatarMime !== undefined
    const hasBio = identity.bio !== undefined
    const hasCreatorLevel = identity.creatorLevel !== undefined
    this.db.prepare(`
      UPDATE accounts SET remote_id = ?, remote_name = ?,
        alias = CASE WHEN alias_customized = 0 THEN ? ELSE alias END,
        avatar_cache_key = CASE WHEN ? = 1 THEN ? ELSE avatar_cache_key END,
        avatar_mime = CASE WHEN ? = 1 THEN ? ELSE avatar_mime END,
        bio = CASE WHEN ? = 1 THEN ? ELSE bio END,
        creator_level = CASE WHEN ? = 1 THEN ? ELSE creator_level END,
        ownership_status = 'plugin_verified',
        identity_verified_at = ?, connection_status = 'ready', status = ?, sync_status = 'idle',
        cooldown_until = NULL, last_sync_error = '', updated_at = ? WHERE id = ?
    `).run(
      identity.remoteId,
      identity.remoteName,
      identity.remoteName,
      hasAvatarCacheKey ? 1 : 0,
      identity.avatarCacheKey ?? null,
      hasAvatarMime ? 1 : 0,
      identity.avatarMime ?? null,
      hasBio ? 1 : 0,
      identity.bio ?? '',
      hasCreatorLevel ? 1 : 0,
      identity.creatorLevel ?? null,
      verifiedAt,
      status,
      verifiedAt,
      accountId
    )
    return requireAccount(this.getAccount(accountId))
  }

  applyManagedProbeStatus(
    accountId: string,
    probeStatus: 'login_required' | 'challenge' | 'page_not_ready' | 'unsupported',
    message: string,
    observedAt: string
  ): Account {
    const account = requireAccount(this.getAccount(accountId))
    if (probeStatus === 'page_not_ready') {
      const status = deriveAccountStatus({
        connectionStatus: account.connectionStatus,
        syncEnabled: account.syncEnabled,
        syncStatus: account.syncStatus,
        syncMode: account.syncMode
      })
      this.db.prepare(`
        UPDATE accounts SET status = ?, last_sync_error = ?, updated_at = ? WHERE id = ?
      `).run(status, message, observedAt, accountId)
      return requireAccount(this.getAccount(accountId))
    }
    const connectionStatus: ConnectionStatus = probeStatus === 'login_required' ? 'expired' : 'pending'
    const syncStatus: SyncStatus = probeStatus === 'challenge'
      ? 'cooldown'
      : probeStatus === 'unsupported' ? 'unsupported' : 'idle'
    const status: AccountStatus = probeStatus === 'login_required'
      ? 'expired'
      : probeStatus === 'challenge' ? 'cooldown' : probeStatus === 'unsupported' ? 'unsupported' : 'paused'
    const cooldownUntil = probeStatus === 'challenge'
      ? new Date(new Date(observedAt).getTime() + 30 * 60_000).toISOString()
      : null
    this.db.prepare(`
      UPDATE accounts SET connection_status = ?, status = ?, sync_enabled = 0, sync_status = ?,
        cooldown_until = ?, last_sync_error = ?, updated_at = ? WHERE id = ?
    `).run(connectionStatus, status, syncStatus, cooldownUntil, message, observedAt, accountId)
    return requireAccount(this.getAccount(accountId))
  }

  markManagedIdentityMismatch(accountId: string, message: string, observedAt: string): Account {
    if (!isIsoDate(observedAt)) throw new Error('身份异常时间无效')
    requireAccount(this.getAccount(accountId))
    this.db.prepare(`
      UPDATE accounts SET connection_status = 'mismatch', status = 'mismatch', sync_enabled = 0,
        sync_status = 'idle', cooldown_until = NULL, last_sync_error = ?, updated_at = ?
      WHERE id = ?
    `).run(safeSyncErrorMessage(message), observedAt, accountId)
    return requireAccount(this.getAccount(accountId))
  }

  /** Permanently deletes the account and all data owned by it. */
  removeAccount(id: string): void {
    this.db.prepare('DELETE FROM accounts WHERE id = ?').run(id)
  }

  listGroups(): Group[] {
    const rows = this.db.prepare(`
      SELECT g.id, g.name, g.color, g.sort_order, COUNT(ag.account_id) AS account_count
      FROM groups g LEFT JOIN account_groups ag ON ag.group_id = g.id
      GROUP BY g.id ORDER BY g.sort_order, g.name
    `).all() as unknown as GroupRow[]
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      color: row.color,
      sortOrder: Number(row.sort_order),
      accountCount: Number(row.account_count)
    }))
  }

  createGroup(input: CreateGroupInput): Group {
    const id = randomUUID()
    const row = this.db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS max_order FROM groups').get() as unknown as { max_order: number }
    this.db.prepare(
      'INSERT INTO groups (id, name, color, sort_order, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(id, input.name, input.color, Number(row.max_order) + 10, new Date().toISOString())
    const group = this.listGroups().find((item) => item.id === id)
    if (!group) throw new Error('创建分组失败')
    return group
  }

  updateGroup(input: UpdateGroupInput): Group {
    const current = this.listGroups().find((group) => group.id === input.id)
    if (!current) throw new Error('分组不存在')
    const name = input.name ?? current.name
    const color = input.color ?? current.color
    this.db.prepare('UPDATE groups SET name = ?, color = ? WHERE id = ?').run(name, color, input.id)
    const group = this.listGroups().find((item) => item.id === input.id)
    if (!group) throw new Error('更新分组失败')
    return group
  }

  moveGroup(input: MoveGroupInput): Group[] {
    const groups = this.listGroups()
    const index = groups.findIndex((group) => group.id === input.id)
    if (index < 0) throw new Error('分组不存在')
    const targetIndex = input.direction === 'up' ? index - 1 : index + 1
    if (targetIndex < 0 || targetIndex >= groups.length) return groups
    const reordered = [...groups]
    const moving = reordered[index]!
    reordered.splice(index, 1)
    reordered.splice(targetIndex, 0, moving)
    this.transaction(() => {
      const update = this.db.prepare('UPDATE groups SET sort_order = ? WHERE id = ?')
      reordered.forEach((group, order) => update.run((order + 1) * 10, group.id))
    })
    return this.listGroups()
  }

  removeGroup(id: string): void {
    this.db.prepare('DELETE FROM groups WHERE id = ?').run(id)
  }

  private latestAccountSnapshots(accountId?: string): Map<string, AccountSnapshot> {
    const rows = this.db.prepare(`
      WITH ranked AS (
        SELECT account_id, followers, following, content_count, views_total,
          likes_favorites_total, views, likes, comments, shares, favorites, captured_at,
          ROW_NUMBER() OVER (
            PARTITION BY account_id ORDER BY captured_at DESC, id DESC
          ) AS snapshot_rank
        FROM account_snapshots
        ${accountId ? 'WHERE account_id = ?' : ''}
      )
      SELECT account_id, followers, following, content_count, views_total,
        likes_favorites_total, views, likes, comments, shares, favorites, captured_at
      FROM ranked WHERE snapshot_rank = 1
    `).all(...(accountId ? [accountId] : [])) as unknown as AccountSnapshotRow[]
    return new Map(rows.map((row) => [row.account_id, mapAccountSnapshot(row)]))
  }

  private latestAccountSnapshot(accountId: string): AccountSnapshot | null {
    return this.latestAccountSnapshots(accountId).get(accountId) ?? null
  }

  listAccountSnapshots(accountId?: string): AccountSnapshot[] {
    const rows = this.db.prepare(`
      SELECT account_id, followers, following, content_count, views_total, likes_favorites_total,
        views, likes, comments, shares, favorites, captured_at
      FROM account_snapshots
      ${accountId ? 'WHERE account_id = ?' : ''}
      ORDER BY captured_at ASC
    `).all(...(accountId ? [accountId] : [])) as unknown as AccountSnapshotRow[]
    return rows.map(mapAccountSnapshot)
  }

  listContents(query: ContentQuery = {}): ContentSummary[] {
    const where: string[] = []
    const parameters: Array<string | number> = []
    if (query.accountId) {
      where.push('c.account_id = ?')
      parameters.push(query.accountId)
    }
    if (query.platformId) {
      where.push('a.platform_id = ?')
      parameters.push(query.platformId)
    }
    if (query.type) {
      where.push('c.type = ?')
      parameters.push(query.type)
    }
    if (query.query?.trim()) {
      where.push("(c.title LIKE ? OR c.body_excerpt LIKE ? OR c.note LIKE ? OR c.tags_json LIKE ?)")
      const pattern = `%${query.query.trim()}%`
      parameters.push(pattern, pattern, pattern, pattern)
    }
    if (query.from) {
      where.push('COALESCE(c.published_at, c.first_captured_at) >= ?')
      parameters.push(query.from)
    }
    if (query.to) {
      where.push('COALESCE(c.published_at, c.first_captured_at) <= ?')
      parameters.push(query.to)
    }
    const limit = clampInteger(query.limit ?? 100, 1, 5000)
    const offset = clampInteger(query.offset ?? 0, 0, 1_000_000_000)
    parameters.push(limit, offset)
    const rows = this.db.prepare(`
      SELECT c.*, a.alias AS account_alias, a.platform_id
      FROM contents c JOIN accounts a ON a.id = c.account_id
      ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY COALESCE(c.published_at, c.first_captured_at) DESC, c.updated_at DESC
      LIMIT ? OFFSET ?
    `).all(...parameters) as unknown as ContentRow[]
    return rows.map((row) => this.mapContent(row))
  }

  getContentDetail(id: string): ContentDetail {
    const row = this.getContentRow(id)
    if (!row) throw new Error('内容不存在')
    const summary = this.mapContent(row)
    const snapshots = this.listContentSnapshots(id, 'ASC')
    return { ...summary, snapshots }
  }

  updateContent(input: UpdateContentInput): ContentDetail {
    if (!this.getContentRow(input.id)) throw new Error('内容不存在')
    const current = this.getContentDetail(input.id)
    const now = new Date().toISOString()
    this.transaction(() => {
      this.db.prepare(`
        UPDATE contents SET note = ?, tags_json = ?, updated_at = ? WHERE id = ?
      `).run(
        input.note ?? current.note,
        JSON.stringify(input.tags ?? current.tags),
        now,
        input.id
      )
      this.enqueuePluginEvent({
        id: randomUUID(),
        type: 'content.updated.v1',
        schemaVersion: 1,
        occurredAt: now,
        source: { app: 'streamfold', pluginId: null },
        subject: { accountId: current.accountId, contentId: current.id },
        data: {
          accountId: current.accountId,
          contentId: current.id,
          remoteId: current.remoteId,
          note: input.note ?? current.note,
          tags: input.tags ?? current.tags
        }
      })
    })
    return this.getContentDetail(input.id)
  }

  clearAccountData(accountId: string): void {
    const account = requireAccount(this.getAccount(accountId))
    const status = deriveAccountStatus({
      connectionStatus: account.connectionStatus,
      syncEnabled: account.syncEnabled,
      syncStatus: 'idle',
      syncMode: account.syncMode
    })
    this.transaction(() => {
      this.db.prepare('DELETE FROM account_snapshots WHERE account_id = ?').run(accountId)
      this.db.prepare('DELETE FROM contents WHERE account_id = ?').run(accountId)
      this.db.prepare('DELETE FROM jobs WHERE account_id = ?').run(accountId)
      this.db.prepare('DELETE FROM sync_cursors WHERE account_id = ?').run(accountId)
      this.db.prepare(`
        UPDATE accounts SET last_synced_at = NULL, sync_status = 'idle', cooldown_until = NULL,
          last_sync_error = '', status = ?, updated_at = ? WHERE id = ?
      `).run(status, new Date().toISOString(), accountId)
    })
  }

  markManagedSyncStarted(accountId: string, startedAt: string): Account {
    if (!isIsoDate(startedAt)) throw new Error('受管同步开始时间无效')
    const account = requireManagedSyncAccount(this.getAccount(accountId))
    const status = deriveAccountStatus({
      connectionStatus: account.connectionStatus,
      syncEnabled: account.syncEnabled,
      syncStatus: 'running',
      syncMode: account.syncMode
    })
    this.db.prepare(`
      UPDATE accounts SET sync_status = 'running', cooldown_until = NULL,
        last_sync_error = '', status = ?, updated_at = ? WHERE id = ?
    `).run(status, startedAt, account.id)
    return requireAccount(this.getAccount(account.id))
  }

  markManagedSyncFailed(accountId: string, message: string, failedAt: string): Account {
    if (!isIsoDate(failedAt)) throw new Error('受管同步失败时间无效')
    const account = requireAccount(this.getAccount(accountId))
    const status = deriveAccountStatus({
      connectionStatus: account.connectionStatus,
      syncEnabled: account.syncEnabled,
      syncStatus: 'failed',
      syncMode: account.syncMode
    })
    this.db.prepare(`
      UPDATE accounts SET sync_status = 'failed', cooldown_until = NULL,
        last_sync_error = ?, status = ?, updated_at = ? WHERE id = ?
    `).run(safeSyncErrorMessage(message), status, failedAt, account.id)
    return requireAccount(this.getAccount(account.id))
  }

  commitManagedSync(
    payload: StandardDataset,
    metadata: ManagedSyncCommitMetadata
  ): ManagedSyncCommitResult {
    validateManagedSync(payload, metadata)
    return this.transaction(() => {
      const account = requireManagedSyncAccount(this.getAccount(metadata.accountId))
      const profile = payload.profile
      if (!profile) throw new Error('受管同步结果缺少本人账号资料')
      if (profile.remoteId !== account.remoteId) throw new Error('受管同步身份与已绑定账号不一致')
      if (account.syncMode !== metadata.authorizedMode) throw new Error('同步期间授权范围已变化，请重新同步')
      const job = requireJob(this.getJob(metadata.jobId))
      if (
        job.kind !== 'managed_sync' || job.accountId !== account.id ||
        job.pluginId !== metadata.pluginId || job.status !== 'committing'
      ) throw new Error('受管同步任务状态已变更')
      const installedPackage = this.getInstalledPluginPackage(metadata.pluginId)
      if (installedPackage) {
        const adapterId = account.adapterContributionId
        const declared = adapterId && installedPackage.manifest.contributions.some((contribution) => (
          contribution.kind === 'platform.adapter' && contribution.id === adapterId &&
          contribution.platform.id === account.platformId
        ))
        const contributionState = adapterId
          ? this.db.prepare(`
              SELECT enabled, suspended_reason FROM plugin_contributions
              WHERE plugin_id = ? AND contribution_id = ?
            `).get(metadata.pluginId, adapterId) as unknown as { enabled: number; suspended_reason: string } | undefined
          : undefined
        if (installedPackage.status !== 'active' || !installedPackage.enabled || !declared ||
          !contributionState?.enabled || contributionState.suspended_reason) {
          throw new Error('同步期间插件或账号适配器已停用，未写入任何数据')
        }
      } else throw new Error('同步期间插件包不可用，未写入任何数据')

      const now = new Date().toISOString()
      const status = deriveAccountStatus({
        connectionStatus: account.connectionStatus,
        syncEnabled: account.syncEnabled,
        syncStatus: 'idle',
        syncMode: account.syncMode
      })
      const hasAvatarCacheKey = profile.avatarCacheKey !== undefined
      const hasAvatarMime = profile.avatarMime !== undefined
      const hasBio = profile.bio !== undefined
      const hasCreatorLevel = profile.creatorLevel !== undefined
      this.db.prepare(`
        UPDATE accounts SET remote_name = ?,
          alias = CASE WHEN alias_customized = 0 THEN ? ELSE alias END,
          avatar_cache_key = CASE WHEN ? = 1 THEN ? ELSE avatar_cache_key END,
          avatar_mime = CASE WHEN ? = 1 THEN ? ELSE avatar_mime END,
          bio = CASE WHEN ? = 1 THEN ? ELSE bio END,
          creator_level = CASE WHEN ? = 1 THEN ? ELSE creator_level END,
          identity_verified_at = ?, sync_status = 'idle', cooldown_until = NULL,
          last_sync_error = '', status = ?, last_synced_at = ?,
          updated_at = ? WHERE id = ?
      `).run(
        profile.remoteName,
        profile.remoteName,
        hasAvatarCacheKey ? 1 : 0,
        profile.avatarCacheKey ?? null,
        hasAvatarMime ? 1 : 0,
        profile.avatarMime ?? null,
        hasBio ? 1 : 0,
        profile.bio ?? '',
        hasCreatorLevel ? 1 : 0,
        profile.creatorLevel ?? null,
        metadata.finishedAt,
        status,
        payload.capturedAt,
        now,
        account.id
      )
      this.insertAccountSnapshot(account.id, profile, payload.capturedAt)
      const stats = this.writeStandardContents(account.id, payload.contents, payload.capturedAt, now)
      const resultJson = JSON.stringify({ ...stats, warnings: payload.warnings })
      const jobUpdate = this.db.prepare(`
        UPDATE jobs SET status = 'succeeded', progress = 100, stage = '只读同步完成',
          result_json = ?, error_code = '', error_message = '', finished_at = ?
        WHERE id = ? AND status = 'committing' AND kind = 'managed_sync'
          AND account_id = ? AND plugin_id = ?
      `).run(resultJson, metadata.finishedAt, job.id, account.id, metadata.pluginId)
      if (Number(jobUpdate.changes) !== 1) throw new Error('受管同步任务状态已变更')
      const pluginUpdate = this.db.prepare(`
        UPDATE plugin_installations SET last_run_at = ?, success_count = success_count + 1,
          last_error = '', updated_at = ?
        WHERE plugin_id = ? AND enabled = 1 AND (
          (package_manifest_json <> '{}' AND package_status = 'active') OR
          (package_manifest_json = '{}' AND availability = 'available')
        )
      `).run(metadata.finishedAt, metadata.finishedAt, metadata.pluginId)
      if (Number(pluginUpdate.changes) !== 1) throw new Error('同步期间插件已停用，未写入任何数据')
      this.enqueuePluginEvent({
        id: randomUUID(),
        type: 'sync.completed.v1',
        schemaVersion: 1,
        occurredAt: metadata.finishedAt,
        source: { app: 'streamfold', pluginId: metadata.pluginId },
        subject: { accountId: account.id, contentId: null },
        data: {
          accountId: account.id,
          platformId: account.platformId,
          adapterContributionId: account.adapterContributionId,
          capturedAt: payload.capturedAt,
          profile,
          contents: payload.contents,
          warnings: payload.warnings,
          stats
        }
      })
      return { stats, job: requireJob(this.getJob(job.id)) }
    })
  }

  private insertAccountSnapshot(
    accountId: string,
    profile: StandardProfile,
    capturedAt: string
  ): void {
    this.db.prepare(`
      INSERT INTO account_snapshots (
        id, account_id, followers, following, content_count, views_total, likes_favorites_total,
        views, likes, comments, shares, favorites, captured_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id, captured_at) DO NOTHING
    `).run(
      randomUUID(), accountId, profile.followers, profile.following,
      profile.contentCount, profile.viewsTotal, profile.likesAndFavoritesTotal ?? null,
      profile.views ?? null, profile.likes ?? null, profile.comments ?? null,
      profile.shares ?? null, profile.favorites ?? null, capturedAt
    )
  }

  private writeStandardContents(
    accountId: string,
    sourceContents: StandardContent[],
    firstCapturedAt: string,
    updatedAt: string
  ): DatasetCommitStats {
    let newContentCount = 0
    let updatedContentCount = 0
    let snapshotCount = 0
    let skippedSnapshotCount = 0
    const contents = dedupeStandardContents(sourceContents)
    const findContent = this.db.prepare('SELECT id FROM contents WHERE account_id = ? AND remote_id = ?')
    const insertContent = this.db.prepare(`
      INSERT INTO contents (
        id, account_id, remote_id, type, title, body_excerpt, url, published_at,
        first_captured_at, updated_at, note, tags_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', '[]')
    `)
    const updateExistingContent = this.db.prepare(`
      UPDATE contents SET type = ?, title = ?, body_excerpt = ?, url = ?, published_at = ?,
        updated_at = ? WHERE id = ?
    `)
    const insertSnapshot = this.db.prepare(`
      INSERT INTO content_snapshots (
        id, content_id, views, likes, comments, shares, favorites, captured_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(content_id, captured_at) DO NOTHING
    `)
    const findLatestSnapshot = this.db.prepare(`
      SELECT views, likes, comments, shares, favorites, captured_at
      FROM content_snapshots
      WHERE content_id = ?
      ORDER BY captured_at DESC, id DESC
      LIMIT 1
    `)

    for (const content of contents) {
      const existing = findContent.get(accountId, content.remoteId) as unknown as { id: string } | undefined
      const contentId = existing?.id ?? randomUUID()
      if (existing) {
        updatedContentCount += 1
        updateExistingContent.run(
          content.type, content.title, content.bodyExcerpt, content.url,
          content.publishedAt, updatedAt, contentId
        )
      } else {
        newContentCount += 1
        insertContent.run(
          contentId, accountId, content.remoteId, content.type, content.title,
          content.bodyExcerpt, content.url, content.publishedAt, firstCapturedAt, updatedAt
        )
      }
      for (const snapshot of content.snapshots) {
        const latest = findLatestSnapshot.get(contentId) as unknown as SnapshotRow | undefined
        if (latest && sameSnapshotMetrics(latest, snapshot)) {
          skippedSnapshotCount += 1
          continue
        }
        const result = insertSnapshot.run(
          randomUUID(), contentId, snapshot.views, snapshot.likes, snapshot.comments,
          snapshot.shares, snapshot.favorites, snapshot.capturedAt
        )
        if (Number(result.changes) === 1) snapshotCount += 1
        else skippedSnapshotCount += 1
      }
    }

    return { newContentCount, updatedContentCount, snapshotCount, skippedSnapshotCount }
  }

  createJob(input: CreateJobInput): JobRecord {
    requireAccount(this.getAccount(input.accountId))
    const id = input.id ?? randomUUID()
    const now = input.createdAt ?? new Date().toISOString()
    const status = input.status ?? 'queued'
    this.db.prepare(`
      INSERT INTO jobs (
        id, kind, account_id, plugin_id, status, progress, stage, result_json,
        error_code, error_message, created_at, started_at, finished_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.kind,
      input.accountId,
      input.pluginId,
      status,
      clampInteger(input.progress ?? 0, 0, 100),
      input.stage ?? '',
      input.result === undefined || input.result === null ? null : JSON.stringify(input.result),
      input.errorCode ?? '',
      input.errorMessage ?? '',
      now,
      input.startedAt ?? (isActiveJob(status) ? now : null),
      input.finishedAt ?? (isTerminalJob(status) ? now : null)
    )
    return requireJob(this.getJob(id))
  }

  listJobs(): JobRecord[] {
    const rows = this.db.prepare('SELECT * FROM jobs ORDER BY created_at DESC').all() as unknown as JobRow[]
    return rows.map(mapJob)
  }

  getJob(id: string): JobRecord | null {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as unknown as JobRow | undefined
    return row ? mapJob(row) : null
  }

  updateJob(id: string, patch: UpdateJobInput, expectedStatuses?: readonly JobStatus[]): JobRecord {
    const current = requireJob(this.getJob(id))
    if (expectedStatuses !== undefined && expectedStatuses.length === 0) {
      throw new Error('任务状态已变更')
    }
    const status = patch.status ?? current.status
    const startedAt = patch.startedAt === undefined
      ? (current.startedAt ?? (isActiveJob(status) ? new Date().toISOString() : null))
      : patch.startedAt
    const finishedAt = patch.finishedAt === undefined
      ? (current.finishedAt ?? (isTerminalJob(status) ? new Date().toISOString() : null))
      : patch.finishedAt
    const expectedClause = expectedStatuses === undefined
      ? ''
      : ` AND status IN (${expectedStatuses.map(() => '?').join(', ')})`
    const result = this.db.prepare(`
      UPDATE jobs SET kind = ?, account_id = ?, plugin_id = ?, status = ?, progress = ?,
        stage = ?, result_json = ?, error_code = ?, error_message = ?, started_at = ?,
        finished_at = ? WHERE id = ?${expectedClause}
    `).run(
      patch.kind ?? current.kind,
      patch.accountId ?? current.accountId,
      patch.pluginId ?? current.pluginId,
      status,
      clampInteger(patch.progress ?? current.progress, 0, 100),
      patch.stage ?? current.stage,
      patch.result === undefined
        ? (current.result === null ? null : JSON.stringify(current.result))
        : (patch.result === null ? null : JSON.stringify(patch.result)),
      patch.errorCode ?? current.errorCode,
      patch.errorMessage ?? current.errorMessage,
      startedAt,
      finishedAt,
      id,
      ...(expectedStatuses ?? [])
    )
    if (Number(result.changes) !== 1) throw new Error('任务状态已变更')
    return requireJob(this.getJob(id))
  }

  recoverInterruptedJobs(): JobRecord[] {
    const rows = this.db.prepare(`
      SELECT id FROM jobs WHERE status IN ('queued', 'validating', 'committing')
    `).all() as unknown as Array<{ id: string }>
    if (rows.length === 0) return []
    const now = new Date().toISOString()
    this.db.prepare(`
      UPDATE jobs SET status = 'interrupted', error_code = 'APP_RESTARTED',
        error_message = '应用退出时任务尚未完成', finished_at = ?
      WHERE status IN ('queued', 'validating', 'committing')
    `).run(now)
    return rows.map(({ id }) => requireJob(this.getJob(id)))
  }

  getPluginState(id: string): LegacyPluginState | null {
    const row = this.db.prepare('SELECT * FROM plugin_installations WHERE plugin_id = ?').get(id) as unknown as PluginRow | undefined
    return row ? mapPlugin(row) : null
  }

  upsertPluginPackage(
    manifest: PluginManifestV2,
    options: UpsertPluginPackageOptions
  ): InstalledPluginPackage {
    const current = this.getInstalledPluginPackage(manifest.id)
    const now = new Date().toISOString()
    const installedAt = current?.installedAt ?? now
    const enabled = options.enabled ?? current?.enabled ?? false
    const status = options.status ?? current?.status ?? 'active'
    const packageHash = options.packageHash ?? current?.packageHash ?? ''
    const publisherKeyId = options.publisherKeyId ?? manifest.publisher.keyId
    const development = options.development ?? options.source === 'local_development'
    const enableNewContributions = enabled && current === null
    this.transaction(() => {
      this.db.prepare(`
        INSERT INTO plugin_installations (
          plugin_id, manifest_json, package_manifest_json, enabled, availability,
          installed_at, last_run_at, success_count, failure_count, last_error,
          source, package_status, package_hash, publisher_key_id, update_available,
          development, updated_at
        ) VALUES (?, '{}', ?, ?, 'available', ?, NULL, 0, 0, '', ?, ?, ?, ?, NULL, ?, ?)
        ON CONFLICT(plugin_id) DO UPDATE SET
          package_manifest_json = excluded.package_manifest_json,
          enabled = excluded.enabled,
          source = excluded.source,
          package_status = excluded.package_status,
          package_hash = excluded.package_hash,
          publisher_key_id = excluded.publisher_key_id,
          development = excluded.development,
          updated_at = excluded.updated_at
      `).run(
        manifest.id,
        JSON.stringify(manifest),
        enabled ? 1 : 0,
        installedAt,
        options.source,
        status,
        packageHash,
        publisherKeyId,
        development ? 1 : 0,
        now
      )
      const contributionIds = manifest.contributions.map((contribution) => contribution.id)
      for (const contribution of manifest.contributions) {
        this.db.prepare(`
          INSERT INTO plugin_contributions (
            plugin_id, contribution_id, kind, manifest_json, enabled, runtime,
            consecutive_failures, suspended_reason, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 0, '', ?)
          ON CONFLICT(plugin_id, contribution_id) DO UPDATE SET
            kind = excluded.kind,
            manifest_json = excluded.manifest_json,
            runtime = excluded.runtime,
            updated_at = excluded.updated_at
        `).run(
          manifest.id,
          contribution.id,
          contribution.kind,
          JSON.stringify(contribution),
          enableNewContributions ? 1 : 0,
          contribution.runtime,
          now
        )
      }
      const existing = this.db.prepare(`
        SELECT contribution_id FROM plugin_contributions WHERE plugin_id = ?
      `).all(manifest.id) as unknown as Array<{ contribution_id: string }>
      for (const row of existing) {
        if (!contributionIds.includes(row.contribution_id)) {
          this.db.prepare(`
            DELETE FROM plugin_contributions WHERE plugin_id = ? AND contribution_id = ?
          `).run(manifest.id, row.contribution_id)
        }
      }
    })
    return requireInstalledPlugin(this.getInstalledPluginPackage(manifest.id))
  }

  listInstalledPluginPackages(): InstalledPluginPackage[] {
    const rows = this.db.prepare(`
      SELECT * FROM plugin_installations
      WHERE package_manifest_json <> '{}'
      ORDER BY plugin_id
    `).all() as unknown as PluginPackageRow[]
    return rows.map(mapInstalledPlugin)
  }

  getInstalledPluginPackage(pluginId: string): InstalledPluginPackage | null {
    const row = this.db.prepare(`
      SELECT * FROM plugin_installations
      WHERE plugin_id = ? AND package_manifest_json <> '{}'
    `).get(pluginId) as unknown as PluginPackageRow | undefined
    return row ? mapInstalledPlugin(row) : null
  }

  setPluginPackageStatus(pluginId: string, status: PluginPackageStatus, error = ''): InstalledPluginPackage {
    if (!this.getInstalledPluginPackage(pluginId)) throw new Error('插件包不存在')
    const enabled = status === 'active' ? undefined : 0
    this.transaction(() => {
      this.db.prepare(`
        UPDATE plugin_installations SET package_status = ?,
          enabled = COALESCE(?, enabled), last_error = ?, updated_at = ?
        WHERE plugin_id = ?
      `).run(status, enabled ?? null, error.slice(0, 300), new Date().toISOString(), pluginId)
      if (status !== 'active') {
        this.db.prepare(`
          UPDATE plugin_contributions SET enabled = 0, suspended_reason = ?, updated_at = ?
          WHERE plugin_id = ?
        `).run(error.slice(0, 300) || status, new Date().toISOString(), pluginId)
        this.db.prepare(`
          UPDATE plugin_schedules SET enabled = 0, suspended_reason = ?, updated_at = ?
          WHERE plugin_id = ?
        `).run(error.slice(0, 300) || status, new Date().toISOString(), pluginId)
      }
    })
    return requireInstalledPlugin(this.getInstalledPluginPackage(pluginId))
  }

  setPluginUpdateAvailable(pluginId: string, version: string | null): void {
    if (version !== null && !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
      throw new Error('插件更新版本无效')
    }
    const result = this.db.prepare(`
      UPDATE plugin_installations SET update_available = ?, updated_at = ? WHERE plugin_id = ?
    `).run(version, new Date().toISOString(), pluginId)
    if (Number(result.changes) !== 1) throw new Error('插件包不存在')
  }

  removePluginPackage(pluginId: string): void {
    const installed = requireInstalledPlugin(this.getInstalledPluginPackage(pluginId))
    if (installed.source === 'builtin') throw new Error('内置插件不能卸载')
    const now = new Date().toISOString()
    this.transaction(() => {
      this.db.prepare(`
        UPDATE accounts SET sync_enabled = 0, sync_status = 'unsupported', status = 'unsupported',
          cooldown_until = NULL, last_sync_error = '账号适配器不可用', updated_at = ?
        WHERE adapter_contribution_id IN (
          SELECT contribution_id FROM plugin_contributions WHERE plugin_id = ?
        )
      `).run(now, pluginId)
      const result = this.db.prepare(`
        DELETE FROM plugin_installations WHERE plugin_id = ? AND source <> 'builtin'
      `).run(pluginId)
      if (Number(result.changes) !== 1) throw new Error('插件包不存在或不能卸载')
    })
  }

  setPluginPackageEnabled(pluginId: string, enabled: boolean): InstalledPluginPackage {
    const current = requireInstalledPlugin(this.getInstalledPluginPackage(pluginId))
    if (enabled && current.status !== 'active') throw new Error('插件包当前不能启用')
    const now = new Date().toISOString()
    this.transaction(() => {
      this.db.prepare(`
        UPDATE plugin_installations SET enabled = ?, updated_at = ? WHERE plugin_id = ?
      `).run(enabled ? 1 : 0, now, pluginId)
      if (!enabled) {
        this.db.prepare(`
          UPDATE plugin_contributions SET enabled = 0, updated_at = ? WHERE plugin_id = ?
        `).run(now, pluginId)
        this.db.prepare(`
          UPDATE plugin_schedules SET enabled = 0, suspended_reason = '插件已停用', updated_at = ?
          WHERE plugin_id = ?
        `).run(now, pluginId)
      }
    })
    return requireInstalledPlugin(this.getInstalledPluginPackage(pluginId))
  }

  setPluginContributionEnabled(pluginId: string, contributionId: string, enabled: boolean): void {
    const result = this.db.prepare(`
      UPDATE plugin_contributions SET enabled = ?, suspended_reason = '', updated_at = ?
      WHERE plugin_id = ? AND contribution_id = ?
        AND EXISTS (
          SELECT 1 FROM plugin_installations p
          WHERE p.plugin_id = plugin_contributions.plugin_id
            AND p.package_status = 'active' AND p.enabled = 1
        )
    `).run(enabled ? 1 : 0, new Date().toISOString(), pluginId, contributionId)
    if (Number(result.changes) !== 1) throw new Error('贡献点不存在、插件未启用或已被停用')
  }

  suspendPluginContributions(pluginId: string, contributionIds: string[], reason: string): void {
    const ids = [...new Set(contributionIds)]
    if (ids.length === 0) return
    if (ids.some((id) => !/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/.test(id))) {
      throw new Error('贡献点 ID 无效')
    }
    const safeReason = reason.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 300)
    const now = new Date().toISOString()
    this.transaction(() => {
      const suspendContribution = this.db.prepare(`
        UPDATE plugin_contributions SET enabled = 0, suspended_reason = ?, updated_at = ?
        WHERE plugin_id = ? AND contribution_id = ?
      `)
      const suspendSchedules = this.db.prepare(`
        UPDATE plugin_schedules SET enabled = 0, next_run_at = NULL,
          suspended_reason = ?, updated_at = ?
        WHERE plugin_id = ? AND contribution_id = ?
      `)
      for (const id of ids) {
        suspendContribution.run(safeReason, now, pluginId, id)
        suspendSchedules.run(safeReason, now, pluginId, id)
      }
    })
  }

  listPluginContributionRecords(pluginId?: string): PluginContributionRecord[] {
    const rows = (pluginId
      ? this.db.prepare('SELECT * FROM plugin_contributions WHERE plugin_id = ? ORDER BY contribution_id').all(pluginId)
      : this.db.prepare('SELECT * FROM plugin_contributions ORDER BY plugin_id, contribution_id').all()
    ) as unknown as Array<{
      plugin_id: string
      contribution_id: string
      kind: string
      enabled: number
      runtime: string
      consecutive_failures: number
      suspended_reason: string
      updated_at: string
    }>
    return rows.map((row) => ({
      pluginId: row.plugin_id,
      contributionId: row.contribution_id,
      kind: row.kind,
      enabled: Boolean(row.enabled),
      runtime: row.runtime,
      consecutiveFailures: Number(row.consecutive_failures),
      suspendedReason: row.suspended_reason,
      updatedAt: row.updated_at
    }))
  }

  upsertPluginGrant(grant: PluginGrant): PluginGrant {
    const now = new Date().toISOString()
    const grantedAt = grant.grantedAt || now
    this.db.prepare(`
      INSERT INTO plugin_grants (
        plugin_id, contribution_id, permissions_json, account_ids_json, group_ids_json,
        data_scopes_json, network_origins_json, granted_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(plugin_id, contribution_id) DO UPDATE SET
        permissions_json = excluded.permissions_json,
        account_ids_json = excluded.account_ids_json,
        group_ids_json = excluded.group_ids_json,
        data_scopes_json = excluded.data_scopes_json,
        network_origins_json = excluded.network_origins_json,
        updated_at = excluded.updated_at
    `).run(
      grant.pluginId,
      grant.contributionId,
      JSON.stringify([...new Set(grant.permissions)]),
      JSON.stringify([...new Set(grant.accountIds)]),
      JSON.stringify([...new Set(grant.groupIds)]),
      JSON.stringify([...new Set(grant.dataScopes)]),
      JSON.stringify([...new Set(grant.networkOrigins)]),
      grantedAt,
      now
    )
    return requireGrant(this.getPluginGrant(grant.pluginId, grant.contributionId))
  }

  getPluginGrant(pluginId: string, contributionId: string): PluginGrant | null {
    const row = this.db.prepare(`
      SELECT * FROM plugin_grants WHERE plugin_id = ? AND contribution_id = ?
    `).get(pluginId, contributionId) as unknown as Record<string, unknown> | undefined
    return row ? mapGrant(row) : null
  }

  savePluginConfig(record: Omit<PluginConfigRecord, 'updatedAt'>): PluginConfigRecord {
    const now = new Date().toISOString()
    this.db.prepare(`
      INSERT INTO plugin_configs (
        plugin_id, contribution_id, public_json, encrypted_secrets_json, updated_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(plugin_id, contribution_id) DO UPDATE SET
        public_json = excluded.public_json,
        encrypted_secrets_json = excluded.encrypted_secrets_json,
        updated_at = excluded.updated_at
    `).run(
      record.pluginId,
      record.contributionId,
      JSON.stringify(record.publicConfig),
      JSON.stringify(record.encryptedSecrets),
      now
    )
    return requirePluginConfig(this.getPluginConfig(record.pluginId, record.contributionId))
  }

  getPluginConfig(pluginId: string, contributionId: string): PluginConfigRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM plugin_configs WHERE plugin_id = ? AND contribution_id = ?
    `).get(pluginId, contributionId) as unknown as {
      plugin_id: string
      contribution_id: string
      public_json: string
      encrypted_secrets_json: string
      updated_at: string
    } | undefined
    return row ? {
      pluginId: row.plugin_id,
      contributionId: row.contribution_id,
      publicConfig: safeObject(row.public_json) ?? {},
      encryptedSecrets: safeStringRecord(row.encrypted_secrets_json),
      updatedAt: row.updated_at
    } : null
  }

  createPluginSchedule(input: Omit<PluginSchedule, 'id' | 'createdAt' | 'updatedAt'>): PluginSchedule {
    const id = randomUUID()
    const now = new Date().toISOString()
    this.db.prepare(`
      INSERT INTO plugin_schedules (
        id, plugin_id, contribution_id, account_ids_json, group_ids_json,
        interval_minutes, enabled, next_run_at, last_run_at, consecutive_failures,
        suspended_reason, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.pluginId,
      input.contributionId,
      JSON.stringify([...new Set(input.accountIds)]),
      JSON.stringify([...new Set(input.groupIds)]),
      input.intervalMinutes,
      input.enabled ? 1 : 0,
      input.nextRunAt,
      input.lastRunAt,
      input.consecutiveFailures,
      input.suspendedReason,
      now,
      now
    )
    return requireSchedule(this.getPluginSchedule(id))
  }

  getPluginSchedule(id: string): PluginSchedule | null {
    const row = this.db.prepare('SELECT * FROM plugin_schedules WHERE id = ?').get(id) as unknown as PluginScheduleRow | undefined
    return row ? mapSchedule(row) : null
  }

  listPluginSchedules(): PluginSchedule[] {
    const rows = this.db.prepare('SELECT * FROM plugin_schedules ORDER BY created_at DESC').all() as unknown as PluginScheduleRow[]
    return rows.map(mapSchedule)
  }

  updatePluginSchedule(id: string, patch: Partial<Pick<PluginSchedule,
    'enabled' | 'nextRunAt' | 'lastRunAt' | 'consecutiveFailures' | 'suspendedReason'
  >>): PluginSchedule {
    const current = requireSchedule(this.getPluginSchedule(id))
    this.db.prepare(`
      UPDATE plugin_schedules SET enabled = ?, next_run_at = ?, last_run_at = ?,
        consecutive_failures = ?, suspended_reason = ?, updated_at = ? WHERE id = ?
    `).run(
      (patch.enabled ?? current.enabled) ? 1 : 0,
      patch.nextRunAt === undefined ? current.nextRunAt : patch.nextRunAt,
      patch.lastRunAt === undefined ? current.lastRunAt : patch.lastRunAt,
      patch.consecutiveFailures ?? current.consecutiveFailures,
      patch.suspendedReason ?? current.suspendedReason,
      new Date().toISOString(),
      id
    )
    return requireSchedule(this.getPluginSchedule(id))
  }

  removePluginSchedule(id: string): void {
    this.db.prepare('DELETE FROM plugin_schedules WHERE id = ?').run(id)
  }

  enqueuePluginEvent(event: PluginEventEnvelope): PluginEventEnvelope {
    this.db.prepare(`
      INSERT OR IGNORE INTO plugin_events (
        id, type, schema_version, source_plugin_id, account_id, content_id,
        payload_json, occurred_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.id,
      event.type,
      event.schemaVersion,
      event.source.pluginId,
      event.subject.accountId,
      event.subject.contentId,
      JSON.stringify(event.data),
      event.occurredAt,
      new Date().toISOString()
    )
    return structuredClone(event)
  }

  listPluginEvents(limit = 500): PluginEventEnvelope[] {
    const safeLimit = Number.isInteger(limit) ? Math.min(2_000, Math.max(1, limit)) : 500
    const rows = this.db.prepare(`
      SELECT * FROM plugin_events ORDER BY occurred_at ASC LIMIT ?
    `).all(safeLimit) as unknown as PluginEventRow[]
    return rows.map(mapPluginEvent)
  }

  listUndeliveredPluginEvents(
    pluginId: string,
    contributionId: string,
    limit = 500
  ): PluginEventEnvelope[] {
    const safeLimit = Number.isInteger(limit) ? Math.min(2_000, Math.max(1, limit)) : 500
    const rows = this.db.prepare(`
      SELECT e.* FROM plugin_events e
      WHERE NOT EXISTS (
        SELECT 1 FROM plugin_event_deliveries d
        WHERE d.event_id = e.id AND d.plugin_id = ? AND d.contribution_id = ?
      )
      ORDER BY e.occurred_at ASC
      LIMIT ?
    `).all(pluginId, contributionId, safeLimit) as unknown as PluginEventRow[]
    return rows.map(mapPluginEvent)
  }

  ensurePluginEventDelivery(
    eventId: string,
    pluginId: string,
    contributionId: string
  ): PluginEventDelivery {
    const existing = this.db.prepare(`
      SELECT * FROM plugin_event_deliveries
      WHERE event_id = ? AND plugin_id = ? AND contribution_id = ?
    `).get(eventId, pluginId, contributionId) as unknown as PluginDeliveryRow | undefined
    if (!existing) {
      const now = new Date().toISOString()
      this.db.prepare(`
        INSERT INTO plugin_event_deliveries (
          id, event_id, plugin_id, contribution_id, status, attempt,
          next_attempt_at, error_code, error_message, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'pending', 0, ?, '', '', ?, ?)
      `).run(randomUUID(), eventId, pluginId, contributionId, now, now, now)
    }
    const row = this.db.prepare(`
      SELECT * FROM plugin_event_deliveries
      WHERE event_id = ? AND plugin_id = ? AND contribution_id = ?
    `).get(eventId, pluginId, contributionId) as unknown as PluginDeliveryRow
    return mapPluginDelivery(row, requirePluginEvent(this.getPluginEvent(eventId)))
  }

  getPluginEvent(id: string): PluginEventEnvelope | null {
    const row = this.db.prepare('SELECT * FROM plugin_events WHERE id = ?').get(id) as unknown as PluginEventRow | undefined
    return row ? mapPluginEvent(row) : null
  }

  listDuePluginDeliveries(now: string, limit = 50): PluginEventDelivery[] {
    const safeLimit = Number.isInteger(limit) ? Math.min(200, Math.max(1, limit)) : 50
    const rows = this.db.prepare(`
      SELECT * FROM plugin_event_deliveries
      WHERE status IN ('pending', 'retry', 'running')
        AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
      ORDER BY COALESCE(next_attempt_at, created_at), created_at
      LIMIT ?
    `).all(now, safeLimit) as unknown as PluginDeliveryRow[]
    return rows.flatMap((row) => {
      const event = this.getPluginEvent(row.event_id)
      return event ? [mapPluginDelivery(row, event)] : []
    })
  }

  updatePluginDelivery(
    id: string,
    patch: Partial<Pick<PluginEventDelivery,
      'status' | 'attempt' | 'nextAttemptAt' | 'errorCode' | 'errorMessage'
    >>
  ): PluginEventDelivery {
    const row = this.db.prepare('SELECT * FROM plugin_event_deliveries WHERE id = ?').get(id) as unknown as PluginDeliveryRow | undefined
    if (!row) throw new Error('插件事件投递不存在')
    this.db.prepare(`
      UPDATE plugin_event_deliveries SET status = ?, attempt = ?, next_attempt_at = ?,
        error_code = ?, error_message = ?, updated_at = ? WHERE id = ?
    `).run(
      patch.status ?? row.status,
      patch.attempt ?? row.attempt,
      patch.nextAttemptAt === undefined ? row.next_attempt_at : patch.nextAttemptAt,
      patch.errorCode ?? row.error_code,
      (patch.errorMessage ?? row.error_message).slice(0, 500),
      new Date().toISOString(),
      id
    )
    const updated = this.db.prepare('SELECT * FROM plugin_event_deliveries WHERE id = ?').get(id) as unknown as PluginDeliveryRow
    return mapPluginDelivery(updated, requirePluginEvent(this.getPluginEvent(updated.event_id)))
  }

  recoverInterruptedPluginRuns(finishedAt = new Date().toISOString()): void {
    this.db.prepare(`
      UPDATE plugin_runs SET status = 'interrupted', finished_at = ?,
        error_code = 'APP_RESTARTED', error_message = '应用重启，运行已中断'
      WHERE status = 'running'
    `).run(finishedAt)
  }

  createPluginRun(run: ExtensionRunRecord): ExtensionRunRecord {
    this.db.prepare(`
      INSERT INTO plugin_runs (
        id, plugin_id, contribution_id, trigger_kind, status, account_id, event_id,
        attempt, result_json, started_at, finished_at, next_attempt_at,
        error_code, error_message, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)
    `).run(
      run.id, run.pluginId, run.contributionId, run.trigger, run.status,
      run.accountId, run.eventId, run.attempt, run.startedAt, run.finishedAt,
      run.nextAttemptAt, run.errorCode, run.errorMessage, run.createdAt
    )
    return requireExtensionRun(this.getPluginRun(run.id))
  }

  getPluginRun(id: string): ExtensionRunRecord | null {
    const row = this.db.prepare('SELECT * FROM plugin_runs WHERE id = ?').get(id) as unknown as PluginRunRow | undefined
    return row ? mapExtensionRun(row) : null
  }

  updateExtensionRun(id: string, patch: Partial<Pick<ExtensionRunRecord,
    'status' | 'attempt' | 'startedAt' | 'finishedAt' | 'nextAttemptAt' | 'errorCode' | 'errorMessage'
  >>): ExtensionRunRecord {
    const current = requireExtensionRun(this.getPluginRun(id))
    this.db.prepare(`
      UPDATE plugin_runs SET status = ?, attempt = ?, started_at = ?, finished_at = ?,
        next_attempt_at = ?, error_code = ?, error_message = ? WHERE id = ?
    `).run(
      patch.status ?? current.status,
      patch.attempt ?? current.attempt,
      patch.startedAt === undefined ? current.startedAt : patch.startedAt,
      patch.finishedAt === undefined ? current.finishedAt : patch.finishedAt,
      patch.nextAttemptAt === undefined ? current.nextAttemptAt : patch.nextAttemptAt,
      patch.errorCode ?? current.errorCode,
      (patch.errorMessage ?? current.errorMessage).slice(0, 500),
      id
    )
    return requireExtensionRun(this.getPluginRun(id))
  }

  listPluginRuns(limit = 200): ExtensionRunRecord[] {
    const safeLimit = Number.isInteger(limit) ? Math.min(500, Math.max(1, limit)) : 200
    const rows = this.db.prepare(`
      SELECT * FROM plugin_runs ORDER BY created_at DESC LIMIT ?
    `).all(safeLimit) as unknown as PluginRunRow[]
    return rows.map(mapExtensionRun)
  }

  getSetting<T>(key: string): T | null
  getSetting<T>(key: string, fallback: T): T
  getSetting<T>(key: string, fallback?: T): T | null {
    const row = this.db.prepare('SELECT value_json FROM app_settings WHERE key = ?').get(key) as unknown as { value_json: string } | undefined
    if (!row) return fallback === undefined ? null : fallback
    try {
      return JSON.parse(row.value_json) as T
    } catch {
      return fallback === undefined ? null : fallback
    }
  }

  setSetting<T>(key: string, value: T): T {
    this.db.prepare(`
      INSERT INTO app_settings (key, value_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
    `).run(key, JSON.stringify(value), new Date().toISOString())
    return value
  }

  getStorageCounts(): StorageCounts {
    return {
      accountCount: this.count('accounts'),
      contentCount: this.count('contents'),
      contentSnapshotCount: this.count('content_snapshots'),
      accountSnapshotCount: this.count('account_snapshots'),
      jobCount: this.count('jobs')
    }
  }

  getAnalytics(query: AnalyticsQuery = {}): AnalyticsOverview {
    const days = query.days ?? 30
    const now = new Date()
    const start = new Date(now)
    start.setUTCDate(start.getUTCDate() - days + 1)
    start.setUTCHours(0, 0, 0, 0)

    const accounts = this.listAccounts().filter((account) =>
      (!query.accountId || account.id === query.accountId) &&
      (!query.platformId || account.platformId === query.platformId)
    )
    const accountIds = new Set(accounts.map((account) => account.id))
    const contentRows = this.db.prepare(`
      SELECT c.*, a.alias AS account_alias, a.platform_id
      FROM contents c JOIN accounts a ON a.id = c.account_id
      ORDER BY c.updated_at DESC
    `).all() as unknown as ContentRow[]
    const contents = contentRows
      .filter((row) => accountIds.has(row.account_id))
      .map((row) => this.mapContent(row))
      .filter((content) => new Date(content.publishedAt ?? content.firstCapturedAt) >= start)

    const followersByAccount = new Map<string, number>()
    for (const account of accounts) {
      const snapshot = this.db.prepare(`
        SELECT followers FROM account_snapshots WHERE account_id = ?
        ORDER BY captured_at DESC LIMIT 1
      `).get(account.id) as unknown as { followers: number | null } | undefined
      followersByAccount.set(account.id, Number(snapshot?.followers ?? 0))
    }
    const accountsResult = accounts.map((account) => {
      const owned = contents.filter((content) => content.accountId === account.id)
      return {
        accountId: account.id,
        accountAlias: localAccountName(account),
        platformId: account.platformId,
        contentCount: owned.length,
        views: sum(owned.map((content) => content.latestSnapshot?.views)),
        interactions: sum(owned.flatMap((content) => interactionValues(content.latestSnapshot))),
        followers: followersByAccount.get(account.id) ?? null
      }
    })

    const timelineData = this.buildAnalyticsTimeline(accountIds, start, now)
    const byTypeMap = new Map<ContentType, number>()
    for (const content of contents) byTypeMap.set(content.type, (byTypeMap.get(content.type) ?? 0) + 1)
    return {
      days,
      contentCount: contents.length,
      views: sum(contents.map((content) => content.latestSnapshot?.views)),
      interactions: sum(contents.flatMap((content) => interactionValues(content.latestSnapshot))),
      followers: sum([...followersByAccount.values()]),
      timeline: timelineData,
      accounts: accountsResult,
      byType: [...byTypeMap.entries()].map(([type, count]) => ({ type, count })),
      generatedAt: now.toISOString()
    }
  }

  getDashboard(): DashboardOverview {
    const accounts = this.listAccounts()
    const contentRows = this.db.prepare(`
      SELECT c.*, a.alias AS account_alias, a.platform_id
      FROM contents c JOIN accounts a ON a.id = c.account_id
    `).all() as unknown as ContentRow[]
    const contents = contentRows.map((row) => this.mapContent(row))
    const reminders: DashboardOverview['reminders'] = []
    for (const account of accounts) {
      const accountName = localAccountName(account)
      if (account.connectionStatus === 'expired' || account.connectionStatus === 'mismatch') {
        reminders.push({
          id: `connection:${account.id}`,
          tone: 'danger',
          title: `${accountName} 需要重新连接`,
          detail: account.connectionStatus === 'expired' ? '登录会话已过期' : '当前身份与绑定账号不一致',
          accountId: account.id
        })
      } else if (account.connectionStatus === 'disconnected') {
        reminders.push({
          id: `disconnected:${account.id}`,
          tone: 'info',
          title: `${accountName} 已断开`,
          detail: '历史数据仍保留在本机',
          accountId: account.id
        })
      }
      if (account.syncStatus === 'failed') {
        reminders.push({
          id: `sync:${account.id}`,
          tone: 'warning',
          title: `${accountName} 同步失败`,
          detail: account.lastSyncError || '请检查插件和登录状态',
          accountId: account.id
        })
      } else if (account.syncStatus === 'cooldown') {
        reminders.push({
          id: `cooldown:${account.id}`,
          tone: 'warning',
          title: `${accountName} 处于冷却期`,
          detail: account.cooldownUntil ? `恢复时间：${account.cooldownUntil}` : '稍后可再次同步',
          accountId: account.id
        })
      }
    }
    return {
      accountCount: accounts.length,
      readyAccountCount: accounts.filter((account) => account.connectionStatus === 'ready').length,
      attentionAccountCount: accounts.filter((account) => (
        account.connectionStatus !== 'ready' ||
        ['failed', 'cooldown', 'unsupported'].includes(account.syncStatus)
      )).length,
      contentCount: contents.length,
      views: sum(contents.map((content) => content.latestSnapshot?.views)),
      interactions: sum(contents.flatMap((content) => interactionValues(content.latestSnapshot))),
      reminders: reminders.slice(0, 20)
    }
  }

  private getContentRow(id: string): ContentRow | null {
    const row = this.db.prepare(`
      SELECT c.*, a.alias AS account_alias, a.platform_id
      FROM contents c JOIN accounts a ON a.id = c.account_id WHERE c.id = ?
    `).get(id) as unknown as ContentRow | undefined
    return row ?? null
  }

  private mapContent(row: ContentRow): ContentSummary {
    const snapshots = this.listContentSnapshots(row.id, 'DESC', 2)
    return {
      id: row.id,
      accountId: row.account_id,
      accountAlias: row.account_alias,
      platformId: row.platform_id,
      remoteId: row.remote_id,
      type: row.type,
      title: row.title,
      bodyExcerpt: row.body_excerpt,
      url: row.url,
      publishedAt: row.published_at,
      firstCapturedAt: row.first_captured_at,
      updatedAt: row.updated_at,
      note: row.note,
      tags: safeStringArray(row.tags_json),
      latestSnapshot: snapshots[0] ?? null,
      previousSnapshot: snapshots[1] ?? null
    }
  }

  private listContentSnapshots(contentId: string, order: 'ASC' | 'DESC', limit?: number): ContentSnapshot[] {
    const rows = this.db.prepare(`
      SELECT views, likes, comments, shares, favorites, captured_at
      FROM content_snapshots WHERE content_id = ? ORDER BY captured_at ${order}
      ${limit === undefined ? '' : 'LIMIT ?'}
    `).all(...(limit === undefined ? [contentId] : [contentId, limit])) as unknown as SnapshotRow[]
    return rows.map(mapSnapshot)
  }

  private assertRemoteIdentityAvailable(accountId: string, platformId: PlatformId, remoteId: string | null): void {
    if (!remoteId) return
    const conflict = this.db.prepare(`
      SELECT id FROM accounts WHERE platform_id = ? AND remote_id = ? AND id <> ? LIMIT 1
    `).get(platformId, remoteId, accountId) as unknown as { id: string } | undefined
    if (conflict) throw new Error('该平台身份已经绑定到其他本地账号')
  }

  private buildAnalyticsTimeline(accountIds: Set<string>, start: Date, end: Date): AnalyticsOverview['timeline'] {
    const contentRows = this.db.prepare(`
      SELECT c.account_id, cs.content_id, cs.views, cs.likes, cs.comments, cs.shares,
        cs.favorites, cs.captured_at
      FROM content_snapshots cs JOIN contents c ON c.id = cs.content_id
      WHERE cs.captured_at >= ? ORDER BY cs.captured_at
    `).all(start.toISOString()) as unknown as Array<SnapshotRow & { account_id: string; content_id: string }>
    const accountRows = this.db.prepare(`
      SELECT account_id, followers, captured_at FROM account_snapshots
      WHERE captured_at >= ? ORDER BY captured_at
    `).all(start.toISOString()) as unknown as Array<{ account_id: string; followers: number | null; captured_at: string }>
    const latestContentPerDay = new Map<string, SnapshotRow>()
    for (const row of contentRows) {
      if (!accountIds.has(row.account_id)) continue
      latestContentPerDay.set(`${row.content_id}:${row.captured_at.slice(0, 10)}`, row)
    }
    const latestFollowersPerDay = new Map<string, number | null>()
    for (const row of accountRows) {
      if (!accountIds.has(row.account_id)) continue
      latestFollowersPerDay.set(`${row.account_id}:${row.captured_at.slice(0, 10)}`, row.followers)
    }
    const result: AnalyticsOverview['timeline'] = []
    for (const date = new Date(start); date <= end; date.setUTCDate(date.getUTCDate() + 1)) {
      const key = date.toISOString().slice(0, 10)
      const dayContent = [...latestContentPerDay.entries()]
        .filter(([entryKey]) => entryKey.endsWith(`:${key}`))
        .map(([, value]) => value)
      const dayFollowers = [...latestFollowersPerDay.entries()]
        .filter(([entryKey]) => entryKey.endsWith(`:${key}`))
        .map(([, value]) => value)
        .filter((value): value is number => value !== null)
      result.push({
        date: key,
        views: sum(dayContent.map((snapshot) => snapshot.views)),
        interactions: sum(dayContent.flatMap((snapshot) => interactionValues(snapshot))),
        followers: dayFollowers.length === 0 ? null : sum(dayFollowers)
      })
    }
    return result
  }

  private count(table: 'accounts' | 'contents' | 'content_snapshots' | 'account_snapshots' | 'jobs'): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as unknown as { count: number }
    return Number(row.count)
  }

  private transaction<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = action()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
}

function sameSnapshotMetrics(
  previous: Pick<SnapshotRow, 'views' | 'likes' | 'comments' | 'shares' | 'favorites'>,
  current: Pick<ContentSnapshot, 'views' | 'likes' | 'comments' | 'shares' | 'favorites'>
): boolean {
  return previous.views === current.views &&
    previous.likes === current.likes &&
    previous.comments === current.comments &&
    previous.shares === current.shares &&
    previous.favorites === current.favorites
}

function mapAccount(
  row: AccountRow,
  groupIds: string[],
  latestSnapshot: AccountSnapshot | null
): Account {
  const syncEnabled = Boolean(row.sync_enabled)
  const status = deriveAccountStatus({
    connectionStatus: row.connection_status,
    syncEnabled,
    syncStatus: row.sync_status,
    syncMode: row.sync_mode
  })
  return {
    id: row.id,
    platformId: row.platform_id,
    adapterContributionId: row.adapter_contribution_id,
    alias: row.alias,
    aliasCustomized: Boolean(row.alias_customized),
    remoteName: row.remote_name,
    remoteId: row.remote_id,
    avatarUrl: row.avatar_cache_key
      ? `app://shell/media/avatars/${encodeURIComponent(row.id)}/${encodeURIComponent(row.avatar_cache_key)}`
      : '',
    bio: row.bio,
    creatorLevel: nullableNumber(row.creator_level),
    latestSnapshot,
    status,
    connectionStatus: row.connection_status,
    ownershipStatus: row.ownership_status,
    syncEnabled,
    syncStatus: row.sync_status,
    cooldownUntil: row.cooldown_until,
    lastSyncError: row.last_sync_error,
    ownershipConfirmedAt: row.ownership_confirmed_at,
    identityVerifiedAt: row.identity_verified_at,
    note: row.note,
    tags: safeStringArray(row.tags_json),
    groupIds,
    sessionPartition: row.session_partition,
    syncMode: row.sync_mode,
    isDefault: Boolean(row.is_default),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastSyncedAt: row.last_synced_at
  }
}

function defaultAdapterContributionId(platformId: PlatformId): string | null {
  if (platformId === 'xiaohongshu') return 'xiaohongshu-session-api.platform'
  if (platformId === 'zhihu') return 'zhihu-session-api.platform'
  return null
}

function mapAccountSnapshot(row: AccountSnapshotRow): AccountSnapshot {
  return {
    accountId: row.account_id,
    followers: nullableNumber(row.followers),
    following: nullableNumber(row.following),
    contentCount: nullableNumber(row.content_count),
    viewsTotal: nullableNumber(row.views_total),
    likesAndFavoritesTotal: nullableNumber(row.likes_favorites_total),
    views: nullableNumber(row.views),
    likes: nullableNumber(row.likes),
    comments: nullableNumber(row.comments),
    shares: nullableNumber(row.shares),
    favorites: nullableNumber(row.favorites),
    capturedAt: row.captured_at
  }
}

function deriveAccountStatus(state: {
  connectionStatus: ConnectionStatus
  syncEnabled: boolean
  syncStatus: SyncStatus
  syncMode: SyncMode
}): AccountStatus {
  if (state.connectionStatus === 'expired') return 'expired'
  if (state.connectionStatus === 'mismatch') return 'mismatch'
  if (state.syncStatus === 'cooldown') return 'cooldown'
  if (state.syncStatus === 'unsupported') return 'unsupported'
  if (!state.syncEnabled || state.syncMode === 'disabled' || state.connectionStatus === 'disconnected') return 'paused'
  return state.connectionStatus === 'ready' ? 'ready' : 'pending'
}

function canEnableManagedSync(
  account: Pick<Account, 'connectionStatus' | 'ownershipStatus'>,
  syncMode: SyncMode
): boolean {
  return account.connectionStatus === 'ready' &&
    account.ownershipStatus === 'plugin_verified' &&
    syncMode !== 'disabled'
}

function mapSnapshot(row: SnapshotRow): ContentSnapshot {
  return {
    views: nullableNumber(row.views),
    likes: nullableNumber(row.likes),
    comments: nullableNumber(row.comments),
    shares: nullableNumber(row.shares),
    favorites: nullableNumber(row.favorites),
    capturedAt: row.captured_at
  }
}

function mapJob(row: JobRow): JobRecord {
  return {
    id: row.id,
    kind: row.kind,
    accountId: row.account_id,
    pluginId: row.plugin_id,
    status: row.status,
    progress: Number(row.progress),
    stage: row.stage,
    result: safeObject(row.result_json),
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at
  }
}

function mapPlugin(row: PluginRow): LegacyPluginState {
  return {
    enabled: Boolean(row.enabled),
    availability: row.availability,
    installedAt: row.installed_at,
    lastRunAt: row.last_run_at,
    successCount: Number(row.success_count),
    failureCount: Number(row.failure_count),
    lastError: row.last_error
  }
}

function mapInstalledPlugin(row: PluginPackageRow): InstalledPluginPackage {
  return {
    manifest: JSON.parse(row.package_manifest_json) as PluginManifestV2,
    source: row.source,
    status: row.package_status,
    enabled: Boolean(row.enabled),
    packageHash: row.package_hash,
    publisherKeyId: row.publisher_key_id,
    installedAt: row.installed_at ?? row.updated_at,
    updatedAt: row.updated_at,
    lastError: row.last_error,
    updateAvailable: row.update_available,
    development: Boolean(row.development)
  }
}

function mapGrant(row: Record<string, unknown>): PluginGrant {
  return {
    pluginId: String(row.plugin_id ?? ''),
    contributionId: String(row.contribution_id ?? ''),
    permissions: safeStringArray(String(row.permissions_json ?? '[]')) as PluginGrant['permissions'],
    accountIds: safeStringArray(String(row.account_ids_json ?? '[]')),
    groupIds: safeStringArray(String(row.group_ids_json ?? '[]')),
    dataScopes: safeStringArray(String(row.data_scopes_json ?? '[]')) as PluginGrant['dataScopes'],
    networkOrigins: safeStringArray(String(row.network_origins_json ?? '[]')),
    grantedAt: String(row.granted_at ?? ''),
    updatedAt: String(row.updated_at ?? '')
  }
}

function mapSchedule(row: PluginScheduleRow): PluginSchedule {
  return {
    id: row.id,
    pluginId: row.plugin_id,
    contributionId: row.contribution_id,
    accountIds: safeStringArray(row.account_ids_json),
    groupIds: safeStringArray(row.group_ids_json),
    intervalMinutes: Number(row.interval_minutes),
    enabled: Boolean(row.enabled),
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    consecutiveFailures: Number(row.consecutive_failures),
    suspendedReason: row.suspended_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function mapExtensionRun(row: PluginRunRow): ExtensionRunRecord {
  return {
    id: row.id,
    pluginId: row.plugin_id,
    contributionId: row.contribution_id,
    trigger: row.trigger_kind,
    status: row.status,
    accountId: row.account_id,
    eventId: row.event_id,
    attempt: Number(row.attempt),
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    nextAttemptAt: row.next_attempt_at,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at
  }
}

function mapPluginEvent(row: PluginEventRow): PluginEventEnvelope {
  return {
    id: row.id,
    type: row.type,
    schemaVersion: 1,
    occurredAt: row.occurred_at,
    source: { app: 'streamfold', pluginId: row.source_plugin_id },
    subject: { accountId: row.account_id, contentId: row.content_id },
    data: parseJsonValue(row.payload_json)
  }
}

function mapPluginDelivery(row: PluginDeliveryRow, event: PluginEventEnvelope): PluginEventDelivery {
  return {
    id: row.id,
    event,
    pluginId: row.plugin_id,
    contributionId: row.contribution_id,
    status: row.status,
    attempt: Number(row.attempt),
    nextAttemptAt: row.next_attempt_at,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function parseJsonValue(value: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch {
    return null
  }
}

function safeStringRecord(value: string): Record<string, string> {
  const parsed = safeObject(value)
  if (!parsed) return {}
  return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => (
    typeof entry[1] === 'string'
  )))
}

function requireInstalledPlugin(value: InstalledPluginPackage | null): InstalledPluginPackage {
  if (!value) throw new Error('插件包不存在')
  return value
}

function requireGrant(value: PluginGrant | null): PluginGrant {
  if (!value) throw new Error('插件授权不存在')
  return value
}

function requirePluginConfig(value: PluginConfigRecord | null): PluginConfigRecord {
  if (!value) throw new Error('插件配置不存在')
  return value
}

function requireSchedule(value: PluginSchedule | null): PluginSchedule {
  if (!value) throw new Error('插件计划不存在')
  return value
}

function requireExtensionRun(value: ExtensionRunRecord | null): ExtensionRunRecord {
  if (!value) throw new Error('插件运行记录不存在')
  return value
}

function requirePluginEvent(value: PluginEventEnvelope | null): PluginEventEnvelope {
  if (!value) throw new Error('插件事件不存在')
  return value
}

function validateManagedSync(
  payload: StandardDataset,
  metadata: ManagedSyncCommitMetadata
): void {
  validateStandardDataset(payload)
  if (!payload.profile) throw new Error('受管同步结果缺少本人账号资料')
  if (!metadata.accountId.trim()) throw new Error('受管同步缺少本地账号')
  if (!metadata.pluginId.trim()) throw new Error('受管同步缺少插件')
  if (!metadata.jobId.trim()) throw new Error('受管同步缺少任务')
  if (!isIsoDate(metadata.finishedAt)) throw new Error('受管同步完成时间无效')
  const limits: Record<Exclude<SyncMode, 'disabled'>, number> = {
    profile_only: 0,
    recent_20: 20,
    recent_100: 100
  }
  if (!(metadata.authorizedMode in limits) || !(metadata.payloadMode in limits)) {
    throw new Error('受管同步范围无效')
  }
  if (limits[metadata.payloadMode] > limits[metadata.authorizedMode]) {
    throw new Error('受管同步结果超过当前授权范围')
  }
  if (payload.contents.length > limits[metadata.payloadMode]) {
    throw new Error('受管同步内容数量超过授权范围')
  }
}

function validateStandardDataset(payload: StandardDataset): void {
  if (!isIsoDate(payload.capturedAt)) throw new Error('数据集采集时间无效')
  if (payload.profile && !payload.profile.remoteId.trim()) throw new Error('数据集身份缺少 remoteId')
  for (const content of payload.contents) {
    if (!content.remoteId.trim()) throw new Error('数据集内容缺少 remoteId')
    for (const snapshot of content.snapshots) {
      if (!isIsoDate(snapshot.capturedAt)) throw new Error('内容快照时间无效')
    }
  }
}

function dedupeStandardContents(contents: StandardContent[]): StandardContent[] {
  const result = new Map<string, StandardContent>()
  for (const content of contents) {
    const previous = result.get(content.remoteId)
    const snapshots = new Map<string, ContentSnapshot>()
    for (const snapshot of previous?.snapshots ?? []) snapshots.set(snapshot.capturedAt, snapshot)
    for (const snapshot of content.snapshots) snapshots.set(snapshot.capturedAt, snapshot)
    result.set(content.remoteId, { ...content, snapshots: [...snapshots.values()] })
  }
  return [...result.values()]
}

function safeStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

function safeObject(value: string | null): Record<string, unknown> | null {
  if (!value) return null
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function requireAccount(account: Account | null): Account {
  if (!account) throw new Error('账号不存在')
  return account
}

function requireManagedSyncAccount(account: Account | null): Account {
  const required = requireAccount(account)
  if (!required.remoteId || required.ownershipStatus !== 'plugin_verified') {
    throw new Error('受管同步要求已核验的本人账号身份')
  }
  if (required.connectionStatus !== 'ready') throw new Error('受管同步要求有效的登录连接')
  if (!required.syncEnabled || required.syncMode === 'disabled') {
    throw new Error('受管同步未被当前账号设置允许')
  }
  return required
}

function requireJob(job: JobRecord | null): JobRecord {
  if (!job) throw new Error('任务不存在')
  return job
}

function isActiveJob(status: JobStatus): boolean {
  return status === 'validating' || status === 'committing'
}

function openDatabase(path: string): DatabaseSync {
  const database = new DatabaseSync(path, {
    timeout: 5000,
    allowExtension: false,
    defensive: true
  })
  try {
    migrateDatabase(database)
    return database
  } catch (error) {
    database.close()
    throw error
  }
}

function validateBackupDatabase(path: string): void {
  const database = new DatabaseSync(path, {
    readOnly: true,
    timeout: 5000,
    allowExtension: false,
    defensive: true
  })
  try {
    const version = readUserVersion(database)
    if (version < 1 || version > CURRENT_SCHEMA_VERSION) throw new Error('数据库版本不受支持')
    const integrity = database.prepare('PRAGMA integrity_check').all() as unknown as Array<{ integrity_check: string }>
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') throw new Error('数据库完整性校验失败')
    const foreignKeyErrors = database.prepare('PRAGMA foreign_key_check').all()
    if (foreignKeyErrors.length > 0) throw new Error('数据库外键校验失败')
  } finally {
    database.close()
  }
}

function sanitizePortablePluginState(database: DatabaseSync): void {
  database.exec('BEGIN IMMEDIATE')
  try {
    database.exec(`
      UPDATE plugin_configs SET encrypted_secrets_json = '{}';
      UPDATE plugin_installations
      SET enabled = 0, package_status = 'disabled',
        last_error = '恢复后需要从插件目录重新安装', update_available = NULL
      WHERE source <> 'builtin';
      UPDATE plugin_contributions
      SET enabled = 0, suspended_reason = '恢复后需要重新安装插件或填写密钥'
      WHERE plugin_id = 'streamfold.webhook' OR plugin_id IN (
        SELECT plugin_id FROM plugin_installations WHERE source <> 'builtin'
      );
      UPDATE plugin_schedules
      SET enabled = 0, next_run_at = NULL,
        suspended_reason = '恢复后需要重新安装插件或填写密钥'
      WHERE plugin_id = 'streamfold.webhook' OR plugin_id IN (
        SELECT plugin_id FROM plugin_installations WHERE source <> 'builtin'
      );
    `)
    database.exec('COMMIT')
  } catch (error) {
    try { database.exec('ROLLBACK') } catch {}
    throw error
  }
}

function removeSqliteSidecars(path: string): void {
  rmSync(`${path}-wal`, { force: true })
  rmSync(`${path}-shm`, { force: true })
}

function checkpointDatabase(database: DatabaseSync): void {
  const result = database.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as unknown as {
    busy: number
    log: number
    checkpointed: number
  }
  if (Number(result.busy) !== 0 || Number(result.log) !== Number(result.checkpointed)) {
    throw new Error('数据库仍有未完成写入，请稍后重试备份')
  }
}

function isTerminalJob(status: JobStatus): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled' || status === 'interrupted'
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, Math.trunc(value)))
}

function nullableNumber(value: number | null): number | null {
  return value === null ? null : Number(value)
}

function interactionValues(metrics: MetricValues | null | undefined): Array<number | null> {
  return metrics ? [metrics.likes, metrics.comments, metrics.shares, metrics.favorites] : []
}

function localAccountName(account: Pick<Account, 'alias' | 'remoteName'>): string {
  return account.alias.trim() || account.remoteName.trim() || '平台账号'
}

function sum(values: Array<number | null | undefined>): number {
  return values.reduce<number>((total, value) => total + Number(value ?? 0), 0)
}

function isIsoDate(value: string): boolean {
  return value.length > 0 && Number.isFinite(Date.parse(value))
}

function safeSyncErrorMessage(value: unknown): string {
  if (typeof value !== 'string') return '受管同步失败'
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return normalized.slice(0, 500) || '受管同步失败'
}

export { CURRENT_SCHEMA_VERSION }
