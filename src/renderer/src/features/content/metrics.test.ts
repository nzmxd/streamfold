import { describe, expect, it } from 'vitest'
import type { ContentSnapshot, ContentSummary } from '../../../../shared/contracts'
import {
  contentMetricValue,
  formatContentMetric,
  preferredContentMetricId,
  preferredSnapshotMetricKey,
  primaryContentMetric,
  resolveContentMetricDefinitions
} from './metrics'

describe('content metric presentation', () => {
  it('uses views when the platform provides them', () => {
    expect(primaryContentMetric(summary(snapshot({ views: 120, likes: 8 })))).toMatchObject({
      key: 'views', label: '浏览', value: 120
    })
  })

  it('falls back to likes when views are unavailable', () => {
    expect(primaryContentMetric(summary(
      snapshot({ views: null, likes: 8 }),
      snapshot({ views: null, likes: 7 })
    ))).toEqual({ key: 'likes', label: '点赞', value: 8, previousValue: 7 })
  })

  it('uses the platform term for Zhihu upvotes', () => {
    expect(primaryContentMetric({
      ...summary(snapshot({ views: null, likes: 8 })),
      platformId: 'zhihu'
    })).toMatchObject({ key: 'likes', label: '赞同', value: 8 })
  })

  it('keeps missing metrics unknown instead of displaying them as zero', () => {
    expect(primaryContentMetric(summary(snapshot({})))).toEqual({
      key: null, label: '指标', value: null, previousValue: null
    })
    expect(preferredSnapshotMetricKey([snapshot({ views: null, likes: 3 })])).toBe('likes')
  })

  it('merges declared metrics into the history without renderer platform enums', () => {
    const definitions = resolveContentMetricDefinitions([{
      id: 'cover_click_rate',
      label: '封面点击率',
      valueKind: 'ratio',
      unit: 'ratio',
      group: 'reach',
      sortOrder: 30
    }])
    const item = snapshot({ metrics: { cover_click_rate: 0.174 } })

    expect(definitions.map((definition) => definition.id)).toEqual([
      'views', 'cover_click_rate', 'likes', 'comments', 'favorites', 'shares'
    ])
    expect(contentMetricValue(item, 'cover_click_rate')).toBe(0.174)
    expect(preferredContentMetricId(definitions, [item])).toBe('cover_click_rate')
    expect(formatContentMetric(0.174, definitions[1]!)).toBe('17.4%')
  })

  it('lets an adapter replace a core label while retaining the core value field', () => {
    const definitions = resolveContentMetricDefinitions([{
      id: 'likes',
      label: '赞同',
      valueKind: 'count',
      unit: 'count',
      group: 'engagement',
      sortOrder: 40
    }, {
      id: 'content_likes',
      label: '喜欢',
      valueKind: 'count',
      unit: 'count',
      group: 'engagement',
      sortOrder: 45
    }])

    expect(definitions.find(({ id }) => id === 'likes')?.label).toBe('赞同')
    expect(definitions.find(({ id }) => id === 'content_likes')?.label).toBe('喜欢')
  })

  it('formats duration metrics using their declared unit', () => {
    expect(formatContentMetric(75.5, {
      valueKind: 'duration',
      unit: 'seconds'
    })).toBe('1 分 15.5 秒')
  })
})

function snapshot(overrides: Partial<ContentSnapshot>): ContentSnapshot {
  return {
    views: null,
    likes: null,
    comments: null,
    shares: null,
    favorites: null,
    metrics: {},
    capturedAt: '2026-07-14T00:00:00.000Z',
    ...overrides
  }
}

function summary(
  latestSnapshot: ContentSnapshot | null,
  previousSnapshot: ContentSnapshot | null = null
): Pick<ContentSummary, 'latestSnapshot' | 'previousSnapshot'> {
  return { latestSnapshot, previousSnapshot }
}
