import { describe, expect, it } from 'vitest'
import type { AccountMetricDefinition, AccountMetricSnapshot } from '../../../../shared/contracts'
import {
  accountMetricChartPoints,
  accountMetricDefinitions,
  accountMetricDefinitionsForSnapshot,
  accountMetricDelta,
  accountMetricPolyline,
  accountMetricSeries,
  accountMetricStatusLabel,
  accountMetricZeroLineY,
  formatAccountMetricDate,
  latestAccountMetricSnapshot,
  previousAccountMetricSnapshot
} from './account-metrics'

describe('account metric presentation', () => {
  it('selects the latest two snapshots regardless of repository order', () => {
    const snapshots = [snapshot('2026-07-13', '2026-07-14T01:00:00Z', { views: 10 }), snapshot(
      '2026-07-14', '2026-07-15T01:00:00Z', { views: 15 }
    )]

    expect(latestAccountMetricSnapshot(snapshots)?.metrics.views).toBe(15)
    expect(previousAccountMetricSnapshot(snapshots)?.metrics.views).toBe(10)
    expect(accountMetricDelta(snapshots[1], snapshots[0], 'views')).toBe(5)
  })

  it('keeps the newest capture for each daily point and preserves signed values', () => {
    const result = accountMetricSeries([
      snapshot('2026-07-14', '2026-07-14T08:00:00Z', { follower_conversion: -2 }),
      snapshot('2026-07-14', '2026-07-14T10:00:00Z', { follower_conversion: -1 }),
      snapshot('2026-07-15', '2026-07-15T10:00:00Z', { follower_conversion: 3 }),
      snapshot('2026-07-16', '2026-07-16T10:00:00Z', { follower_conversion: null })
    ], 'follower_conversion')

    expect(result.map(({ date, value }) => ({ date, value }))).toEqual([
      { date: '2026-07-14', value: -1 },
      { date: '2026-07-15', value: 3 }
    ])
  })

  it('normalizes positive and negative chart values without clipping', () => {
    const points = accountMetricChartPoints([
      { date: '2026-07-14', capturedAt: 'a', value: -2 },
      { date: '2026-07-15', capturedAt: 'b', value: 0 },
      { date: '2026-07-16', capturedAt: 'c', value: 2 }
    ], 100, 60, 10)

    expect(points.map(({ x, y }) => ({ x, y }))).toEqual([
      { x: 10, y: 50 },
      { x: 50, y: 30 },
      { x: 90, y: 10 }
    ])
    expect(accountMetricPolyline(points)).toBe('10.00,50.00 50.00,30.00 90.00,10.00')
    expect(accountMetricZeroLineY([
      { date: '2026-07-14', capturedAt: 'a', value: -2 },
      { date: '2026-07-16', capturedAt: 'c', value: 2 }
    ], 60, 10)).toBe(30)
  })

  it('sorts definitions using the adapter declaration', () => {
    const definitions: AccountMetricDefinition[] = [
      definition('follower_conversion', '关注者转化', 110),
      definition('views', '阅读', 10)
    ]
    expect(accountMetricDefinitions(definitions).map(({ id }) => id)).toEqual([
      'views', 'follower_conversion'
    ])
    expect(accountMetricDefinitionsForSnapshot(definitions, snapshot(
      '2026-07-15', '2026-07-15T10:00:00Z', { follower_conversion: null }
    )).map(({ id }) => id)).toEqual(['follower_conversion'])
  })

  it('presents advanced metric availability states without exposing platform codes', () => {
    expect(accountMetricStatusLabel('unnormal_by_pv')).toBe('阅读量达到要求后显示')
    expect(accountMetricStatusLabel('unnormal_by_level')).toBe('当前创作等级暂不可用')
    expect(accountMetricStatusLabel('calculating')).toBe('平台数据更新中')
    expect(formatAccountMetricDate('2026-07-15')).toBe('2026/07/15')
  })
})

function snapshot(
  periodEnd: string,
  capturedAt: string,
  metrics: Record<string, number | null>
): AccountMetricSnapshot {
  return {
    accountId: 'account-1',
    period: 'daily',
    periodStart: periodEnd,
    periodEnd,
    status: null,
    metrics,
    capturedAt
  }
}

function definition(id: string, label: string, sortOrder: number): AccountMetricDefinition {
  return { id, label, sortOrder, valueKind: 'count', unit: 'count', group: 'other' }
}
