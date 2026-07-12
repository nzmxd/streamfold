import { describe, expect, it } from 'vitest'
import { chartPoints, polylineValue, typeDistribution } from './chart'

describe('analytics chart helpers', () => {
  it('normalizes timeline points while preserving dates and values', () => {
    const result = chartPoints([
      { date: '2026-01-01', views: 0, interactions: 4, followers: null },
      { date: '2026-01-02', views: 100, interactions: 8, followers: 10 }
    ], 'views', 100, 50, 10)

    expect(result).toEqual([
      { x: 10, y: 40, value: 0, date: '2026-01-01' },
      { x: 90, y: 10, value: 100, date: '2026-01-02' }
    ])
    expect(polylineValue(result)).toBe('10.00,40.00 90.00,10.00')
  })

  it('calculates a safe content type distribution', () => {
    expect(typeDistribution([
      { type: 'article', count: 3 },
      { type: 'video', count: 1 }
    ])).toEqual([
      { type: 'article', count: 3, percent: 75 },
      { type: 'video', count: 1, percent: 25 }
    ])
    expect(typeDistribution([{ type: 'post', count: 0 }])[0]?.percent).toBe(0)
  })
})
