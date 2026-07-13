import type { DatabaseSync } from 'node:sqlite'

export const CURRENT_SCHEMA_VERSION = 5

export function migrateDatabase(db: DatabaseSync): void {
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA journal_mode = WAL')

  let version = readUserVersion(db)
  if (version > CURRENT_SCHEMA_VERSION) {
    throw new Error(`数据库版本 ${version} 高于当前支持的版本 ${CURRENT_SCHEMA_VERSION}`)
  }

  if (version < 1) {
    inTransaction(db, () => migrateV0ToV1(db))
    version = 1
  }
  if (version < 2) {
    inTransaction(db, () => migrateV1ToV2(db))
    version = 2
  }
  if (version < 3) {
    inTransaction(db, () => migrateV2ToV3(db))
    version = 3
  }
  if (version < 4) {
    inTransaction(db, () => migrateV3ToV4(db))
    version = 4
  }
  if (version < 5) {
    inTransaction(db, () => migrateV4ToV5(db))
  }
}

export function readUserVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as unknown as { user_version: number }
  return Number(row.user_version)
}

function migrateV0ToV1(db: DatabaseSync): void {
  // v0 was created before schema versioning and contained only these three tables.
  // Creating them first also makes a brand-new database follow exactly the same path.
  db.exec(`
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
  `)

  addColumn(db, 'accounts', "connection_status TEXT NOT NULL DEFAULT 'pending'")
  addColumn(db, 'accounts', "ownership_status TEXT NOT NULL DEFAULT 'unconfirmed'")
  addColumn(db, 'accounts', 'sync_enabled INTEGER NOT NULL DEFAULT 1 CHECK (sync_enabled IN (0, 1))')
  addColumn(db, 'accounts', "sync_status TEXT NOT NULL DEFAULT 'idle'")
  addColumn(db, 'accounts', 'cooldown_until TEXT')
  addColumn(db, 'accounts', "last_sync_error TEXT NOT NULL DEFAULT ''")
  addColumn(db, 'accounts', 'identity_verified_at TEXT')

  db.exec(`
    UPDATE accounts SET
      connection_status = CASE status
        WHEN 'ready' THEN 'ready'
        WHEN 'expired' THEN 'expired'
        WHEN 'mismatch' THEN 'mismatch'
        ELSE 'pending'
      END,
      sync_enabled = CASE WHEN status = 'paused' OR sync_mode = 'disabled' THEN 0 ELSE 1 END,
      sync_status = CASE status
        WHEN 'cooldown' THEN 'cooldown'
        WHEN 'unsupported' THEN 'unsupported'
        ELSE 'idle'
      END,
      status = CASE
        WHEN status = 'paused' OR sync_mode = 'disabled' THEN 'paused'
        WHEN status = 'cooldown' THEN 'cooldown'
        WHEN status = 'unsupported' THEN 'unsupported'
        WHEN status = 'expired' THEN 'expired'
        WHEN status = 'mismatch' THEN 'mismatch'
        WHEN status = 'ready' THEN 'ready'
        ELSE 'pending'
      END;

    CREATE TABLE IF NOT EXISTS account_snapshots (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      followers INTEGER,
      following INTEGER,
      content_count INTEGER,
      views_total INTEGER,
      views INTEGER,
      likes INTEGER,
      comments INTEGER,
      shares INTEGER,
      favorites INTEGER,
      captured_at TEXT NOT NULL,
      UNIQUE (account_id, captured_at)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS contents (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      remote_id TEXT NOT NULL,
      type TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      body_excerpt TEXT NOT NULL DEFAULT '',
      url TEXT NOT NULL DEFAULT '',
      published_at TEXT,
      first_captured_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      tags_json TEXT NOT NULL DEFAULT '[]',
      UNIQUE (account_id, remote_id)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS content_snapshots (
      id TEXT PRIMARY KEY,
      content_id TEXT NOT NULL REFERENCES contents(id) ON DELETE CASCADE,
      views INTEGER,
      likes INTEGER,
      comments INTEGER,
      shares INTEGER,
      favorites INTEGER,
      captured_at TEXT NOT NULL,
      UNIQUE (content_id, captured_at)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS import_batches (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      plugin_id TEXT NOT NULL,
      file_name TEXT NOT NULL,
      file_hash TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      new_content_count INTEGER NOT NULL,
      updated_content_count INTEGER NOT NULL,
      snapshot_count INTEGER NOT NULL,
      skipped_snapshot_count INTEGER NOT NULL,
      warnings_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL
    ) STRICT;

    CREATE INDEX IF NOT EXISTS idx_accounts_platform ON accounts(platform_id);
    CREATE INDEX IF NOT EXISTS idx_accounts_status ON accounts(status);
    CREATE INDEX IF NOT EXISTS idx_accounts_connection_status ON accounts(connection_status);
    CREATE INDEX IF NOT EXISTS idx_accounts_remote_identity ON accounts(platform_id, remote_id);
    CREATE INDEX IF NOT EXISTS idx_account_groups_group ON account_groups(group_id);
    CREATE INDEX IF NOT EXISTS idx_account_snapshots_account_time ON account_snapshots(account_id, captured_at DESC);
    CREATE INDEX IF NOT EXISTS idx_contents_account_updated ON contents(account_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_contents_platform_type ON contents(type, published_at DESC);
    CREATE INDEX IF NOT EXISTS idx_content_snapshots_content_time ON content_snapshots(content_id, captured_at DESC);
    CREATE INDEX IF NOT EXISTS idx_import_batches_account_time ON import_batches(account_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_import_batches_file_hash ON import_batches(file_hash);
    PRAGMA user_version = 1;
  `)
}

function migrateV1ToV2(db: DatabaseSync): void {
  addColumn(db, 'import_batches', 'job_id TEXT')
  addColumn(db, 'import_batches', "status TEXT NOT NULL DEFAULT 'succeeded'")
  addColumn(db, 'import_batches', 'started_at TEXT')
  addColumn(db, 'import_batches', 'finished_at TEXT')
  addColumn(db, 'import_batches', 'result_json TEXT')
  addColumn(db, 'import_batches', "error_code TEXT NOT NULL DEFAULT ''")
  addColumn(db, 'import_batches', "error_message TEXT NOT NULL DEFAULT ''")
  db.exec(`
    CREATE TABLE IF NOT EXISTS plugin_installations (
      plugin_id TEXT PRIMARY KEY,
      manifest_json TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
      availability TEXT NOT NULL DEFAULT 'available',
      installed_at TEXT,
      last_run_at TEXT,
      success_count INTEGER NOT NULL DEFAULT 0,
      failure_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      plugin_id TEXT NOT NULL,
      status TEXT NOT NULL,
      progress INTEGER NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 100),
      stage TEXT NOT NULL DEFAULT '',
      result_json TEXT,
      error_code TEXT NOT NULL DEFAULT '',
      error_message TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT
    ) STRICT;

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS sync_cursors (
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      plugin_id TEXT NOT NULL,
      cursor_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (account_id, plugin_id)
    ) STRICT;

    CREATE INDEX IF NOT EXISTS idx_plugin_installations_enabled ON plugin_installations(enabled, availability);
    CREATE INDEX IF NOT EXISTS idx_jobs_status_created ON jobs(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_jobs_account_created ON jobs(account_id, created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_import_batches_job ON import_batches(job_id) WHERE job_id IS NOT NULL;
    PRAGMA user_version = 2;
  `)
}

function migrateV2ToV3(db: DatabaseSync): void {
  addColumn(db, 'accounts', 'ownership_confirmed_at TEXT')
  db.exec(`
    UPDATE accounts SET
      ownership_confirmed_at = CASE
        WHEN ownership_status = 'user_confirmed' THEN identity_verified_at
        ELSE ownership_confirmed_at
      END,
      identity_verified_at = CASE
        WHEN ownership_status = 'plugin_verified' THEN identity_verified_at
        ELSE NULL
      END;
    PRAGMA user_version = 3;
  `)
}

function migrateV3ToV4(db: DatabaseSync): void {
  db.exec(`
    UPDATE accounts SET sync_enabled = 0
    WHERE sync_enabled = 1 AND (
      connection_status <> 'ready' OR
      ownership_status <> 'plugin_verified' OR
      sync_mode = 'disabled'
    );

    CREATE TRIGGER IF NOT EXISTS accounts_sync_authorization_insert
    BEFORE INSERT ON accounts
    WHEN NEW.sync_enabled = 1 AND (
      NEW.connection_status <> 'ready' OR
      NEW.ownership_status <> 'plugin_verified' OR
      NEW.sync_mode = 'disabled'
    )
    BEGIN
      SELECT RAISE(ABORT, 'invalid sync authorization');
    END;

    CREATE TRIGGER IF NOT EXISTS accounts_sync_authorization_update
    BEFORE UPDATE OF sync_enabled, connection_status, ownership_status, sync_mode ON accounts
    WHEN NEW.sync_enabled = 1 AND (
      NEW.connection_status <> 'ready' OR
      NEW.ownership_status <> 'plugin_verified' OR
      NEW.sync_mode = 'disabled'
    )
    BEGIN
      SELECT RAISE(ABORT, 'invalid sync authorization');
    END;

    PRAGMA user_version = 4;
  `)
}

function migrateV4ToV5(db: DatabaseSync): void {
  addColumn(db, 'account_snapshots', 'likes_favorites_total INTEGER')
  db.exec(`
    UPDATE accounts SET
      ownership_status = CASE WHEN remote_id IS NULL THEN 'unconfirmed' ELSE 'user_confirmed' END,
      ownership_confirmed_at = COALESCE(ownership_confirmed_at, identity_verified_at),
      identity_verified_at = NULL,
      connection_status = CASE WHEN connection_status = 'disconnected' THEN 'disconnected' ELSE 'pending' END,
      sync_enabled = 0,
      sync_status = 'idle',
      cooldown_until = NULL,
      last_sync_error = '',
      status = 'paused'
    WHERE platform_id = 'xiaohongshu' AND ownership_status = 'plugin_verified';

    DELETE FROM sync_cursors
    WHERE plugin_id IN ('xiaohongshu-managed-browser', 'generic-file-import');
    DELETE FROM plugin_installations
    WHERE plugin_id IN ('xiaohongshu-managed-browser', 'generic-file-import');

    PRAGMA user_version = 5;
  `)
}

function addColumn(db: DatabaseSync, table: string, definition: string): void {
  const name = definition.slice(0, definition.indexOf(' '))
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>
  if (!columns.some((column) => column.name === name)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`)
  }
}

function inTransaction(db: DatabaseSync, action: () => void): void {
  db.exec('BEGIN IMMEDIATE')
  try {
    action()
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
