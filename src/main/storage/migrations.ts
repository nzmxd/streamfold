import type { DatabaseSync } from 'node:sqlite'

export const CURRENT_SCHEMA_VERSION = 14

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
    version = 5
  }
  if (version < 6) {
    inTransaction(db, () => migrateV5ToV6(db))
    version = 6
  }
  if (version < 7) {
    inTransaction(db, () => migrateV6ToV7(db))
    version = 7
  }
  if (version < 8) {
    inTransaction(db, () => migrateV7ToV8(db))
    version = 8
  }
  if (version < 9) {
    inTransaction(db, () => migrateV8ToV9(db))
    version = 9
  }
  if (version < 10) {
    inTransaction(db, () => migrateV9ToV10(db))
    version = 10
  }
  if (version < 11) {
    inTransaction(db, () => migrateV10ToV11(db))
    version = 11
  }
  if (version < 12) {
    inTransaction(db, () => migrateV11ToV12(db))
    version = 12
  }
  if (version < 13) {
    inTransaction(db, () => migrateV12ToV13(db))
    version = 13
  }
  if (version < 14) {
    inTransaction(db, () => migrateV13ToV14(db))
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

    CREATE INDEX IF NOT EXISTS idx_accounts_platform ON accounts(platform_id);
    CREATE INDEX IF NOT EXISTS idx_accounts_status ON accounts(status);
    CREATE INDEX IF NOT EXISTS idx_accounts_connection_status ON accounts(connection_status);
    CREATE INDEX IF NOT EXISTS idx_accounts_remote_identity ON accounts(platform_id, remote_id);
    CREATE INDEX IF NOT EXISTS idx_account_groups_group ON account_groups(group_id);
    CREATE INDEX IF NOT EXISTS idx_account_snapshots_account_time ON account_snapshots(account_id, captured_at DESC);
    CREATE INDEX IF NOT EXISTS idx_contents_account_updated ON contents(account_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_contents_platform_type ON contents(type, published_at DESC);
    CREATE INDEX IF NOT EXISTS idx_content_snapshots_content_time ON content_snapshots(content_id, captured_at DESC);
    PRAGMA user_version = 1;
  `)
}

function migrateV1ToV2(db: DatabaseSync): void {
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

function migrateV5ToV6(db: DatabaseSync): void {
  // Existing aliases were explicitly entered in releases that predate automatic
  // profile naming, so preserve every one of them as a user customization.
  addColumn(db, 'accounts', 'alias_customized INTEGER NOT NULL DEFAULT 1 CHECK (alias_customized IN (0, 1))')
  addColumn(db, 'accounts', 'avatar_cache_key TEXT')
  addColumn(db, 'accounts', 'avatar_mime TEXT')
  addColumn(db, 'accounts', "bio TEXT NOT NULL DEFAULT ''")
  addColumn(db, 'accounts', 'creator_level INTEGER')
  db.exec('PRAGMA user_version = 6;')
}

function migrateV6ToV7(db: DatabaseSync): void {
  db.exec(`
    UPDATE contents
    SET url = 'https://www.xiaohongshu.com/explore/' || remote_id
    WHERE account_id IN (
      SELECT id FROM accounts WHERE platform_id = 'xiaohongshu'
    ) AND (
      url = '' OR
      url LIKE 'https://creator.xiaohongshu.com/statistics/note-detail?noteId=%'
    );
    PRAGMA user_version = 7;
  `)
}

function migrateV7ToV8(db: DatabaseSync): void {
  db.exec(`
    WITH ordered AS (
      SELECT
        id,
        views,
        likes,
        comments,
        shares,
        favorites,
        ROW_NUMBER() OVER (
          PARTITION BY content_id ORDER BY captured_at ASC, id ASC
        ) AS snapshot_number,
        LAG(views) OVER (
          PARTITION BY content_id ORDER BY captured_at ASC, id ASC
        ) AS previous_views,
        LAG(likes) OVER (
          PARTITION BY content_id ORDER BY captured_at ASC, id ASC
        ) AS previous_likes,
        LAG(comments) OVER (
          PARTITION BY content_id ORDER BY captured_at ASC, id ASC
        ) AS previous_comments,
        LAG(shares) OVER (
          PARTITION BY content_id ORDER BY captured_at ASC, id ASC
        ) AS previous_shares,
        LAG(favorites) OVER (
          PARTITION BY content_id ORDER BY captured_at ASC, id ASC
        ) AS previous_favorites
      FROM content_snapshots
    )
    DELETE FROM content_snapshots
    WHERE id IN (
      SELECT id FROM ordered
      WHERE snapshot_number > 1
        AND views IS previous_views
        AND likes IS previous_likes
        AND comments IS previous_comments
        AND shares IS previous_shares
        AND favorites IS previous_favorites
    );
    PRAGMA user_version = 8;
  `)
}

function migrateV8ToV9(db: DatabaseSync): void {
  addColumn(db, 'accounts', 'adapter_contribution_id TEXT')
  addColumn(db, 'plugin_installations', "source TEXT NOT NULL DEFAULT 'builtin'")
  addColumn(db, 'plugin_installations', "package_status TEXT NOT NULL DEFAULT 'active'")
  addColumn(db, 'plugin_installations', "package_hash TEXT NOT NULL DEFAULT ''")
  addColumn(db, 'plugin_installations', "publisher_key_id TEXT NOT NULL DEFAULT ''")
  addColumn(db, 'plugin_installations', "package_manifest_json TEXT NOT NULL DEFAULT '{}'")
  addColumn(db, 'plugin_installations', 'update_available TEXT')
  addColumn(db, 'plugin_installations', 'development INTEGER NOT NULL DEFAULT 0 CHECK (development IN (0, 1))')

  db.exec(`
    UPDATE accounts SET adapter_contribution_id = CASE platform_id
      WHEN 'xiaohongshu' THEN 'xiaohongshu-session-api.platform'
      WHEN 'zhihu' THEN 'zhihu-session-api.platform'
      ELSE adapter_contribution_id
    END
    WHERE adapter_contribution_id IS NULL;

    CREATE TABLE IF NOT EXISTS plugin_contributions (
      plugin_id TEXT NOT NULL REFERENCES plugin_installations(plugin_id) ON DELETE CASCADE,
      contribution_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      manifest_json TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
      runtime TEXT NOT NULL,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      suspended_reason TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL,
      PRIMARY KEY (plugin_id, contribution_id)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS plugin_grants (
      plugin_id TEXT NOT NULL,
      contribution_id TEXT NOT NULL,
      permissions_json TEXT NOT NULL DEFAULT '[]',
      account_ids_json TEXT NOT NULL DEFAULT '[]',
      group_ids_json TEXT NOT NULL DEFAULT '[]',
      data_scopes_json TEXT NOT NULL DEFAULT '[]',
      network_origins_json TEXT NOT NULL DEFAULT '[]',
      granted_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (plugin_id, contribution_id),
      FOREIGN KEY (plugin_id, contribution_id)
        REFERENCES plugin_contributions(plugin_id, contribution_id) ON DELETE CASCADE
    ) STRICT;

    CREATE TABLE IF NOT EXISTS plugin_configs (
      plugin_id TEXT NOT NULL,
      contribution_id TEXT NOT NULL,
      public_json TEXT NOT NULL DEFAULT '{}',
      encrypted_secrets_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL,
      PRIMARY KEY (plugin_id, contribution_id),
      FOREIGN KEY (plugin_id, contribution_id)
        REFERENCES plugin_contributions(plugin_id, contribution_id) ON DELETE CASCADE
    ) STRICT;

    CREATE TABLE IF NOT EXISTS plugin_schedules (
      id TEXT PRIMARY KEY,
      plugin_id TEXT NOT NULL,
      contribution_id TEXT NOT NULL,
      account_ids_json TEXT NOT NULL DEFAULT '[]',
      group_ids_json TEXT NOT NULL DEFAULT '[]',
      interval_minutes INTEGER NOT NULL CHECK (interval_minutes >= 5),
      enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
      next_run_at TEXT,
      last_run_at TEXT,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      suspended_reason TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (plugin_id, contribution_id)
        REFERENCES plugin_contributions(plugin_id, contribution_id) ON DELETE CASCADE
    ) STRICT;

    CREATE TABLE IF NOT EXISTS plugin_events (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      schema_version INTEGER NOT NULL DEFAULT 1,
      source_plugin_id TEXT,
      account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
      content_id TEXT REFERENCES contents(id) ON DELETE SET NULL,
      payload_json TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS plugin_event_deliveries (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL REFERENCES plugin_events(id) ON DELETE CASCADE,
      plugin_id TEXT NOT NULL,
      contribution_id TEXT NOT NULL,
      status TEXT NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT,
      error_code TEXT NOT NULL DEFAULT '',
      error_message TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (event_id, plugin_id, contribution_id),
      FOREIGN KEY (plugin_id, contribution_id)
        REFERENCES plugin_contributions(plugin_id, contribution_id) ON DELETE CASCADE
    ) STRICT;

    CREATE TABLE IF NOT EXISTS plugin_runs (
      id TEXT PRIMARY KEY,
      plugin_id TEXT NOT NULL,
      contribution_id TEXT NOT NULL,
      trigger_kind TEXT NOT NULL,
      status TEXT NOT NULL,
      account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
      event_id TEXT REFERENCES plugin_events(id) ON DELETE SET NULL,
      attempt INTEGER NOT NULL DEFAULT 0,
      result_json TEXT,
      started_at TEXT,
      finished_at TEXT,
      next_attempt_at TEXT,
      error_code TEXT NOT NULL DEFAULT '',
      error_message TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      FOREIGN KEY (plugin_id, contribution_id)
        REFERENCES plugin_contributions(plugin_id, contribution_id) ON DELETE CASCADE
    ) STRICT;

    CREATE INDEX IF NOT EXISTS idx_accounts_adapter ON accounts(adapter_contribution_id);
    CREATE INDEX IF NOT EXISTS idx_plugin_contributions_kind ON plugin_contributions(kind, enabled);
    CREATE INDEX IF NOT EXISTS idx_plugin_schedules_due ON plugin_schedules(enabled, next_run_at);
    CREATE INDEX IF NOT EXISTS idx_plugin_events_time ON plugin_events(occurred_at DESC);
    CREATE INDEX IF NOT EXISTS idx_plugin_deliveries_due
      ON plugin_event_deliveries(status, next_attempt_at);
    CREATE INDEX IF NOT EXISTS idx_plugin_runs_time ON plugin_runs(created_at DESC);

    PRAGMA user_version = 9;
  `)
}

/** Retires file-import bookkeeping while preserving accounts, contents and snapshots. */
function migrateV9ToV10(db: DatabaseSync): void {
  db.exec(`
    DROP TABLE IF EXISTS import_batches;
    PRAGMA user_version = 10;
  `)
}

/** Adds durable sync batches and retry metadata without rewriting existing job history. */
function migrateV10ToV11(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS job_batches (
      id TEXT PRIMARY KEY,
      trigger_kind TEXT NOT NULL CHECK (
        trigger_kind IN ('manual', 'scheduled', 'event', 'retry')
      ),
      requested_scope TEXT NOT NULL CHECK (
        requested_scope IN ('account_default', 'profile_only', 'recent_20', 'recent_100')
      ),
      created_at TEXT NOT NULL
    ) STRICT;
  `)

  addColumn(db, 'jobs', 'batch_id TEXT REFERENCES job_batches(id) ON DELETE SET NULL')
  addColumn(db, 'jobs', "contribution_id TEXT NOT NULL DEFAULT ''")
  addColumn(db, 'jobs', `trigger_kind TEXT NOT NULL DEFAULT 'manual' CHECK (
    trigger_kind IN ('manual', 'scheduled', 'event', 'retry')
  )`)
  addColumn(db, 'jobs', 'attempt INTEGER NOT NULL DEFAULT 1 CHECK (attempt >= 1)')
  addColumn(db, 'jobs', 'retry_of_job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL')
  addColumn(db, 'jobs', `requested_sync_mode TEXT CHECK (
    requested_sync_mode IS NULL OR
    requested_sync_mode IN ('profile_only', 'recent_20', 'recent_100')
  )`)

  db.exec(`
    UPDATE jobs
    SET contribution_id = COALESCE(
      (SELECT adapter_contribution_id FROM accounts WHERE accounts.id = jobs.account_id),
      plugin_id || '.platform'
    )
    WHERE contribution_id = '';

    UPDATE jobs
    SET requested_sync_mode = (
      SELECT CASE accounts.sync_mode
        WHEN 'profile_only' THEN 'profile_only'
        WHEN 'recent_20' THEN 'recent_20'
        WHEN 'recent_100' THEN 'recent_100'
        ELSE NULL
      END
      FROM accounts WHERE accounts.id = jobs.account_id
    )
    WHERE requested_sync_mode IS NULL;

    CREATE INDEX IF NOT EXISTS idx_job_batches_created
      ON job_batches(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_jobs_batch_status_created
      ON jobs(batch_id, status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_jobs_retry_of
      ON jobs(retry_of_job_id, created_at DESC);
    PRAGMA user_version = 11;
  `)
}

/** Adds platform-declared dynamic content metrics without rewriting the five legacy columns. */
function migrateV11ToV12(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS content_metric_definitions (
      platform_id TEXT NOT NULL,
      metric_id TEXT NOT NULL,
      label TEXT NOT NULL,
      value_kind TEXT NOT NULL CHECK (value_kind IN ('count', 'ratio', 'duration')),
      unit TEXT NOT NULL CHECK (unit IN ('count', 'ratio', 'seconds')),
      metric_group TEXT NOT NULL CHECK (
        metric_group IN ('reach', 'engagement', 'conversion', 'other')
      ),
      sort_order INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (platform_id, metric_id)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS content_snapshot_metrics (
      snapshot_id TEXT NOT NULL REFERENCES content_snapshots(id) ON DELETE CASCADE,
      platform_id TEXT NOT NULL,
      metric_id TEXT NOT NULL,
      value REAL,
      PRIMARY KEY (snapshot_id, metric_id),
      FOREIGN KEY (platform_id, metric_id)
        REFERENCES content_metric_definitions(platform_id, metric_id)
        ON UPDATE CASCADE ON DELETE RESTRICT
    ) STRICT;

    CREATE INDEX IF NOT EXISTS idx_content_metric_definitions_platform_order
      ON content_metric_definitions(platform_id, sort_order, metric_id);
    CREATE INDEX IF NOT EXISTS idx_content_snapshot_metrics_metric
      ON content_snapshot_metrics(platform_id, metric_id, snapshot_id);
    PRAGMA user_version = 12;
  `)
}

/** Adds account-level period metrics while preserving legacy account profile snapshots. */
function migrateV12ToV13(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS account_metric_definitions (
      platform_id TEXT NOT NULL,
      metric_id TEXT NOT NULL,
      label TEXT NOT NULL,
      value_kind TEXT NOT NULL CHECK (value_kind IN ('count', 'ratio', 'duration')),
      unit TEXT NOT NULL CHECK (unit IN ('count', 'ratio', 'seconds')),
      metric_group TEXT NOT NULL CHECK (
        metric_group IN ('reach', 'engagement', 'conversion', 'other')
      ),
      sort_order INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (platform_id, metric_id)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS account_metric_snapshots (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      period_kind TEXT NOT NULL CHECK (
        period_kind IN ('daily', 'last_7_days', 'last_14_days', 'last_30_days', 'lifetime')
      ),
      period_start TEXT NOT NULL,
      period_end TEXT NOT NULL,
      status TEXT,
      captured_at TEXT NOT NULL,
      CHECK (
        (period_kind = 'lifetime' AND period_start = '') OR
        (period_kind <> 'lifetime' AND period_start <> '')
      ),
      UNIQUE (account_id, period_kind, period_start, period_end)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS account_metric_values (
      snapshot_id TEXT NOT NULL REFERENCES account_metric_snapshots(id) ON DELETE CASCADE,
      platform_id TEXT NOT NULL,
      metric_id TEXT NOT NULL,
      value REAL,
      PRIMARY KEY (snapshot_id, metric_id),
      FOREIGN KEY (platform_id, metric_id)
        REFERENCES account_metric_definitions(platform_id, metric_id)
        ON UPDATE CASCADE ON DELETE RESTRICT
    ) STRICT;

    CREATE INDEX IF NOT EXISTS idx_account_metric_definitions_platform_order
      ON account_metric_definitions(platform_id, sort_order, metric_id);
    CREATE INDEX IF NOT EXISTS idx_account_metric_snapshots_account_period
      ON account_metric_snapshots(account_id, period_kind, period_end, captured_at);
    CREATE INDEX IF NOT EXISTS idx_account_metric_values_metric
      ON account_metric_values(platform_id, metric_id, snapshot_id);
    PRAGMA user_version = 13;
  `)
}

/** Adds local content organization, observation provenance and full-text search. */
function migrateV13ToV14(db: DatabaseSync): void {
  addColumn(db, 'contents', 'is_bookmarked INTEGER NOT NULL DEFAULT 0 CHECK (is_bookmarked IN (0, 1))')
  addColumn(db, 'contents', 'last_captured_at TEXT')
  addColumn(db, 'content_metric_definitions', `measurement_kind TEXT NOT NULL DEFAULT 'gauge' CHECK (
    measurement_kind IN ('cumulative', 'period_total', 'gauge')
  )`)
  addColumn(db, 'content_metric_definitions', `standard_metric_id TEXT CHECK (
    standard_metric_id IS NULL OR standard_metric_id IN ('views', 'likes', 'comments', 'shares', 'favorites')
  )`)

  db.exec(`
    CREATE TABLE IF NOT EXISTS content_tags (
      content_id TEXT NOT NULL REFERENCES contents(id) ON DELETE CASCADE,
      tag TEXT NOT NULL CHECK (length(trim(tag)) > 0),
      PRIMARY KEY (content_id, tag)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS content_observations (
      id TEXT PRIMARY KEY,
      content_id TEXT NOT NULL REFERENCES contents(id) ON DELETE CASCADE,
      job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
      snapshot_id TEXT REFERENCES content_snapshots(id) ON DELETE SET NULL,
      contribution_id TEXT NOT NULL DEFAULT '',
      semantics_revision TEXT NOT NULL DEFAULT 'legacy',
      observed_at TEXT NOT NULL,
      UNIQUE (content_id, job_id)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS content_metric_semantics (
      contribution_id TEXT NOT NULL,
      semantics_revision TEXT NOT NULL,
      platform_id TEXT NOT NULL,
      metric_id TEXT NOT NULL,
      label TEXT NOT NULL,
      value_kind TEXT NOT NULL CHECK (value_kind IN ('count', 'ratio', 'duration')),
      unit TEXT NOT NULL CHECK (unit IN ('count', 'ratio', 'seconds')),
      metric_group TEXT NOT NULL CHECK (metric_group IN ('reach', 'engagement', 'conversion', 'other')),
      sort_order INTEGER NOT NULL,
      measurement_kind TEXT NOT NULL DEFAULT 'gauge' CHECK (
        measurement_kind IN ('cumulative', 'period_total', 'gauge')
      ),
      standard_metric_id TEXT CHECK (
        standard_metric_id IS NULL OR standard_metric_id IN ('views', 'likes', 'comments', 'shares', 'favorites')
      ),
      updated_at TEXT NOT NULL,
      PRIMARY KEY (contribution_id, semantics_revision, metric_id)
    ) STRICT;

    CREATE INDEX IF NOT EXISTS idx_content_tags_tag
      ON content_tags(tag, content_id);
    CREATE INDEX IF NOT EXISTS idx_contents_capture_sort
      ON contents(COALESCE(last_captured_at, first_captured_at) DESC, id);
    CREATE INDEX IF NOT EXISTS idx_contents_published_sort
      ON contents(published_at DESC, id);
    CREATE INDEX IF NOT EXISTS idx_contents_bookmarked_capture
      ON contents(is_bookmarked, COALESCE(last_captured_at, first_captured_at) DESC, id);
    CREATE INDEX IF NOT EXISTS idx_content_observations_content_time
      ON content_observations(content_id, observed_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_content_observations_job
      ON content_observations(job_id, content_id) WHERE job_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_content_observations_snapshot
      ON content_observations(snapshot_id) WHERE snapshot_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_content_observations_contribution_time
      ON content_observations(contribution_id, observed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_content_metric_semantics_platform
      ON content_metric_semantics(platform_id, metric_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_content_metric_semantics_standard
      ON content_metric_semantics(contribution_id, semantics_revision, standard_metric_id)
      WHERE standard_metric_id IS NOT NULL;

    UPDATE contents
    SET last_captured_at = COALESCE(
      (
        SELECT MAX(content_snapshots.captured_at)
        FROM content_snapshots
        WHERE content_snapshots.content_id = contents.id
      ),
      first_captured_at
    )
    WHERE last_captured_at IS NULL;

    INSERT OR IGNORE INTO content_tags (content_id, tag)
    SELECT contents.id, CAST(tags.value AS TEXT)
    FROM contents
    CROSS JOIN json_each(
      CASE WHEN json_valid(contents.tags_json) THEN contents.tags_json ELSE '[]' END
    ) AS tags
    WHERE tags.type = 'text' AND length(trim(CAST(tags.value AS TEXT))) > 0;

    INSERT OR IGNORE INTO content_observations (
      id, content_id, job_id, snapshot_id, contribution_id, semantics_revision, observed_at
    )
    SELECT
      'legacy-snapshot:' || content_snapshots.id,
      content_snapshots.content_id,
      NULL,
      content_snapshots.id,
      COALESCE(accounts.adapter_contribution_id, ''),
      'legacy',
      content_snapshots.captured_at
    FROM content_snapshots
    JOIN contents ON contents.id = content_snapshots.content_id
    JOIN accounts ON accounts.id = contents.account_id;

    INSERT OR IGNORE INTO content_metric_semantics (
      contribution_id, semantics_revision, platform_id, metric_id, label, value_kind, unit, metric_group,
      sort_order, measurement_kind, standard_metric_id, updated_at
    )
    SELECT DISTINCT
      accounts.adapter_contribution_id,
      'legacy',
      definitions.platform_id,
      definitions.metric_id,
      definitions.label,
      definitions.value_kind,
      definitions.unit,
      definitions.metric_group,
      definitions.sort_order,
      definitions.measurement_kind,
      definitions.standard_metric_id,
      definitions.updated_at
    FROM content_metric_definitions definitions
    JOIN accounts ON accounts.platform_id = definitions.platform_id
    WHERE accounts.adapter_contribution_id IS NOT NULL
      AND trim(accounts.adapter_contribution_id) <> '';

    CREATE VIRTUAL TABLE IF NOT EXISTS content_fts USING fts5(
      title,
      body_excerpt,
      note,
      tags_json,
      content = 'contents',
      content_rowid = 'rowid',
      tokenize = 'trigram'
    );

    CREATE TRIGGER IF NOT EXISTS contents_fts_insert
    AFTER INSERT ON contents
    BEGIN
      INSERT INTO content_fts(rowid, title, body_excerpt, note, tags_json)
      VALUES (NEW.rowid, NEW.title, NEW.body_excerpt, NEW.note, NEW.tags_json);
    END;

    CREATE TRIGGER IF NOT EXISTS contents_fts_delete
    AFTER DELETE ON contents
    BEGIN
      INSERT INTO content_fts(content_fts, rowid, title, body_excerpt, note, tags_json)
      VALUES ('delete', OLD.rowid, OLD.title, OLD.body_excerpt, OLD.note, OLD.tags_json);
    END;

    CREATE TRIGGER IF NOT EXISTS contents_fts_update
    AFTER UPDATE OF title, body_excerpt, note, tags_json ON contents
    BEGIN
      INSERT INTO content_fts(content_fts, rowid, title, body_excerpt, note, tags_json)
      VALUES ('delete', OLD.rowid, OLD.title, OLD.body_excerpt, OLD.note, OLD.tags_json);
      INSERT INTO content_fts(rowid, title, body_excerpt, note, tags_json)
      VALUES (NEW.rowid, NEW.title, NEW.body_excerpt, NEW.note, NEW.tags_json);
    END;

    INSERT INTO content_fts(content_fts) VALUES ('rebuild');
    PRAGMA user_version = 14;
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
