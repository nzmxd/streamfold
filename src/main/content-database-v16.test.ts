import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import type { Account, PlatformId } from '../shared/contracts'
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

function rawDatabase(database: SocialDatabase): DatabaseSync {
  return (database as unknown as { db: DatabaseSync }).db
}
