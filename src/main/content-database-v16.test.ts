import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Account, ContentFilterViewState, PlatformId } from '../shared/contracts'
import { SocialDatabase } from './database'

describe('SocialDatabase v16 content queries', () => {
  let database: SocialDatabase

  beforeEach(() => {
    database = new SocialDatabase(':memory:')
  })

  afterEach(() => {
    database.close()
  })

  it('searches literal short Chinese terms, escaped wildcard characters and hybrid terms', () => {
    const group = database.createGroup({ name: '重点组', color: '#339cff' })
    const first = createAccount(database, 'xiaohongshu', '运营账号', [group.id])
    const second = createAccount(database, 'zhihu', '问答账号')
    seedContent(database, {
      id: 'content-a',
      accountId: first.id,
      title: '知乎运营复盘方法',
      bodyExcerpt: '增长实验记录',
      note: '保留 %_ 标记',
      tags: ['运营', '重点'],
      isBookmarked: true,
      publishedAt: '2026-07-10T08:00:00.000Z',
      capturedAt: '2026-07-12T08:00:00.000Z'
    })
    seedContent(database, {
      id: 'content-b',
      accountId: first.id,
      title: '小红书运营复盘方法',
      tags: ['运营'],
      publishedAt: '2026-07-11T08:00:00.000Z',
      capturedAt: '2026-07-13T08:00:00.000Z'
    })
    seedContent(database, {
      id: 'content-c',
      accountId: second.id,
      title: '知乎日常记录',
      tags: ['重点'],
      isBookmarked: true,
      publishedAt: '2026-07-09T08:00:00.000Z',
      capturedAt: '2026-07-14T08:00:00.000Z'
    })

    expect(database.searchContents({ keyword: '知乎' })).toMatchObject({
      total: 2,
      searchMode: 'like'
    })
    expect(database.searchContents({ keyword: '运营复盘 知乎' })).toMatchObject({
      total: 1,
      searchMode: 'hybrid',
      items: [{ id: 'content-a' }]
    })
    expect(database.searchContents({ keyword: '%_' }).items.map(({ id }) => id)).toEqual(['content-a'])
    expect(database.searchContents({ keyword: '复盘" OR title:*' })).toMatchObject({
      total: 0,
      searchMode: 'hybrid'
    })
  })

  it('combines account, group, tag, bookmark and time filters with stable pagination', () => {
    const group = database.createGroup({ name: '工作号', color: '#36a76c' })
    const first = createAccount(database, 'xiaohongshu', '账号 A', [group.id])
    const second = createAccount(database, 'zhihu', '账号 B')
    seedContent(database, {
      id: 'content-a', accountId: first.id, title: 'A', tags: ['运营', '重点'], isBookmarked: true,
      publishedAt: '2026-07-10T08:00:00.000Z', capturedAt: '2026-07-12T08:00:00.000Z'
    })
    seedContent(database, {
      id: 'content-b', accountId: first.id, title: 'B', tags: ['运营'], isBookmarked: false,
      publishedAt: '2026-07-11T08:00:00.000Z', capturedAt: '2026-07-13T08:00:00.000Z'
    })
    seedContent(database, {
      id: 'content-c', accountId: second.id, title: 'C', tags: ['重点'], isBookmarked: true,
      publishedAt: '2026-07-12T08:00:00.000Z', capturedAt: '2026-07-14T08:00:00.000Z'
    })
    const db = rawDatabase(database)
    seedBaseSnapshot(db, 'content-a', 'snapshot-a', 100, 40)
    seedBaseSnapshot(db, 'content-b', 'snapshot-b', 200, 2)
    seedBaseSnapshot(db, 'content-c', 'snapshot-c', 50, 500)

    expect(database.searchContents({ tags: ['运营', '重点'], tagMatch: 'all' }).items.map(({ id }) => id))
      .toEqual(['content-a'])
    expect(database.searchContents({ tags: ['运营', '重点'], tagMatch: 'any' }).total).toBe(3)
    expect(database.searchContents({ accountIds: [first.id], type: 'article' }).total).toBe(2)
    expect(database.searchContents({
      groupId: group.id,
      platformId: 'xiaohongshu',
      bookmarked: true,
      publishedFrom: '2026-07-10T00:00:00.000Z',
      publishedTo: '2026-07-10T23:59:59.999Z',
      capturedFrom: '2026-07-12T00:00:00.000Z',
      capturedTo: '2026-07-12T23:59:59.999Z'
    }).items.map(({ id }) => id)).toEqual(['content-a'])

    const firstPage = database.searchContents({ sort: 'published', order: 'desc', limit: 1 })
    const secondPage = database.searchContents({ sort: 'published', order: 'desc', limit: 1, offset: 1 })
    expect(firstPage).toMatchObject({ total: 3, limit: 1, offset: 0, hasMore: true })
    expect(firstPage.items[0]?.id).toBe('content-c')
    expect(secondPage).toMatchObject({ total: 3, limit: 1, offset: 1, hasMore: true })
    expect(secondPage.items[0]?.id).toBe('content-b')
    expect(database.searchContents({ sort: 'views', order: 'desc' }).items.map(({ id }) => id))
      .toEqual(['content-b', 'content-a', 'content-c'])
    expect(database.searchContents({ sort: 'interactions', order: 'desc' }).items.map(({ id }) => id))
      .toEqual(['content-c', 'content-a', 'content-b'])
  })

  it('filters contents by the latest successful sync warning job', () => {
    const account = createAccount(database, 'xiaohongshu', '同步账号')
    seedContent(database, { id: 'content-warning', accountId: account.id, title: '仍有异常' })
    seedContent(database, { id: 'content-recovered', accountId: account.id, title: '已经恢复' })
    seedContent(database, { id: 'content-clean', accountId: account.id, title: '一直正常' })
    const warningJob = database.createJob({
      id: 'warning-job',
      kind: 'managed_sync',
      accountId: account.id,
      pluginId: 'test.plugin',
      status: 'succeeded_with_warnings',
      createdAt: '2026-07-15T08:00:00.000Z',
      finishedAt: '2026-07-15T08:01:00.000Z'
    })
    const cleanJob = database.createJob({
      id: 'clean-job',
      kind: 'managed_sync',
      accountId: account.id,
      pluginId: 'test.plugin',
      status: 'succeeded',
      createdAt: '2026-07-15T08:02:00.000Z',
      finishedAt: '2026-07-15T08:03:00.000Z'
    })
    const db = rawDatabase(database)
    seedObservation(db, 'warning-observation', 'content-warning', warningJob.id)
    seedObservation(db, 'recovered-warning-observation', 'content-recovered', warningJob.id)
    seedObservation(db, 'recovered-clean-observation', 'content-recovered', cleanJob.id)
    seedObservation(db, 'clean-observation', 'content-clean', cleanJob.id)

    expect(database.searchContents({ syncWarningOnly: true, limit: 1 })).toMatchObject({
      total: 1,
      hasMore: false,
      items: [{ id: 'content-warning' }]
    })
    expect(database.searchContents({ syncWarningOnly: false }).total).toBe(3)
  })

  it('persists bounded named filter views and preserves creation time on updates', () => {
    const state = defaultFilterViewState()
    const created = database.saveContentFilterView({ name: 'Daily Review', state })

    expect(created.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(database.getSetting('content.filterViews.v1')).toEqual([created])
    expect(() => database.saveContentFilterView({ name: 'daily review', state }))
      .toThrow('筛选视图名称已存在')

    const updated = database.saveContentFilterView({
      id: created.id,
      name: 'DAILY REVIEW',
      state: { ...state, bookmark: 'bookmarked', pageSize: 100 }
    })
    expect(updated).toMatchObject({
      id: created.id,
      name: 'DAILY REVIEW',
      state: { bookmark: 'bookmarked', pageSize: 100 },
      createdAt: created.createdAt
    })
    expect(database.listContentFilterViews()).toEqual([updated])
    expect(() => database.saveContentFilterView({ id: 'missing-view', name: 'Missing', state }))
      .toThrow('筛选视图不存在')

    database.deleteContentFilterView(created.id)
    expect(database.listContentFilterViews()).toEqual([])
    expect(() => database.deleteContentFilterView(created.id)).toThrow('筛选视图不存在')
    for (let index = 0; index < 30; index += 1) {
      database.saveContentFilterView({ name: `视图 ${index}`, state })
    }
    expect(database.listContentFilterViews()).toHaveLength(30)
    expect(() => database.saveContentFilterView({ name: '第 31 个', state }))
      .toThrow('筛选视图最多保存 30 个')
  })

  it('reopens saved filter views and safely skips corrupted stored entries', () => {
    const directory = mkdtempSync(join(tmpdir(), 'streamfold-content-views-'))
    const path = join(directory, 'content-views.sqlite')
    let persistent: SocialDatabase | null = new SocialDatabase(path)
    try {
      const created = persistent.saveContentFilterView({
        name: '持久视图',
        state: { ...defaultFilterViewState(), syncWarningOnly: true }
      })
      persistent.close()
      persistent = null
      persistent = new SocialDatabase(path)
      expect(persistent.listContentFilterViews()).toEqual([created])

      const second = {
        ...created,
        id: 'view-2',
        name: '第二视图',
        createdAt: '2026-07-19T00:00:00.000Z',
        updatedAt: '2026-07-19T00:00:00.000Z'
      }
      persistent.setSetting('content.filterViews.v1', [
        null,
        { malformed: true },
        created,
        { ...created, name: '重复 ID' },
        second,
        { ...second, id: 'view-3', name: created.name }
      ])
      expect(new Set(persistent.listContentFilterViews().map((view) => view.id)))
        .toEqual(new Set([created.id, second.id]))

      rawDatabase(persistent).prepare(`
        UPDATE app_settings SET value_json = ? WHERE key = 'content.filterViews.v1'
      `).run('{broken-json')
      expect(persistent.listContentFilterViews()).toEqual([])
    } finally {
      persistent?.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('keeps tag facets, JSON tags and bookmarks consistent across single and bulk updates', () => {
    const group = database.createGroup({ name: '工作号', color: '#36a76c' })
    const account = createAccount(database, 'xiaohongshu', '账号 A', [group.id])
    seedContent(database, { id: 'content-a', accountId: account.id, title: 'A', tags: ['原标签'] })
    seedContent(database, { id: 'content-b', accountId: account.id, title: 'B', tags: ['原标签', '保留'] })

    expect(database.bulkUpdateContents({
      contentIds: ['content-a', 'content-a', 'content-b'],
      isBookmarked: true,
      tagChange: { action: 'add', tags: [' 新增 ', '新增'] }
    })).toEqual({ requestedCount: 2, updatedCount: 2 })
    expect(database.searchContents({ bookmarked: true }).items.map(({ id }) => id).sort())
      .toEqual(['content-a', 'content-b'])
    expect(database.listContentTags({ groupId: group.id })).toEqual([
      { tag: '原标签', count: 2 },
      { tag: '新增', count: 2 },
      { tag: '保留', count: 1 }
    ])

    expect(database.updateContent({
      id: 'content-a', note: '本地备注', tags: [' 单条 ', '单条'], isBookmarked: false
    })).toMatchObject({ note: '本地备注', tags: ['单条'], isBookmarked: false })
    expect(database.searchContents({ tags: ['新增'] }).items.map(({ id }) => id)).toEqual(['content-b'])
    expect(rawDatabase(database).prepare(`
      SELECT tag FROM content_tags WHERE content_id = ? ORDER BY tag
    `).all('content-a')).toEqual([{ tag: '单条' }])

    expect(() => database.bulkUpdateContents({
      contentIds: ['content-b', 'missing'],
      isBookmarked: false
    })).toThrow('内容不存在')
    expect(database.searchContents({ bookmarked: true }).items.map(({ id }) => id)).toEqual(['content-b'])
  })

  it('maps the latest two snapshots and dynamic metrics with a constant number of batch queries', () => {
    const account = createAccount(database, 'xiaohongshu', '批量账号')
    const db = rawDatabase(database)
    db.prepare(`
      INSERT INTO content_metric_definitions (
        platform_id, metric_id, label, value_kind, unit, metric_group, sort_order,
        measurement_kind, standard_metric_id, updated_at
      ) VALUES ('xiaohongshu', 'impressions', '曝光', 'count', 'count', 'reach', 1,
        'cumulative', 'views', '2026-07-15T00:00:00.000Z')
    `).run()
    for (let index = 0; index < 20; index += 1) {
      const id = `content-${index}`
      seedContent(database, {
        id,
        accountId: account.id,
        title: `批量内容 ${index}`,
        publishedAt: `2026-07-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
        capturedAt: '2026-07-15T08:00:00.000Z'
      })
      seedSnapshot(db, id, `${id}-old`, '2026-07-14T08:00:00.000Z', index, index * 10)
      seedSnapshot(db, id, `${id}-latest`, '2026-07-15T08:00:00.000Z', index + 1, index * 10 + 1)
    }

    const preparedSql: string[] = []
    const originalPrepare = db.prepare.bind(db)
    db.prepare = ((sql: string) => {
      preparedSql.push(sql)
      return originalPrepare(sql)
    }) as DatabaseSync['prepare']
    let contents
    try {
      contents = database.listContents({ accountId: account.id, limit: 100 })
    } finally {
      db.prepare = originalPrepare as DatabaseSync['prepare']
    }

    expect(contents).toHaveLength(20)
    expect(contents[0]).toMatchObject({
      lastCapturedAt: '2026-07-15T08:00:00.000Z',
      isBookmarked: false,
      latestSnapshot: { views: 20, metrics: { impressions: 191 } },
      previousSnapshot: { views: 19, metrics: { impressions: 190 } }
    })
    expect(preparedSql.filter((sql) => sql.includes('WITH ranked AS'))).toHaveLength(1)
    expect(preparedSql.filter((sql) => sql.includes('FROM content_snapshot_metrics'))).toHaveLength(1)
    expect(preparedSql.filter((sql) => sql.includes('WHERE content_id = ?'))).toHaveLength(0)

    const definition = database.getContentDetail(contents[0]!.id).metricDefinitions[0]
    expect(definition).toMatchObject({
      id: 'impressions', measurementKind: 'cumulative', standardMetricId: 'views'
    })
  })
})

interface SeedContentInput {
  id: string
  accountId: string
  title: string
  bodyExcerpt?: string
  note?: string
  tags?: string[]
  isBookmarked?: boolean
  publishedAt?: string | null
  capturedAt?: string
}

function createAccount(
  database: SocialDatabase,
  platformId: PlatformId,
  alias: string,
  groupIds: string[] = []
): Account {
  const account = database.createAccount({ platformId, alias, syncMode: 'profile_only' })
  return groupIds.length === 0 ? account : database.updateAccount({ id: account.id, groupIds })
}

function seedContent(database: SocialDatabase, input: SeedContentInput): void {
  const db = rawDatabase(database)
  const tags = input.tags ?? []
  const capturedAt = input.capturedAt ?? '2026-07-15T08:00:00.000Z'
  db.prepare(`
    INSERT INTO contents (
      id, account_id, remote_id, type, title, body_excerpt, url, published_at,
      first_captured_at, last_captured_at, updated_at, note, tags_json, is_bookmarked
    ) VALUES (?, ?, ?, 'article', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    input.accountId,
    `remote-${input.id}`,
    input.title,
    input.bodyExcerpt ?? '',
    `https://example.com/${input.id}`,
    input.publishedAt ?? null,
    capturedAt,
    capturedAt,
    capturedAt,
    input.note ?? '',
    JSON.stringify(tags),
    input.isBookmarked ? 1 : 0
  )
  const insertTag = db.prepare('INSERT INTO content_tags (content_id, tag) VALUES (?, ?)')
  for (const tag of tags) insertTag.run(input.id, tag)
}

function seedSnapshot(
  db: DatabaseSync,
  contentId: string,
  snapshotId: string,
  capturedAt: string,
  views: number,
  impressions: number
): void {
  db.prepare(`
    INSERT INTO content_snapshots (
      id, content_id, views, likes, comments, shares, favorites, captured_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(snapshotId, contentId, views, views, views, views, views, capturedAt)
  db.prepare(`
    INSERT INTO content_snapshot_metrics (snapshot_id, platform_id, metric_id, value)
    VALUES (?, 'xiaohongshu', 'impressions', ?)
  `).run(snapshotId, impressions)
}

function seedBaseSnapshot(
  db: DatabaseSync,
  contentId: string,
  snapshotId: string,
  views: number,
  interactions: number
): void {
  db.prepare(`
    INSERT INTO content_snapshots (
      id, content_id, views, likes, comments, shares, favorites, captured_at
    ) VALUES (?, ?, ?, ?, 0, 0, 0, '2026-07-15T08:00:00.000Z')
  `).run(snapshotId, contentId, views, interactions)
}

function seedObservation(
  db: DatabaseSync,
  id: string,
  contentId: string,
  jobId: string
): void {
  db.prepare(`
    INSERT INTO content_observations (
      id, content_id, job_id, snapshot_id, contribution_id, semantics_revision, observed_at
    ) VALUES (?, ?, ?, NULL, 'test.plugin.platform', 'test-revision', '2026-07-15T08:00:00.000Z')
  `).run(id, contentId, jobId)
}

function defaultFilterViewState(): ContentFilterViewState {
  return {
    keyword: '',
    accountId: '',
    platformId: '',
    groupId: '',
    type: '',
    tags: [],
    tagMatch: 'all',
    bookmark: 'all',
    syncWarningOnly: false,
    publishedFrom: '',
    publishedTo: '',
    capturedFrom: '',
    capturedTo: '',
    sort: 'published',
    order: 'desc',
    pageSize: 50
  }
}

function rawDatabase(database: SocialDatabase): DatabaseSync {
  return (database as unknown as { db: DatabaseSync }).db
}
