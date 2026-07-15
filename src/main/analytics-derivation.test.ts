import { describe, expect, it } from 'vitest'
import {
  deriveAnalyticsValue,
  deriveLifecycleMilestone,
  deriveLifecycleMilestones,
  lifecycleMilestones,
  median,
  selectLifecycleObservation
} from './analytics-derivation'

const HOUR_MS = 60 * 60 * 1_000

describe('deriveAnalyticsValue', () => {
  it('derives cumulative deltas and growth from actual observations', () => {
    expect(deriveAnalyticsValue({
      measurement: 'cumulative',
      current: 150,
      previous: 100
    })).toEqual({
      value: 150,
      delta: 50,
      growthRate: 0.5,
      status: 'complete',
      coverage: { observed: 1, total: 1 }
    })
  })

  it('marks a cumulative rollback as a revision without publishing a false negative delta', () => {
    expect(deriveAnalyticsValue({
      measurement: 'cumulative',
      current: 90,
      previous: 100,
      coverage: { observed: 4, total: 5 }
    })).toEqual({
      value: 90,
      delta: null,
      growthRate: null,
      status: 'revision',
      coverage: { observed: 4, total: 5 }
    })
  })

  it('uses a period total directly instead of subtracting overlapping periods', () => {
    expect(deriveAnalyticsValue({
      measurement: 'period_total',
      current: 80,
      previous: 100
    })).toMatchObject({ value: 80, delta: 80, growthRate: null, status: 'complete' })
  })

  it('allows gauge decreases and reports ratio deltas as percentage points', () => {
    const result = deriveAnalyticsValue({
      measurement: 'gauge',
      valueKind: 'ratio',
      current: 0.18,
      previous: 0.25,
      coverage: { observed: 3, total: 4 }
    })
    expect(result.value).toBe(0.18)
    expect(result.delta).toBeCloseTo(-7)
    expect(result.growthRate).toBeNull()
    expect(result.status).toBe('partial')
  })

  it('keeps growth unknown when the prior value is zero', () => {
    expect(deriveAnalyticsValue({
      measurement: 'cumulative',
      current: 5,
      previous: 0
    })).toMatchObject({ delta: 5, growthRate: null, status: 'complete' })
  })

  it('preserves missing and pending instead of converting them to zero', () => {
    expect(deriveAnalyticsValue({ measurement: 'gauge', current: null })).toEqual({
      value: null,
      delta: null,
      growthRate: null,
      status: 'missing',
      coverage: { observed: 0, total: 1 }
    })
    expect(deriveAnalyticsValue({
      measurement: 'gauge',
      current: 12,
      pending: true,
      coverage: { observed: 0, total: 5 }
    })).toMatchObject({ value: null, delta: null, growthRate: null, status: 'pending' })
  })

  it('rejects impossible coverage and non-finite metrics', () => {
    expect(() => deriveAnalyticsValue({
      measurement: 'gauge',
      current: 1,
      coverage: { observed: 2, total: 1 }
    })).toThrow('coverage')
    expect(() => deriveAnalyticsValue({ measurement: 'gauge', current: Number.NaN }))
      .toThrow('finite')
  })
})

describe('content lifecycle derivation', () => {
  const publishedAt = '2026-01-01T00:00:00.000Z'
  const asOf = '2026-02-15T00:00:00.000Z'

  it('defines the required milestone ages and tolerances', () => {
    expect(lifecycleMilestones).toEqual([
      { id: '24h', targetAgeMs: 24 * HOUR_MS, toleranceMs: 6 * HOUR_MS },
      { id: '7d', targetAgeMs: 7 * 24 * HOUR_MS, toleranceMs: 24 * HOUR_MS },
      { id: '30d', targetAgeMs: 30 * 24 * HOUR_MS, toleranceMs: 72 * HOUR_MS }
    ])
  })

  it('selects the closest qualified observation, including a nearby observation after the target', () => {
    const observations = [
      { id: 'before', observedAt: '2026-01-01T19:00:00.000Z' },
      { id: 'closest', observedAt: '2026-01-02T02:00:00.000Z' },
      { id: 'far-after', observedAt: '2026-01-02T08:00:00.000Z' }
    ]
    expect(selectLifecycleObservation({
      publishedAt,
      observations,
      milestone: '24h',
      asOf
    })?.id).toBe('closest')

    expect(deriveLifecycleMilestone({
      publishedAt,
      observations,
      milestone: '24h',
      asOf
    })).toMatchObject({
      status: 'complete',
      observedAt: '2026-01-02T02:00:00.000Z',
      offsetMs: 2 * HOUR_MS,
      observation: { id: 'closest' }
    })
  })

  it('chooses the earlier observation when two candidates are equally close', () => {
    const observations = [
      { id: 'later', observedAt: '2026-01-02T02:00:00.000Z' },
      { id: 'earlier', observedAt: '2026-01-01T22:00:00.000Z' }
    ]
    expect(selectLifecycleObservation({
      publishedAt,
      observations,
      milestone: '24h',
      asOf
    })?.id).toBe('earlier')
  })

  it('does not interpolate or pull a milestone backward from a distant future observation', () => {
    const result = deriveLifecycleMilestone({
      publishedAt,
      observations: [
        { observedAt: '2026-01-01T10:00:00.000Z', value: 10 },
        { observedAt: '2026-01-03T00:00:00.000Z', value: 100 }
      ],
      milestone: '24h',
      asOf
    })
    expect(result).toMatchObject({ status: 'missing', observation: null, observedAt: null })
  })

  it('distinguishes pending milestones from missing publication or observation data', () => {
    expect(deriveLifecycleMilestone({
      publishedAt,
      observations: [],
      milestone: '24h',
      asOf: '2026-01-01T23:59:59.999Z'
    })).toMatchObject({ status: 'pending', targetAt: '2026-01-02T00:00:00.000Z' })

    expect(deriveLifecycleMilestone({
      publishedAt: null,
      observations: [],
      milestone: '24h',
      asOf
    })).toMatchObject({ status: 'missing', targetAt: null })

    expect(deriveLifecycleMilestone({
      publishedAt,
      observations: [],
      milestone: '24h',
      asOf
    })).toMatchObject({ status: 'missing', targetAt: '2026-01-02T00:00:00.000Z' })
  })

  it('derives all milestones independently from the same observation history', () => {
    const results = deriveLifecycleMilestones({
      publishedAt,
      observations: [
        { observedAt: '2026-01-02T00:00:00.000Z' },
        { observedAt: '2026-01-08T00:00:00.000Z' }
      ],
      asOf: '2026-01-10T00:00:00.000Z'
    })
    expect(results.map(({ milestone, status }) => [milestone, status])).toEqual([
      ['24h', 'complete'],
      ['7d', 'complete'],
      ['30d', 'pending']
    ])
  })
})

describe('median', () => {
  it('returns a stable median without mutating input or treating missing samples as zero', () => {
    const samples = [9, null, 1, 5, undefined]
    expect(median(samples)).toBe(5)
    expect(samples).toEqual([9, null, 1, 5, undefined])
    expect(median([10, 2, 6, 4])).toBe(5)
    expect(median([null, undefined, Number.NaN])).toBeNull()
  })
})
