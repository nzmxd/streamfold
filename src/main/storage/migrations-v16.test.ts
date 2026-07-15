import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { CURRENT_SCHEMA_VERSION, migrateDatabase, readUserVersion } from './migrations'

describe('SQLite v16 migration', () => {
  it('migrates v15 content data and backfills organization, provenance and search state', () => {
    const db = createV15Database()
    try {
      seedV15Content(db)

      migrateDatabase(db)

      expect(readUserVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
      expect(CURRENT_SCHEMA_VERSION).toBe(16)
      expect(columnNames(db, 'contents')).toEqual(expect.arrayContaining([
        'is_bookmarked',
        'last_captured_at'
      ]))
      expect(columnNames(db, 'content_metric_definitions')).toEqual(expect.arrayContaining([
        'measurement_kind',
        'standard_metric_id'
      ]))
      expect(db.prepare(`
        SELECT metric_id, measurement_kind, standard_metric_id
        FROM content_metric_definitions
      `).get()).toEqual({
        metric_id: 'impressions',
        measurement_kind: 'gauge',
        standard_metric_id: null
      })
      expect(db.prepare(`
        SELECT contribution_id, semantics_revision, platform_id, metric_id,
          measurement_kind, standard_metric_id
        FROM content_metric_semantics
      `).get()).toEqual({
        contribution_id: 'xiaohongshu-session-api.platform',
        semantics_revision: 'legacy',
        platform_id: 'xiaohongshu',
        metric_id: 'impressions',
        measurement_kind: 'gauge',
        standard_metric_id: null
      })
      for (const measurementKind of ['cumulative', 'period_total', 'gauge']) {
        expect(() => db.prepare(`
          UPDATE content_metric_definitions SET measurement_kind = ?
          WHERE platform_id = 'xiaohongshu' AND metric_id = 'impressions'
        `).run(measurementKind)).not.toThrow()
      }
      expect(() => db.prepare(`
        UPDATE content_metric_definitions SET measurement_kind = 'counter'
        WHERE platform_id = 'xiaohongshu' AND metric_id = 'impressions'
      `).run()).toThrow()
      expect(() => db.prepare(`
        UPDATE content_metric_definitions SET standard_metric_id = 'impressions'
        WHERE platform_id = 'xiaohongshu' AND metric_id = 'impressions'
      `).run()).toThrow()
      db.prepare(`
        UPDATE content_metric_semantics SET standard_metric_id = 'views'
        WHERE contribution_id = 'xiaohongshu-session-api.platform'
          AND semantics_revision = 'legacy' AND metric_id = 'impressions'
      `).run()
      expect(() => db.prepare(`
        INSERT INTO content_metric_semantics (
          contribution_id, semantics_revision, platform_id, metric_id, label, value_kind, unit, metric_group,
          sort_order, measurement_kind, standard_metric_id, updated_at
        ) VALUES (
          'xiaohongshu-session-api.platform', 'legacy', 'xiaohongshu', 'views', '观看',
          'count', 'count', 'reach', 2, 'cumulative', 'views', '2026-07-15T00:00:00.000Z'
        )
      `).run()).toThrow()

      expect(db.prepare(`
        SELECT id, is_bookmarked, last_captured_at
        FROM contents ORDER BY id
      `).all()).toEqual([
        {
          id: 'content-with-history',
          is_bookmarked: 0,
          last_captured_at: '2026-07-14T08:00:00.000Z'
        },
        {
          id: 'content-without-snapshot',
          is_bookmarked: 0,
          last_captured_at: '2026-07-12T08:00:00.000Z'
        }
      ])
      expect(db.prepare(`
        SELECT content_id, tag FROM content_tags ORDER BY content_id, tag
      `).all()).toEqual([
        { content_id: 'content-with-history', tag: '分析' },
        { content_id: 'content-with-history', tag: '重点内容' }
      ])
      expect(db.prepare(`
        SELECT id, content_id, job_id, snapshot_id, contribution_id, semantics_revision, observed_at
        FROM content_observations ORDER BY observed_at
      `).all()).toEqual([
        {
          id: 'legacy-snapshot:snapshot-old',
          content_id: 'content-with-history',
          job_id: null,
          snapshot_id: 'snapshot-old',
          contribution_id: 'xiaohongshu-session-api.platform',
          semantics_revision: 'legacy',
          observed_at: '2026-07-13T08:00:00.000Z'
        },
        {
          id: 'legacy-snapshot:snapshot-new',
          content_id: 'content-with-history',
          job_id: null,
          snapshot_id: 'snapshot-new',
          contribution_id: 'xiaohongshu-session-api.platform',
          semantics_revision: 'legacy',
          observed_at: '2026-07-14T08:00:00.000Z'
        }
      ])
      expect(matchContentIds(db, '历史标题')).toEqual(['content-with-history'])
      expect(matchContentIds(db, '本地备注')).toEqual(['content-with-history'])
      expect(matchContentIds(db, '重点内容')).toEqual(['content-with-history'])
    } finally {
      db.close()
    }
  })

  it('maintains external FTS rows and applies observation and tag foreign keys', () => {
    const db = createV15Database()
    try {
      migrateDatabase(db)
      db.prepare(`
        INSERT INTO contents (
          id, account_id, remote_id, type, title, body_excerpt, url, published_at,
          first_captured_at, updated_at, note, tags_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'live-content',
        'owner',
        'remote-live',
        'article',
        '刚刚插入标题',
        '初始正文摘要',
        'https://example.test/live',
        null,
        '2026-07-15T08:00:00.000Z',
        '2026-07-15T08:00:00.000Z',
        '',
        '[]'
      )
      const rowid = Number((db.prepare(`
        SELECT rowid FROM contents WHERE id = 'live-content'
      `).get() as { rowid: number }).rowid)
      expect(matchRowIds(db, '插入标题')).toEqual([rowid])

      db.prepare(`
        UPDATE contents
        SET title = '替换后的标题', note = '离线研究备注', tags_json = '["自定义标签"]'
        WHERE id = 'live-content'
      `).run()
      expect(matchRowIds(db, '插入标题')).toEqual([])
      expect(matchRowIds(db, '替换后的')).toEqual([rowid])
      expect(matchRowIds(db, '研究备注')).toEqual([rowid])
      expect(matchRowIds(db, '自定义标签')).toEqual([rowid])

      db.exec(`
        INSERT INTO jobs (id) VALUES ('live-job');
        INSERT INTO content_snapshots (id, content_id, captured_at)
        VALUES ('live-snapshot', 'live-content', '2026-07-15T08:01:00.000Z');
        INSERT INTO content_tags (content_id, tag) VALUES ('live-content', '自定义标签');
        INSERT INTO content_observations (
          id, content_id, job_id, snapshot_id, contribution_id, observed_at
        ) VALUES (
          'live-observation', 'live-content', 'live-job', 'live-snapshot',
          'xiaohongshu-session-api.platform', '2026-07-15T08:01:00.000Z'
        );
        DELETE FROM jobs WHERE id = 'live-job';
        DELETE FROM content_snapshots WHERE id = 'live-snapshot';
      `)
      expect(db.prepare(`
        SELECT job_id, snapshot_id FROM content_observations WHERE id = 'live-observation'
      `).get()).toEqual({ job_id: null, snapshot_id: null })

      db.prepare(`DELETE FROM contents WHERE id = 'live-content'`).run()
      expect(db.prepare(`SELECT count(*) AS count FROM content_tags`).get()).toEqual({ count: 0 })
      expect(db.prepare(`SELECT count(*) AS count FROM content_observations`).get()).toEqual({ count: 0 })
      expect(matchRowIds(db, '替换后的')).toEqual([])
    } finally {
      db.close()
    }
  })

  it('migrates a brand-new v0 database through v16', () => {
    const db = new DatabaseSync(':memory:')
    try {
      migrateDatabase(db)

      expect(readUserVersion(db)).toBe(16)
      expect(db.prepare(`
        SELECT name FROM sqlite_master
        WHERE name IN ('content_tags', 'content_observations', 'content_metric_semantics', 'content_fts')
        ORDER BY name
      `).all()).toEqual([
        { name: 'content_fts' },
        { name: 'content_metric_semantics' },
        { name: 'content_observations' },
        { name: 'content_tags' }
      ])
    } finally {
      db.close()
    }
  })
})

function createV15Database(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE accounts (
      id TEXT PRIMARY KEY,
      platform_id TEXT NOT NULL,
      adapter_contribution_id TEXT
    ) STRICT;

    CREATE TABLE contents (
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

    CREATE TABLE content_snapshots (
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

    CREATE TABLE jobs (
      id TEXT PRIMARY KEY
    ) STRICT;

    CREATE TABLE content_metric_definitions (
      platform_id TEXT NOT NULL,
      metric_id TEXT NOT NULL,
      label TEXT NOT NULL,
      value_kind TEXT NOT NULL,
      unit TEXT NOT NULL,
      metric_group TEXT NOT NULL,
      sort_order INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (platform_id, metric_id)
    ) STRICT;

    INSERT INTO accounts (id, platform_id, adapter_contribution_id)
    VALUES ('owner', 'xiaohongshu', 'xiaohongshu-session-api.platform');
    PRAGMA user_version = 15;
  `)
  return db
}

function seedV15Content(db: DatabaseSync): void {
  const insertContent = db.prepare(`
    INSERT INTO contents (
      id, account_id, remote_id, type, title, body_excerpt, url, published_at,
      first_captured_at, updated_at, note, tags_json
    ) VALUES (?, 'owner', ?, 'article', ?, ?, ?, NULL, ?, ?, ?, ?)
  `)
  insertContent.run(
    'content-with-history',
    'remote-history',
    '历史标题分析',
    '连续快照正文',
    'https://example.test/history',
    '2026-07-11T08:00:00.000Z',
    '2026-07-14T09:00:00.000Z',
    '本地备注资料',
    '["重点内容","分析","重点内容"]'
  )
  insertContent.run(
    'content-without-snapshot',
    'remote-no-snapshot',
    '没有历史快照',
    '',
    'https://example.test/no-snapshot',
    '2026-07-12T08:00:00.000Z',
    '2026-07-12T09:00:00.000Z',
    '',
    'not-json'
  )
  db.exec(`
    INSERT INTO content_snapshots (id, content_id, views, captured_at)
    VALUES
      ('snapshot-old', 'content-with-history', 10, '2026-07-13T08:00:00.000Z'),
      ('snapshot-new', 'content-with-history', 20, '2026-07-14T08:00:00.000Z');

    INSERT INTO content_metric_definitions (
      platform_id, metric_id, label, value_kind, unit, metric_group, sort_order, updated_at
    ) VALUES (
      'xiaohongshu', 'impressions', '曝光', 'count', 'count', 'reach', 1,
      '2026-07-14T08:00:00.000Z'
    );
  `)
}

function columnNames(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>)
    .map((column) => column.name)
}

function matchContentIds(db: DatabaseSync, phrase: string): string[] {
  return (db.prepare(`
    SELECT contents.id
    FROM content_fts
    JOIN contents ON contents.rowid = content_fts.rowid
    WHERE content_fts MATCH ?
    ORDER BY contents.id
  `).all(`"${phrase}"`) as unknown as Array<{ id: string }>).map((row) => row.id)
}

function matchRowIds(db: DatabaseSync, phrase: string): number[] {
  return (db.prepare(`
    SELECT rowid FROM content_fts WHERE content_fts MATCH ? ORDER BY rowid
  `).all(`"${phrase}"`) as unknown as Array<{ rowid: number }>).map((row) => Number(row.rowid))
}
