import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PlatformId } from '../shared/contracts'
import type { StandardDataset } from './plugins/types'
import {
  XIAOHONGSHU_PLATFORM_CONTRIBUTION_ID,
  ZHIHU_PLATFORM_CONTRIBUTION_ID,
  xiaohongshuPluginManifestV2,
  zhihuPluginManifestV2
} from './plugins/builtin-manifests'
import { SocialDatabase } from './database'

describe('SocialDatabase reliable analytics', () => {
  let database: SocialDatabase

  beforeEach(() => {
    database = new SocialDatabase(':memory:')
  })

  afterEach(() => {
    database.close()
  })

  it('derives a zero delta from two observations that point to the same snapshot', () => {
    const account = createManagedAccount(database, 'xiaohongshu', 'same-owner', '同值账号')
    commitDataset(database, account.id, dataset({
      remoteAccountId: 'same-owner',
      capturedAt: '2026-06-01T08:00:00.000Z',
      followers: 10,
      contents: [content('same-content', '2026-05-01T08:00:00.000Z', 100)]
    }))
    const second = dataset({
      remoteAccountId: 'same-owner',
      capturedAt: '2026-06-02T08:00:00.000Z',
      followers: 12,
      contents: [content('same-content', '2026-05-01T08:00:00.000Z', 100)],
      warnings: ['列表接口本次只返回最近内容']
    })
    expect(commitDataset(database, account.id, second)).toMatchObject({
      snapshotCount: 0,
      skippedSnapshotCount: 1
    })

    const contentId = database.listContents({ accountId: account.id })[0]!.id
    const observations = database.listContentObservations(contentId)
    expect(observations).toHaveLength(2)
    expect(observations[0]!.snapshotId).toBe(observations[1]!.snapshotId)

    const summary = database.getAnalyticsSummary({
      accountIds: [account.id],
      standardMetricIds: ['views', 'followers', 'content_count']
    })
    expect(summary.metrics).toEqual([
      expect.objectContaining({
        metricId: 'views', current: 100, delta: 0, growthRate: 0,
        sampleCount: 1, missingCount: 0, revisionCount: 0, status: 'complete'
      }),
      expect.objectContaining({
        metricId: 'followers', current: 12, delta: 2, growthRate: 0.2,
        sampleCount: 1, missingCount: 0, revisionCount: 0, status: 'complete'
      }),
      expect.objectContaining({
        metricId: 'content_count', current: 1, delta: 0, growthRate: 0,
        sampleCount: 1, missingCount: 0, revisionCount: 0, status: 'complete'
      })
    ])
    expect(summary.quality).toMatchObject({
      contentCount: 1,
      observedContentCount: 1,
      unobservedContentCount: 0,
      missingPublishedAtCount: 0,
      latestObservationAt: '2026-06-02T08:00:00.000Z'
    })
    expect(summary.quality.accounts).toEqual([
      expect.objectContaining({
        accountId: account.id,
        contentCount: 1,
        observedContentCount: 1,
        latestObservationAt: '2026-06-02T08:00:00.000Z'
      })
    ])
    expect(summary.quality.warnings).toEqual([
      expect.objectContaining({
        accountId: account.id,
        message: '列表接口本次只返回最近内容'
      })
    ])
    const capturedBoundary = database.getAnalyticsSummary({
      accountIds: [account.id],
      capturedTo: second.capturedAt,
      standardMetricIds: ['views']
    })
    expect(capturedBoundary.quality.warnings.map((warning) => warning.message)).toEqual([
      '列表接口本次只返回最近内容'
    ])
  })

  it('does not claim an old metric snapshot was observed when a content has no snapshot payload', () => {
    const account = createManagedAccount(database, 'xiaohongshu', 'metadata-owner', '资料账号')
    const initialContent = content('metadata-content', '2026-05-01T08:00:00.000Z', 100)
    commitDataset(database, account.id, dataset({
      remoteAccountId: 'metadata-owner',
      capturedAt: '2026-06-01T08:00:00.000Z',
      contents: [initialContent]
    }))
    commitDataset(database, account.id, dataset({
      remoteAccountId: 'metadata-owner',
      capturedAt: '2026-06-02T08:00:00.000Z',
      contents: [{ ...initialContent, snapshots: [] }]
    }))

    const stored = database.listContents({ accountId: account.id })[0]!
    expect(database.listContentObservations(stored.id)).toEqual([
      expect.objectContaining({
        observedAt: '2026-06-01T08:00:00.000Z',
        snapshotId: expect.any(String)
      }),
      expect.objectContaining({
        observedAt: '2026-06-02T08:00:00.000Z',
        snapshotId: null
      })
    ])
    expect(database.getAnalyticsSummary({
      accountIds: [account.id], standardMetricIds: ['views']
    }).metrics[0]).toMatchObject({
      current: null,
      delta: null,
      growthRate: null,
      status: 'missing'
    })
  })

  it('keeps missing values null and marks cumulative counter decreases as revisions', () => {
    const account = createManagedAccount(database, 'xiaohongshu', 'revision-owner', '修订账号')
    commitDataset(database, account.id, dataset({
      remoteAccountId: 'revision-owner',
      capturedAt: '2026-06-01T08:00:00.000Z',
      contentCount: 2,
      contents: [
        content('revised-content', '2026-05-01T08:00:00.000Z', 100),
        content('missing-content', '2026-05-02T08:00:00.000Z', 50)
      ]
    }))
    commitDataset(database, account.id, dataset({
      remoteAccountId: 'revision-owner',
      capturedAt: '2026-06-02T08:00:00.000Z',
      contentCount: 2,
      contents: [
        content('revised-content', '2026-05-01T08:00:00.000Z', 90),
        content('missing-content', '2026-05-02T08:00:00.000Z', null)
      ]
    }))

    const summary = database.getAnalyticsSummary({
      accountIds: [account.id],
      standardMetricIds: ['views']
    })
    expect(summary.metrics[0]).toMatchObject({
      metricId: 'views',
      current: 90,
      delta: null,
      growthRate: null,
      sampleCount: 1,
      missingCount: 1,
      revisionCount: 1,
      status: 'revision'
    })
    expect(summary.quality).toMatchObject({
      missingMetricCounts: { views: 1 },
      revisionCount: 1
    })
  })

  it('uses declared dynamic mappings only as fallback and compares standard metrics in one scope', () => {
    const dynamicAccount = createManagedAccount(
      database, 'xiaohongshu', 'dynamic-owner', '动态指标账号'
    )
    const fixedAccount = createManagedAccount(database, 'zhihu', 'fixed-owner', '固定指标账号')
    const group = database.createGroup({ name: '重点组', color: '#339cff' })
    database.updateAccount({ id: dynamicAccount.id, groupIds: [group.id] })
    const definitions: NonNullable<StandardDataset['contentMetricDefinitions']> = [{
      id: 'play_count',
      label: '播放量',
      valueKind: 'count',
      unit: 'count',
      group: 'reach',
      sortOrder: 1,
      measurementKind: 'cumulative',
      standardMetricId: 'views'
    }]

    commitDataset(database, dynamicAccount.id, dataset({
      remoteAccountId: 'dynamic-owner',
      capturedAt: '2026-06-01T08:00:00.000Z',
      definitions,
      contents: [dynamicContent('dynamic-content', null, 100)]
    }))
    commitDataset(database, dynamicAccount.id, dataset({
      remoteAccountId: 'dynamic-owner',
      capturedAt: '2026-06-02T08:00:00.000Z',
      definitions,
      contents: [dynamicContent('dynamic-content', null, 150)]
    }))
    commitDataset(database, fixedAccount.id, dataset({
      remoteAccountId: 'fixed-owner',
      capturedAt: '2026-06-01T08:00:00.000Z',
      definitions,
      contents: [dynamicContent('fixed-content', 20, 900)]
    }))
    commitDataset(database, fixedAccount.id, dataset({
      remoteAccountId: 'fixed-owner',
      capturedAt: '2026-06-02T08:00:00.000Z',
      definitions,
      contents: [dynamicContent('fixed-content', 25, 1_000)]
    }))

    const comparison = database.getAnalyticsComparison({
      dimension: 'platform',
      standardMetricIds: ['views']
    })
    expect(comparison.rows).toEqual([
      expect.objectContaining({
        id: 'xiaohongshu',
        platformId: 'xiaohongshu',
        contentCount: 1,
        metrics: [expect.objectContaining({ current: 150, delta: 50, growthRate: 0.5 })]
      }),
      expect.objectContaining({
        id: 'zhihu',
        platformId: 'zhihu',
        contentCount: 1,
        metrics: [expect.objectContaining({ current: 25, delta: 5, growthRate: 0.25 })]
      })
    ])

    const byGroup = database.getAnalyticsComparison({
      dimension: 'group',
      standardMetricIds: ['views']
    })
    expect(byGroup.rows).toEqual([
      expect.objectContaining({
        id: group.id,
        label: '重点组',
        platformId: null,
        contentCount: 1,
        metrics: [expect.objectContaining({ current: 150, delta: 50 })]
      }),
      expect.objectContaining({
        id: '__ungrouped__',
        label: '未分组',
        platformId: null,
        contentCount: 1,
        metrics: [expect.objectContaining({ current: 25, delta: 5 })]
      })
    ])
  })

  it('keeps historical metric semantics pinned to the package revision that observed them', () => {
    const account = createManagedAccount(database, 'xiaohongshu', 'revision-mapping-owner', '版本语义账号')
    const baseDefinition = {
      id: 'play_count', label: '播放量', valueKind: 'count' as const, unit: 'count' as const,
      group: 'reach' as const, sortOrder: 1, measurementKind: 'cumulative' as const
    }
    commitDataset(database, account.id, dataset({
      remoteAccountId: 'revision-mapping-owner',
      capturedAt: '2026-06-01T08:00:00.000Z',
      definitions: [{ ...baseDefinition, standardMetricId: null }],
      contents: [dynamicContent('revision-mapping-content', null, 100)]
    }), 'revision-a')
    commitDataset(database, account.id, dataset({
      remoteAccountId: 'revision-mapping-owner',
      capturedAt: '2026-06-02T08:00:00.000Z',
      definitions: [{ ...baseDefinition, standardMetricId: 'views' }],
      contents: [dynamicContent('revision-mapping-content', null, 150)]
    }), 'revision-b')

    expect(database.getAnalyticsSummary({
      accountIds: [account.id], standardMetricIds: ['views']
    }).metrics[0]).toMatchObject({
      current: 150,
      delta: null,
      growthRate: null,
      sampleCount: 1,
      status: 'partial'
    })
    const stored = database.listContents({ accountId: account.id })[0]!
    expect(database.listContentObservations(stored.id).map(({ semanticsRevision }) => semanticsRevision))
      .toEqual(['revision-a', 'revision-b'])
  })

  it('selects only reliable lifecycle milestones, including the tolerance boundary', () => {
    const account = createManagedAccount(database, 'xiaohongshu', 'lifecycle-owner', '生命周期账号')
    const publishedAt = '2025-01-01T00:00:00.000Z'
    commitDataset(database, account.id, dataset({
      remoteAccountId: 'lifecycle-owner',
      capturedAt: '2025-01-02T00:00:00.000Z',
      contents: [content('lifecycle-main', publishedAt, 10)]
    }))
    commitDataset(database, account.id, dataset({
      remoteAccountId: 'lifecycle-owner',
      capturedAt: '2025-01-08T00:00:00.000Z',
      contents: [content('lifecycle-main', publishedAt, 70)]
    }))
    commitDataset(database, account.id, dataset({
      remoteAccountId: 'lifecycle-owner',
      capturedAt: '2025-01-31T00:00:00.000Z',
      contents: [content('lifecycle-main', publishedAt, 60)]
    }))

    const tolerancePublishedAt = '2025-03-01T00:00:00.000Z'
    commitDataset(database, account.id, dataset({
      remoteAccountId: 'lifecycle-owner',
      capturedAt: '2025-03-02T06:00:00.000Z',
      contents: [content('lifecycle-boundary', tolerancePublishedAt, 40)]
    }))
    const missingPublishedAt = '2025-04-01T00:00:00.000Z'
    commitDataset(database, account.id, dataset({
      remoteAccountId: 'lifecycle-owner',
      capturedAt: '2025-04-04T00:00:00.000Z',
      contents: [content('lifecycle-missing', missingPublishedAt, 30)]
    }))
    const pendingPublishedAt = new Date(Date.now() - 12 * 60 * 60 * 1_000).toISOString()
    commitDataset(database, account.id, dataset({
      remoteAccountId: 'lifecycle-owner',
      capturedAt: new Date().toISOString(),
      contents: [content('lifecycle-pending', pendingPublishedAt, 5)]
    }))

    const lifecycle = database.getContentLifecycle({
      accountIds: [account.id],
      standardMetricId: 'views',
      limit: 20
    })
    expect(lifecycle.total).toBe(4)
    const main = lifecycle.items.find((item) => item.title.includes('lifecycle-main'))!
    expect(main.milestones).toEqual([
      expect.objectContaining({ id: '24h', status: 'complete', value: 10, delta: null }),
      expect.objectContaining({ id: '7d', status: 'complete', value: 70, delta: 60, growthRate: 6 }),
      expect.objectContaining({ id: '30d', status: 'revision', value: 60, delta: null, growthRate: null })
    ])
    const boundary = lifecycle.items.find((item) => item.title.includes('lifecycle-boundary'))!
    expect(boundary.milestones[0]).toMatchObject({
      id: '24h', status: 'complete', value: 40,
      observedAt: '2025-03-02T06:00:00.000Z'
    })
    const missing = lifecycle.items.find((item) => item.title.includes('lifecycle-missing'))!
    expect(missing.milestones[0]).toMatchObject({ id: '24h', status: 'missing', value: null })
    const pending = lifecycle.items.find((item) => item.title.includes('lifecycle-pending'))!
    expect(pending.milestones[0]).toMatchObject({ id: '24h', status: 'pending', value: null })
    expect(lifecycle.aggregates[0]).toMatchObject({
      id: '24h', medianValue: 25, medianDelta: null,
      sampleCount: 2, pendingCount: 1, missingCount: 1, revisionCount: 0
    })
    expect(lifecycle.aggregates[2]).toMatchObject({ id: '30d', revisionCount: 1 })

    const paged = database.getContentLifecycle({
      accountIds: [account.id],
      standardMetricId: 'views',
      limit: 1,
      offset: 1
    })
    expect(paged.items).toHaveLength(1)
    expect(paged.total).toBe(4)
    expect(paged.aggregates).toEqual(lifecycle.aggregates)

    const historical = database.getContentLifecycle({
      accountIds: [account.id],
      standardMetricId: 'views',
      publishedTo: '2025-01-02T00:00:00.000Z',
      capturedTo: '2025-01-01T12:00:00.000Z'
    })
    expect(historical.total).toBe(1)
    expect(historical.items[0]!.milestones[0]).toMatchObject({
      id: '24h', status: 'pending', value: null
    })
  })

  it('reports account coverage, missing publication times and only latest successful warnings', () => {
    const synced = createManagedAccount(database, 'xiaohongshu', 'quality-owner', '质量账号')
    const empty = database.createAccount({
      platformId: 'weibo', alias: '空账号', syncMode: 'profile_only'
    })
    commitDataset(database, synced.id, dataset({
      remoteAccountId: 'quality-owner',
      capturedAt: '2026-06-01T08:00:00.000Z',
      contents: [content('no-published-at', null, 10)],
      warnings: ['旧告警']
    }))
    commitDataset(database, synced.id, dataset({
      remoteAccountId: 'quality-owner',
      capturedAt: '2026-06-02T08:00:00.000Z',
      contents: [content('no-published-at', null, 20)],
      warnings: ['最新告警']
    }))

    const summary = database.getAnalyticsSummary({ standardMetricIds: ['followers'] })
    expect(summary.quality).toMatchObject({
      contentCount: 1,
      observedContentCount: 1,
      missingPublishedAtCount: 1
    })
    expect(summary.quality.accounts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        accountId: synced.id, contentCount: 1, observedContentCount: 1,
        missingPublishedAtCount: 1
      }),
      expect.objectContaining({
        accountId: empty.id, contentCount: 0, observedContentCount: 0,
        missingPublishedAtCount: 0, latestObservationAt: null
      })
    ]))
    expect(summary.quality.warnings.map((warning) => warning.message)).toEqual(['最新告警'])
  })
})

function createManagedAccount(
  database: SocialDatabase,
  platformId: PlatformId,
  remoteId: string,
  alias: string
) {
  const account = database.createAccount({ platformId, alias, syncMode: 'recent_20' })
  database.applyManagedIdentity(account.id, { remoteId, remoteName: alias }, '2025-01-01T00:00:00.000Z')
  return database.updateAccount({ id: account.id, syncEnabled: true })
}

function commitDataset(
  database: SocialDatabase,
  accountId: string,
  payload: StandardDataset,
  packageHashOverride?: string
) {
  const account = database.getAccount(accountId)!
  const builtin = account.platformId === 'zhihu'
    ? {
        manifest: zhihuPluginManifestV2,
        contributionId: ZHIHU_PLATFORM_CONTRIBUTION_ID
      }
    : {
        manifest: xiaohongshuPluginManifestV2,
        contributionId: XIAOHONGSHU_PLATFORM_CONTRIBUTION_ID
      }
  database.upsertPluginPackage(builtin.manifest, {
    source: 'builtin',
    status: 'active',
    enabled: true,
    packageHash: packageHashOverride ?? `builtin:${builtin.manifest.id}@${builtin.manifest.version}`,
    publisherKeyId: builtin.manifest.publisher.keyId
  })
  database.setPluginContributionEnabled(builtin.manifest.id, builtin.contributionId, true)
  const finishedAt = new Date(Date.parse(payload.capturedAt) + 1_000).toISOString()
  database.markManagedSyncStarted(
    accountId,
    new Date(Date.parse(payload.capturedAt) - 1_000).toISOString()
  )
  const job = database.createJob({
    kind: 'managed_sync',
    accountId,
    pluginId: builtin.manifest.id,
    contributionId: builtin.contributionId,
    status: 'committing',
    progress: 80,
    stage: '写入可靠分析测试数据'
  })
  return database.commitManagedSync(payload, {
    accountId,
    pluginId: builtin.manifest.id,
    jobId: job.id,
    authorizedMode: 'recent_20',
    payloadMode: 'recent_20',
    finishedAt
  }).stats
}

function dataset(input: {
  remoteAccountId: string
  capturedAt: string
  followers?: number | null
  contentCount?: number | null
  contents: StandardDataset['contents']
  definitions?: StandardDataset['contentMetricDefinitions']
  warnings?: string[]
}): StandardDataset {
  return {
    capturedAt: input.capturedAt,
    profile: {
      remoteId: input.remoteAccountId,
      remoteName: input.remoteAccountId,
      followers: input.followers ?? 10,
      following: 1,
      contentCount: input.contentCount ?? input.contents.length,
      viewsTotal: null
    },
    contents: input.contents.map((item) => ({
      ...item,
      snapshots: item.snapshots.map((snapshot) => ({ ...snapshot, capturedAt: input.capturedAt }))
    })),
    contentMetricDefinitions: input.definitions,
    warnings: input.warnings ?? []
  }
}

function content(
  remoteId: string,
  publishedAt: string | null,
  views: number | null
): StandardDataset['contents'][number] {
  return {
    remoteId,
    type: 'article',
    title: `内容 ${remoteId}`,
    bodyExcerpt: '',
    url: `https://example.test/${remoteId}`,
    publishedAt,
    snapshots: [{ views, likes: null, comments: null, shares: null, favorites: null, capturedAt: '' }]
  }
}

function dynamicContent(
  remoteId: string,
  fixedViews: number | null,
  mappedViews: number
): StandardDataset['contents'][number] {
  return {
    ...content(remoteId, '2026-05-01T08:00:00.000Z', fixedViews),
    snapshots: [{
      views: fixedViews,
      likes: null,
      comments: null,
      shares: null,
      favorites: null,
      metrics: { play_count: mappedViews },
      capturedAt: ''
    }]
  }
}
