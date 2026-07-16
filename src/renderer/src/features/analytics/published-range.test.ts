import { describe, expect, it } from 'vitest'
import { publishedRangeScope } from './published-range'

describe('analytics published ranges', () => {
  const now = new Date(2026, 6, 16, 15, 30, 45, 123)

  it('keeps all time unbounded', () => {
    expect(publishedRangeScope('all', now)).toEqual({})
  })

  it('uses Monday as the first day of this week', () => {
    expect(publishedRangeScope('this_week', now)).toEqual({
      publishedFrom: new Date(2026, 6, 13, 0, 0, 0, 0).toISOString(),
      publishedTo: now.toISOString()
    })
  })

  it('distinguishes rolling week and month ranges from calendar ranges', () => {
    expect(publishedRangeScope('last_7_days', now).publishedFrom)
      .toBe(new Date(2026, 6, 10, 0, 0, 0, 0).toISOString())
    expect(publishedRangeScope('this_month', now).publishedFrom)
      .toBe(new Date(2026, 6, 1, 0, 0, 0, 0).toISOString())
    expect(publishedRangeScope('last_30_days', now).publishedFrom)
      .toBe(new Date(2026, 5, 17, 0, 0, 0, 0).toISOString())
  })

  it('supports rolling quarter and calendar year shortcuts', () => {
    expect(publishedRangeScope('last_90_days', now).publishedFrom)
      .toBe(new Date(2026, 3, 18, 0, 0, 0, 0).toISOString())
    expect(publishedRangeScope('this_year', now).publishedFrom)
      .toBe(new Date(2026, 0, 1, 0, 0, 0, 0).toISOString())
  })

  it('keeps local Monday boundaries correct across a year change', () => {
    const sunday = new Date(2026, 0, 4, 23, 45)
    const monday = new Date(2026, 0, 5, 0, 15)
    expect(publishedRangeScope('this_week', sunday).publishedFrom)
      .toBe(new Date(2025, 11, 29, 0, 0, 0, 0).toISOString())
    expect(publishedRangeScope('this_week', monday).publishedFrom)
      .toBe(new Date(2026, 0, 5, 0, 0, 0, 0).toISOString())
    expect(publishedRangeScope('last_7_days', new Date(2026, 0, 3, 12)).publishedFrom)
      .toBe(new Date(2025, 11, 28, 0, 0, 0, 0).toISOString())
  })
})
