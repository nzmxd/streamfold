import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type {
  Account,
  AccountStatus,
  CreateAccountInput,
  CreateGroupInput,
  Group,
  PlatformId,
  SyncMode,
  UpdateAccountInput
} from '../shared/contracts'

interface AccountRow {
  id: string
  platform_id: PlatformId
  alias: string
  remote_name: string
  remote_id: string | null
  status: AccountStatus
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

export class SocialDatabase {
  private readonly db: DatabaseSync

  constructor(path: string) {
    this.db = new DatabaseSync(path, {
      timeout: 5000,
      allowExtension: false,
      defensive: true
    })
    this.migrate()
  }

  close(): void {
    if (this.db.isOpen) this.db.close()
  }

  listAccounts(): Account[] {
    const rows = this.db.prepare('SELECT * FROM accounts ORDER BY updated_at DESC').all() as unknown as AccountRow[]
    const groupStatement = this.db.prepare(
      'SELECT group_id FROM account_groups WHERE account_id = ? ORDER BY group_id'
    )
    return rows.map((row) => {
      const groups = groupStatement.all(row.id) as unknown as Array<{ group_id: string }>
      return mapAccount(row, groups.map((item) => item.group_id))
    })
  }

  getAccount(id: string): Account | null {
    const row = this.db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as unknown as AccountRow | undefined
    if (!row) return null
    const groups = this.db.prepare(
      'SELECT group_id FROM account_groups WHERE account_id = ? ORDER BY group_id'
    ).all(id) as unknown as Array<{ group_id: string }>
    return mapAccount(row, groups.map((item) => item.group_id))
  }

  createAccount(input: CreateAccountInput): Account {
    const id = randomUUID()
    const now = new Date().toISOString()
    const partition = `persist:social:${id}`
    this.db.prepare(`
      INSERT INTO accounts (
        id, platform_id, alias, remote_name, remote_id, status, note, tags_json,
        session_partition, sync_mode, is_default, created_at, updated_at, last_synced_at
      ) VALUES (?, ?, ?, '', NULL, 'pending', '', '[]', ?, ?, 0, ?, ?, NULL)
    `).run(id, input.platformId, input.alias, partition, input.syncMode, now, now)
    return requireAccount(this.getAccount(id))
  }

  updateAccount(input: UpdateAccountInput): Account {
    const current = requireAccount(this.getAccount(input.id))
    const next = {
      alias: input.alias ?? current.alias,
      note: input.note ?? current.note,
      tags: input.tags ?? current.tags,
      status: input.status ?? current.status,
      syncMode: input.syncMode ?? current.syncMode,
      isDefault: input.isDefault ?? current.isDefault,
      groupIds: input.groupIds ?? current.groupIds
    }
    const now = new Date().toISOString()

    this.transaction(() => {
      if (next.isDefault) {
        this.db.prepare('UPDATE accounts SET is_default = 0 WHERE platform_id = ?').run(current.platformId)
      }
      this.db.prepare(`
        UPDATE accounts SET alias = ?, note = ?, tags_json = ?, status = ?, sync_mode = ?,
          is_default = ?, updated_at = ? WHERE id = ?
      `).run(
        next.alias,
        next.note,
        JSON.stringify(next.tags),
        next.status,
        next.syncMode,
        next.isDefault ? 1 : 0,
        now,
        current.id
      )

      if (input.groupIds !== undefined) {
        this.db.prepare('DELETE FROM account_groups WHERE account_id = ?').run(current.id)
        const insert = this.db.prepare(
          'INSERT INTO account_groups (account_id, group_id) VALUES (?, ?)'
        )
        for (const groupId of next.groupIds) insert.run(current.id, groupId)
      }
    })
    return requireAccount(this.getAccount(input.id))
  }

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
      sortOrder: row.sort_order,
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

  removeGroup(id: string): void {
    this.db.prepare('DELETE FROM groups WHERE id = ?').run(id)
  }

  private migrate(): void {
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS groups (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        color TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        platform_id TEXT NOT NULL,
        alias TEXT NOT NULL,
        remote_name TEXT NOT NULL DEFAULT '',
        remote_id TEXT,
        status TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        tags_json TEXT NOT NULL DEFAULT '[]',
        session_partition TEXT NOT NULL UNIQUE,
        sync_mode TEXT NOT NULL DEFAULT 'profile_only',
        is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_synced_at TEXT
      ) STRICT;
      CREATE TABLE IF NOT EXISTS account_groups (
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        PRIMARY KEY (account_id, group_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_accounts_platform ON accounts(platform_id);
      CREATE INDEX IF NOT EXISTS idx_accounts_status ON accounts(status);
      CREATE INDEX IF NOT EXISTS idx_account_groups_group ON account_groups(group_id);
    `)
  }

  private transaction(action: () => void): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      action()
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
}

function mapAccount(row: AccountRow, groupIds: string[]): Account {
  return {
    id: row.id,
    platformId: row.platform_id,
    alias: row.alias,
    remoteName: row.remote_name,
    remoteId: row.remote_id,
    status: row.status,
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

function safeStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

function requireAccount(account: Account | null): Account {
  if (!account) throw new Error('账号不存在')
  return account
}
