import { describe, expect, it } from 'vitest'
import type { ContentSnapshot, ContentSummary } from '../../../../shared/contracts'
import { preferredSnapshotMetricKey, primaryContentMetric } from './metrics'

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

  it('keeps missing metrics unknown instead of displaying them as zero', () => {
    expect(primaryContentMetric(summary(snapshot({})))).toEqual({
      key: null, label: '指标', value: null, previousValue: null
    })
    expect(preferredSnapshotMetricKey([snapshot({ views: null, likes: 3 })])).toBe('likes')
  })
})

function snapshot(overrides: Partial<ContentSnapshot>): ContentSnapshot {
  return {
    views: null,
    likes: null,
    comments: null,
    shares: null,
    favorites: null,
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
