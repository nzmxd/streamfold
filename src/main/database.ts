import { randomUUID } from 'node:crypto'
import {
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
  PluginAvailability,
  PluginInstallation,
  PluginManifest
} from '../shared/plugin-contracts'
import type {
  ImportCommitMetadata,
  ImportCommitStats,
  NormalizedImportContent,
  NormalizedImportProfile,
  NormalizedImportPayload
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

export interface PluginRunRecordInput {
  jobId: string
  pluginId: string
  accountId: string
  status: 'succeeded' | 'failed'
  startedAt: string
  finishedAt: string
  fileName: string
  fileHash: string
  result: Record<string, unknown> | null
  errorCode: string
  errorMessage: string
}

export interface ManagedSyncCommitMetadata {
  accountId: string
  pluginId: string
  jobId: string
  authorizedMode: Exclude<SyncMode, 'disabled'>
  payloadMode: Exclude<SyncMode, 'disabled'>
  finishedAt: string
}

export interface ManagedSyncCommitResult {
  stats: ImportCommitStats
  job: JobRecord
}

export type PluginStatePatch = Partial<Pick<PluginInstallation,
  'enabled' | 'availability' | 'installedAt' | 'lastRunAt' | 'successCount' | 'failureCount' | 'lastError'
>>

export interface StorageCounts {
  accountCount: number
  contentCount: number
  contentSnapshotCount: number
  accountSnapshotCount: number
  jobCount: number
  importCount: number
}

interface AccountRow {
  id: string
  platform_id: PlatformId
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
  availability: PluginAvailability
  installed_at: string | null
  last_run_at: string | null
  success_count: number
  failure_count: number
  last_error: string
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
    const size = statSync(this.databasePath).size
    if (size <= 0 || size > 48 * 1024 * 1024) throw new Error('本地数据库超过 48 MB 备份上限')
    return readFileSync(this.databasePath)
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
        id, platform_id, alias, alias_customized, remote_name, remote_id, status, connection_status,
        ownership_status, sync_enabled, sync_status, cooldown_until, last_sync_error,
        ownership_confirmed_at, identity_verified_at, note, tags_json, session_partition, sync_mode, is_default,
        created_at, updated_at, last_synced_at
      ) VALUES (?, ?, ?, ?, '', NULL, ?, 'pending', 'unconfirmed', ?, 'idle', NULL, '',
        NULL, NULL, '', '[]', ?, ?, 0, ?, ?, NULL)
    `).run(
      id, input.platformId, alias, aliasCustomized ? 1 : 0, status,
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
    })
    return requireAccount(this.getAccount(input.id))
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
    this.db.prepare(`
      UPDATE contents SET note = ?, tags_json = ?, updated_at = ? WHERE id = ?
    `).run(
      input.note ?? current.note,
      JSON.stringify(input.tags ?? current.tags),
      new Date().toISOString(),
      input.id
    )
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
      this.db.prepare('DELETE FROM import_batches WHERE account_id = ?').run(accountId)
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
    payload: NormalizedImportPayload,
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
      const plugin = requirePlugin(this.getPluginState(metadata.pluginId))
      if (!plugin.enabled || plugin.availability !== 'available') {
        throw new Error('同步期间插件已停用，未写入任何数据')
      }

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
      const stats = this.writeNormalizedContents(account.id, payload.contents, payload.capturedAt, now)
      const resultJson = JSON.stringify(stats)
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
        WHERE plugin_id = ? AND enabled = 1 AND availability = 'available'
      `).run(metadata.finishedAt, metadata.finishedAt, metadata.pluginId)
      if (Number(pluginUpdate.changes) !== 1) throw new Error('同步期间插件已停用，未写入任何数据')
      return { stats, job: requireJob(this.getJob(job.id)) }
    })
  }

  commitImport(payload: NormalizedImportPayload, metadata: ImportCommitMetadata): ImportCommitStats {
    const account = requireAccount(this.getAccount(metadata.accountId))
    const importJob = metadata.jobId ? requireJob(this.getJob(metadata.jobId)) : null
    if (importJob && (
      importJob.accountId !== metadata.accountId ||
      importJob.pluginId !== metadata.pluginId ||
      importJob.status !== 'committing'
    )) throw new Error('导入任务状态已变更')
    validateImport(payload, metadata)
    if (payload.profile) {
      if (account.remoteId && account.remoteId !== payload.profile.remoteId) {
        throw new Error('导入身份与已绑定账号不一致')
      }
      this.assertRemoteIdentityAvailable(account.id, account.platformId, payload.profile.remoteId)
    }
    if (account.ownershipStatus === 'unconfirmed' && !metadata.confirmOwnership) {
      throw new Error('导入前必须确认这是本人账号')
    }

    return this.transaction(() => {
      const now = new Date().toISOString()

      if (payload.profile) {
        const profile = payload.profile
        const ownershipStatus: OwnershipStatus = account.ownershipStatus === 'plugin_verified'
          ? 'plugin_verified'
          : 'user_confirmed'
        const nextStatus = deriveAccountStatus({
          // A local export proves only what the user confirmed about the file. It does not prove
          // that the managed Chromium session is currently authenticated.
          connectionStatus: account.connectionStatus,
          syncEnabled: account.syncEnabled,
          syncStatus: 'idle',
          syncMode: account.syncMode
        })
        this.db.prepare(`
          UPDATE accounts SET remote_id = ?, remote_name = ?, ownership_status = ?,
            ownership_confirmed_at = ?, sync_status = 'idle',
            cooldown_until = NULL, last_sync_error = '', status = ?, last_synced_at = ?,
            updated_at = ? WHERE id = ?
        `).run(
          profile.remoteId,
          profile.remoteName,
          ownershipStatus,
          now,
          nextStatus,
          payload.capturedAt,
          now,
          account.id
        )
        this.insertAccountSnapshot(account.id, profile, payload.capturedAt)
      } else {
        const ownershipStatus = metadata.confirmOwnership && account.ownershipStatus === 'unconfirmed'
          ? 'user_confirmed'
          : account.ownershipStatus
        const nextStatus = deriveAccountStatus({
          connectionStatus: account.connectionStatus,
          syncEnabled: account.syncEnabled,
          syncStatus: 'idle',
          syncMode: account.syncMode
        })
        this.db.prepare(`
          UPDATE accounts SET ownership_status = ?, ownership_confirmed_at = ?, sync_status = 'idle',
            cooldown_until = NULL, last_sync_error = '', status = ?, last_synced_at = ?,
            updated_at = ? WHERE id = ?
        `).run(
          ownershipStatus,
          metadata.confirmOwnership ? now : account.ownershipConfirmedAt,
          nextStatus,
          payload.capturedAt,
          now,
          account.id
        )
      }

      const stats = this.writeNormalizedContents(account.id, payload.contents, payload.capturedAt, now)
      const resultJson = JSON.stringify(stats)
      this.db.prepare(`
        INSERT INTO import_batches (
          id, account_id, plugin_id, file_name, file_hash, captured_at,
          new_content_count, updated_content_count, snapshot_count, skipped_snapshot_count,
          warnings_json, created_at, job_id, status, started_at, finished_at,
          result_json, error_code, error_message
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'succeeded', ?, ?, ?, '', '')
      `).run(
        randomUUID(), account.id, metadata.pluginId, safeFileName(metadata.fileName),
        metadata.fileHash, payload.capturedAt, stats.newContentCount, stats.updatedContentCount,
        stats.snapshotCount, stats.skippedSnapshotCount, JSON.stringify(payload.warnings), now,
        metadata.jobId ?? null, importJob?.startedAt ?? now, now, resultJson
      )
      if (metadata.jobId) {
        const jobResult = this.db.prepare(`
          UPDATE jobs SET status = 'succeeded', progress = 100, stage = '导入完成',
            result_json = ?, error_code = '', error_message = '', finished_at = ?
          WHERE id = ? AND status = 'committing'
        `).run(resultJson, now, metadata.jobId)
        if (Number(jobResult.changes) !== 1) throw new Error('导入任务状态已变更')
        this.db.prepare(`
          UPDATE plugin_installations SET last_run_at = ?, success_count = success_count + 1,
            last_error = '', updated_at = ? WHERE plugin_id = ?
        `).run(now, now, metadata.pluginId)
      }
      return stats
    })
  }

  private insertAccountSnapshot(
    accountId: string,
    profile: NormalizedImportProfile,
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

  private writeNormalizedContents(
    accountId: string,
    sourceContents: NormalizedImportContent[],
    firstCapturedAt: string,
    updatedAt: string
  ): ImportCommitStats {
    let newContentCount = 0
    let updatedContentCount = 0
    let snapshotCount = 0
    let skippedSnapshotCount = 0
    const contents = dedupeImportedContents(sourceContents)
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

  getPluginState(id: string): PluginInstallation | null {
    const row = this.db.prepare('SELECT * FROM plugin_installations WHERE plugin_id = ?').get(id) as unknown as PluginRow | undefined
    return row ? mapPlugin(row) : null
  }

  isPluginEnabled(id: string): boolean {
    const state = this.getPluginState(id)
    return state?.enabled === true && state.availability === 'available'
  }

  listPluginStates(): PluginInstallation[] {
    const rows = this.db.prepare('SELECT * FROM plugin_installations ORDER BY plugin_id').all() as unknown as PluginRow[]
    return rows.map(mapPlugin)
  }

  upsertPluginState(manifest: PluginManifest, patch: PluginStatePatch = {}): PluginInstallation {
    const current = this.getPluginState(manifest.id)
    const now = new Date().toISOString()
    const state = {
      enabled: patch.enabled ?? current?.enabled ?? false,
      availability: patch.availability ?? current?.availability ?? 'available',
      installedAt: patch.installedAt === undefined ? (current?.installedAt ?? now) : patch.installedAt,
      lastRunAt: patch.lastRunAt === undefined ? (current?.lastRunAt ?? null) : patch.lastRunAt,
      successCount: patch.successCount ?? current?.successCount ?? 0,
      failureCount: patch.failureCount ?? current?.failureCount ?? 0,
      lastError: patch.lastError ?? current?.lastError ?? ''
    }
    this.db.prepare(`
      INSERT INTO plugin_installations (
        plugin_id, manifest_json, enabled, availability, installed_at, last_run_at,
        success_count, failure_count, last_error, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(plugin_id) DO UPDATE SET
        manifest_json = excluded.manifest_json,
        enabled = excluded.enabled,
        availability = excluded.availability,
        installed_at = excluded.installed_at,
        last_run_at = excluded.last_run_at,
        success_count = excluded.success_count,
        failure_count = excluded.failure_count,
        last_error = excluded.last_error,
        updated_at = excluded.updated_at
    `).run(
      manifest.id, JSON.stringify(manifest), state.enabled ? 1 : 0, state.availability,
      state.installedAt, state.lastRunAt, state.successCount, state.failureCount,
      state.lastError, now
    )
    return requirePlugin(this.getPluginState(manifest.id))
  }

  setPluginEnabled(id: string, enabled: boolean): PluginInstallation {
    if (!this.getPluginState(id)) throw new Error('插件不存在')
    this.db.prepare('UPDATE plugin_installations SET enabled = ?, updated_at = ? WHERE plugin_id = ?')
      .run(enabled ? 1 : 0, new Date().toISOString(), id)
    return requirePlugin(this.getPluginState(id))
  }

  recordPluginRun(record: PluginRunRecordInput): void {
    requireAccount(this.getAccount(record.accountId))
    const state = this.getPluginState(record.pluginId)
    if (!state) throw new Error('插件不存在')
    const fileName = safeFileName(record.fileName)
    const result = record.result ?? {}
    const newContentCount = safeCount(result.newContentCount)
    const updatedContentCount = safeCount(result.updatedContentCount)
    const snapshotCount = safeCount(result.snapshotCount)
    const skippedSnapshotCount = safeCount(result.skippedSnapshotCount)
    this.transaction(() => {
      const alreadyRecorded = this.db.prepare('SELECT 1 FROM import_batches WHERE job_id = ?').get(record.jobId)
      if (alreadyRecorded) return
      this.db.prepare(`
        UPDATE plugin_installations SET last_run_at = ?,
          success_count = success_count + ?, failure_count = failure_count + ?,
          last_error = ?, updated_at = ? WHERE plugin_id = ?
      `).run(
        record.finishedAt, record.status === 'succeeded' ? 1 : 0,
        record.status === 'failed' ? 1 : 0,
        record.status === 'failed' ? record.errorMessage : '',
        new Date().toISOString(), record.pluginId
      )

      const pendingBatch = record.status === 'succeeded'
        ? this.db.prepare(`
            SELECT id FROM import_batches
            WHERE account_id = ? AND plugin_id = ? AND file_hash = ? AND job_id IS NULL
            ORDER BY created_at DESC LIMIT 1
          `).get(record.accountId, record.pluginId, record.fileHash) as unknown as { id: string } | undefined
        : undefined
      if (pendingBatch) {
        this.db.prepare(`
          UPDATE import_batches SET job_id = ?, status = ?, started_at = ?, finished_at = ?,
            result_json = ?, error_code = ?, error_message = ?, file_name = ? WHERE id = ?
        `).run(
          record.jobId, record.status, record.startedAt, record.finishedAt,
          record.result === null ? null : JSON.stringify(record.result), record.errorCode,
          record.errorMessage, fileName, pendingBatch.id
        )
      } else {
        this.db.prepare(`
          INSERT INTO import_batches (
            id, account_id, plugin_id, file_name, file_hash, captured_at,
            new_content_count, updated_content_count, snapshot_count, skipped_snapshot_count,
            warnings_json, created_at, job_id, status, started_at, finished_at,
            result_json, error_code, error_message
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          randomUUID(), record.accountId, record.pluginId, fileName, record.fileHash,
          record.finishedAt, newContentCount, updatedContentCount, snapshotCount,
          skippedSnapshotCount, record.finishedAt, record.jobId, record.status,
          record.startedAt, record.finishedAt,
          record.result === null ? null : JSON.stringify(record.result),
          record.errorCode, record.errorMessage
        )
      }
    })
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
      jobCount: this.count('jobs'),
      importCount: this.count('import_batches')
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
    const imported = this.db.prepare('SELECT MAX(created_at) AS last_at FROM import_batches').get() as unknown as { last_at: string | null }
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
      lastImportedAt: imported.last_at,
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

  private count(table: 'accounts' | 'contents' | 'content_snapshots' | 'account_snapshots' | 'jobs' | 'import_batches'): number {
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

function mapPlugin(row: PluginRow): PluginInstallation {
  const manifest = JSON.parse(row.manifest_json) as PluginManifest
  return {
    manifest,
    enabled: Boolean(row.enabled),
    availability: row.availability,
    installedAt: row.installed_at,
    lastRunAt: row.last_run_at,
    successCount: Number(row.success_count),
    failureCount: Number(row.failure_count),
    lastError: row.last_error
  }
}

function validateImport(payload: NormalizedImportPayload, metadata: ImportCommitMetadata): void {
  if (!metadata.accountId) throw new Error('缺少导入账号')
  if (!metadata.pluginId) throw new Error('缺少导入插件')
  if (!metadata.fileHash.trim()) throw new Error('缺少文件哈希')
  if (!metadata.fileName.trim()) throw new Error('缺少文件名')
  validateNormalizedPayload(payload)
}

function validateManagedSync(
  payload: NormalizedImportPayload,
  metadata: ManagedSyncCommitMetadata
): void {
  validateNormalizedPayload(payload)
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

function validateNormalizedPayload(payload: NormalizedImportPayload): void {
  if (!isIsoDate(payload.capturedAt)) throw new Error('导入采集时间无效')
  if (payload.profile && !payload.profile.remoteId.trim()) throw new Error('导入身份缺少 remoteId')
  for (const content of payload.contents) {
    if (!content.remoteId.trim()) throw new Error('导入内容缺少 remoteId')
    for (const snapshot of content.snapshots) {
      if (!isIsoDate(snapshot.capturedAt)) throw new Error('内容快照时间无效')
    }
  }
}

function dedupeImportedContents(contents: NormalizedImportContent[]): NormalizedImportContent[] {
  const result = new Map<string, NormalizedImportContent>()
  for (const content of contents) {
    const previous = result.get(content.remoteId)
    const snapshots = new Map<string, ContentSnapshot>()
    for (const snapshot of previous?.snapshots ?? []) snapshots.set(snapshot.capturedAt, snapshot)
    for (const snapshot of content.snapshots) snapshots.set(snapshot.capturedAt, snapshot)
    result.set(content.remoteId, { ...content, snapshots: [...snapshots.values()] })
  }
  return [...result.values()]
}

function safeFileName(value: string): string {
  const parts = value.split(/[\\/]/)
  return parts.at(-1)?.trim() || 'import'
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

function requirePlugin(plugin: PluginInstallation | null): PluginInstallation {
  if (!plugin) throw new Error('插件不存在')
  return plugin
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

function safeCount(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
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
