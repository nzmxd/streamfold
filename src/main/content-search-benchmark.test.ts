import { performance } from 'node:perf_hooks'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ContentSummary } from '../shared/contracts'
import { SocialDatabase } from './database'
import { serializeContentCsv } from './export-format'

const enabled = process.env.STREAMFOLD_BENCHMARK === '1'
const CONTENT_COUNT = 100_000

describe.skipIf(!enabled)('100k content search benchmark', () => {
  let database: SocialDatabase

  beforeAll(() => {
    database = new SocialDatabase(':memory:')
    const account = database.createAccount({
      platformId: 'benchmark.platform',
      alias: '基准账号',
      syncMode: 'profile_only'
    })
    const raw = (database as unknown as { db: DatabaseSync }).db
    const insert = raw.prepare(`
      INSERT INTO contents (
        id, account_id, remote_id, type, title, body_excerpt, url, published_at,
        first_captured_at, last_captured_at, updated_at, note, tags_json, is_bookmarked
      ) VALUES (?, ?, ?, 'article', ?, ?, '', ?, ?, ?, ?, ?, ?, 0)
    `)
    const insertSnapshot = raw.prepare(`
      INSERT INTO content_snapshots (
        id, content_id, views, likes, comments, shares, favorites, captured_at
      ) VALUES (?, ?, ?, NULL, NULL, NULL, NULL, ?)
    `)
    const insertObservation = raw.prepare(`
      INSERT INTO content_observations (
        id, content_id, job_id, snapshot_id, contribution_id, semantics_revision, observed_at
      ) VALUES (?, ?, NULL, ?, 'benchmark.adapter', 'benchmark-revision', ?)
    `)
    raw.exec('BEGIN IMMEDIATE')
    try {
      for (let index = 0; index < CONTENT_COUNT; index += 1) {
        const day = String((index % 28) + 1).padStart(2, '0')
        const timestamp = `2026-06-${day}T08:00:00.000Z`
        const hit = index % 997 === 0
        insert.run(
          `content-${index}`,
          account.id,
          `remote-${index}`,
          hit ? `可靠分析复盘 ${index}` : `普通内容记录 ${index}`,
          hit ? '连续观察与指标语义' : '日常内容摘要',
          timestamp,
          timestamp,
          timestamp,
          timestamp,
          hit ? '重点样本' : '',
          hit ? '["分析"]' : '[]'
        )
        const contentId = `content-${index}`
        const previousSnapshotId = `snapshot-${index}-previous`
        const currentSnapshotId = `snapshot-${index}-current`
        const previousObservedAt = '2026-06-29T08:00:00.000Z'
        const currentObservedAt = '2026-06-30T08:00:00.000Z'
        insertSnapshot.run(previousSnapshotId, contentId, index, previousObservedAt)
        insertSnapshot.run(currentSnapshotId, contentId, index + 10, currentObservedAt)
        insertObservation.run(
          `observation-${index}-previous`, contentId, previousSnapshotId, previousObservedAt
        )
        insertObservation.run(
          `observation-${index}-current`, contentId, currentSnapshotId, currentObservedAt
        )
      }
      raw.exec('COMMIT')
    } catch (error) {
      raw.exec('ROLLBACK')
      throw error
    }
    raw.exec(`INSERT INTO content_fts(content_fts) VALUES ('optimize')`)
  }, 120_000)

  afterAll(() => database.close())

  it('records first-page keyword latency without a machine-independent threshold', () => {
    database.searchContents({ keyword: '可靠分析', limit: 50 })
    const samples: number[] = []
    let total = 0
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const startedAt = performance.now()
      const page = database.searchContents({ keyword: '可靠分析', limit: 50 })
      samples.push(performance.now() - startedAt)
      total = page.total
      expect(page.items.length).toBeLessThanOrEqual(50)
    }
    expect(total).toBeGreaterThan(0)
    const sorted = [...samples].sort((left, right) => left - right)
    const medianMs = sorted[Math.floor(sorted.length / 2)]!
    console.info(JSON.stringify({
      benchmark: 'content-search-100k',
      contentCount: CONTENT_COUNT,
      resultCount: total,
      medianMs: Number(medianMs.toFixed(2)),
      samplesMs: samples.map((value) => Number(value.toFixed(2)))
    }))
  })

  it('records full pagination, CSV serialization and quality-summary latency', () => {
    const paginationStartedAt = performance.now()
    const contents: ContentSummary[] = []
    for (let offset = 0; ; offset += 5_000) {
      const page = database.searchContents({ sort: 'captured', limit: 5_000, offset }, 5_000)
      contents.push(...page.items)
      if (!page.hasMore) break
    }
    const paginationMs = performance.now() - paginationStartedAt
    expect(contents).toHaveLength(CONTENT_COUNT)

    const csvStartedAt = performance.now()
    const csv = serializeContentCsv(contents)
    const csvMs = performance.now() - csvStartedAt
    expect(csv).toContain('platform_id')
    expect(csv).toContain('remote-99999')

    const analyticsStartedAt = performance.now()
    const summary = database.getAnalyticsSummary({ standardMetricIds: ['views'] })
    const analyticsMs = performance.now() - analyticsStartedAt
    expect(summary.quality).toMatchObject({
      contentCount: CONTENT_COUNT,
      observedContentCount: CONTENT_COUNT,
      unobservedContentCount: 0
    })
    console.info(JSON.stringify({
      benchmark: 'content-workflow-100k',
      contentCount: CONTENT_COUNT,
      paginationMs: Number(paginationMs.toFixed(2)),
      csvSerializationMs: Number(csvMs.toFixed(2)),
      csvBytes: Buffer.byteLength(csv, 'utf8'),
      analyticsSummaryMs: Number(analyticsMs.toFixed(2))
    }))
  }, 30_000)
})
