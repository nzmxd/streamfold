import { describe, expect, it } from 'vitest'
import type { ContentSnapshot } from '../../../../shared/contracts'
import {
  contentMetricTrend,
  contentTrendChartPoints,
  contentTrendChartSegments,
  contentTrendLatest,
  contentTrendPolyline
} from './content-trend'

describe('content metric trend helpers', () => {
  it('sorts snapshots and preserves missing values as explicit gaps', () => {
    const snapshots = [
      snapshot('2026-07-16T10:00:00.000Z', 30),
      snapshot('2026-07-14T10:00:00.000Z', 10),
      snapshot('2026-07-15T10:00:00.000Z', null)
    ]

    expect(contentMetricTrend(snapshots, 'views')).toEqual([
      { capturedAt: '2026-07-14T10:00:00.000Z', value: 10 },
      { capturedAt: '2026-07-15T10:00:00.000Z', value: null },
      { capturedAt: '2026-07-16T10:00:00.000Z', value: 30 }
    ])
  })

  it('uses actual capture time for x coordinates and splits lines at missing values', () => {
    const segments = contentTrendChartSegments([
      { capturedAt: '2026-07-01T00:00:00.000Z', value: 10 },
      { capturedAt: '2026-07-02T00:00:00.000Z', value: null },
      { capturedAt: '2026-07-10T00:00:00.000Z', value: 30 }
    ], 100, 50, 10, 5)

    expect(segments).toHaveLength(2)
    expect(segments[0]).toHaveLength(1)
    expect(segments[1]).toHaveLength(1)
    expect(segments[0]![0]!.x).toBe(10)
    expect(segments[1]![0]!.x).toBe(90)
    expect(contentTrendPolyline(segments[0]!)).toBe('10.00,31.67')
  })

  it('keeps a zero baseline and centers a single timestamp safely', () => {
    const points = contentTrendChartPoints([
      { capturedAt: '2026-07-01T00:00:00.000Z', value: 8 }
    ], 100, 50, 10, 5)
    expect(points).toEqual([{
      capturedAt: '2026-07-01T00:00:00.000Z',
      value: 8,
      x: 50,
      y: 5
    }])
  })

  it('reads adapter-declared metrics as well as core fields', () => {
    const value = snapshot('2026-07-16T10:00:00.000Z', 12)
    value.metrics.cover_click_rate = 0.174
    expect(contentMetricTrend([value], 'cover_click_rate')).toEqual([
      { capturedAt: value.capturedAt, value: 0.174 }
    ])
  })

  it('splits chart lines and deltas at metric semantics boundaries', () => {
    const samples = [
      { capturedAt: '2026-07-14T10:00:00.000Z', value: 10, semanticsKey: 'revision-a' },
      { capturedAt: '2026-07-15T10:00:00.000Z', value: 20, semanticsKey: 'revision-a' },
      { capturedAt: '2026-07-16T10:00:00.000Z', value: 5, semanticsKey: 'revision-b' }
    ]
    expect(contentTrendChartSegments(samples).map((segment) => segment.length)).toEqual([2, 1])
    expect(contentTrendLatest(samples)).toEqual({ value: 5, delta: null, missing: false })
  })

  it('does not present an older valid value when the newest capture is missing', () => {
    expect(contentTrendLatest([
      { capturedAt: '2026-07-15T10:00:00.000Z', value: 20 },
      { capturedAt: '2026-07-16T10:00:00.000Z', value: null }
    ])).toEqual({ value: null, delta: null, missing: true })
  })
})

function snapshot(capturedAt: string, views: number | null): ContentSnapshot {
  return {
    views,
    likes: null,
    comments: null,
    shares: null,
    favorites: null,
    metrics: {},
    capturedAt
  }
}
