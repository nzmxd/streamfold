export const metricMeasurements = ['cumulative', 'period_total', 'gauge'] as const
export type MetricMeasurement = (typeof metricMeasurements)[number]

export type AnalyticsMetricValueKind = 'count' | 'ratio' | 'duration'
export type AnalyticsStatus = 'complete' | 'partial' | 'missing' | 'revision' | 'pending'

export interface AnalyticsCoverage {
  observed: number
  total: number
}

export interface AnalyticsValue {
  value: number | null
  delta: number | null
  growthRate: number | null
  status: AnalyticsStatus
  coverage: AnalyticsCoverage
}

export interface DeriveAnalyticsValueInput {
  measurement: MetricMeasurement
  valueKind?: AnalyticsMetricValueKind
  current: number | null
  previous?: number | null
  coverage?: AnalyticsCoverage
  pending?: boolean
}

/**
 * Derive a display value without inventing data for an absent prior observation.
 * Ratio deltas are percentage points while all values and growth rates retain their
 * source scale (for example, a growthRate of 0.25 means 25%).
 */
export function deriveAnalyticsValue(input: DeriveAnalyticsValueInput): AnalyticsValue {
  const current = finiteMetric(input.current, 'current')
  const previous = finiteMetric(input.previous ?? null, 'previous')
  const coverage = input.coverage ?? {
    observed: current === null ? 0 : 1,
    total: 1
  }
  assertCoverage(coverage)

  if (input.pending) return emptyAnalyticsValue('pending', coverage)
  if (current === null || coverage.observed === 0 || coverage.total === 0) {
    return emptyAnalyticsValue('missing', coverage)
  }

  if (input.measurement === 'cumulative' && previous !== null && current < previous) {
    return {
      value: current,
      delta: null,
      growthRate: null,
      status: 'revision',
      coverage
    }
  }

  const valueKind = input.valueKind ?? 'count'
  const rawDelta = deriveRawDelta(input.measurement, valueKind, current, previous)
  const delta = rawDelta === null
    ? null
    : valueKind === 'ratio' ? rawDelta * 100 : rawDelta
  const growthRate = valueKind === 'ratio' || input.measurement === 'period_total' ||
    rawDelta === null || previous === null || previous === 0
    ? null
    : rawDelta / previous

  return {
    value: current,
    delta,
    growthRate,
    status: coverage.observed < coverage.total ? 'partial' : 'complete',
    coverage
  }
}

function deriveRawDelta(
  measurement: MetricMeasurement,
  valueKind: AnalyticsMetricValueKind,
  current: number,
  previous: number | null
): number | null {
  if (measurement === 'period_total') {
    // A platform period total is already the contribution for that period. Subtracting
    // two rolling period totals would manufacture a value that the platform did not report.
    return valueKind === 'ratio' ? null : current
  }
  return previous === null ? null : current - previous
}

function emptyAnalyticsValue(
  status: 'missing' | 'pending',
  coverage: AnalyticsCoverage
): AnalyticsValue {
  return { value: null, delta: null, growthRate: null, status, coverage }
}

function finiteMetric(value: number | null, label: string): number | null {
  if (value === null) return null
  if (!Number.isFinite(value)) throw new TypeError(`${label} metric must be finite or null`)
  return value
}

function assertCoverage(coverage: AnalyticsCoverage): void {
  if (!Number.isSafeInteger(coverage.observed) || !Number.isSafeInteger(coverage.total) ||
    coverage.observed < 0 || coverage.total < 0 || coverage.observed > coverage.total) {
    throw new RangeError('analytics coverage must satisfy 0 <= observed <= total')
  }
}

const HOUR_MS = 60 * 60 * 1_000
const DAY_MS = 24 * HOUR_MS

export const lifecycleMilestones = [
  { id: '24h', targetAgeMs: DAY_MS, toleranceMs: 6 * HOUR_MS },
  { id: '7d', targetAgeMs: 7 * DAY_MS, toleranceMs: DAY_MS },
  { id: '30d', targetAgeMs: 30 * DAY_MS, toleranceMs: 3 * DAY_MS }
] as const

export type LifecycleMilestoneId = (typeof lifecycleMilestones)[number]['id']
export type LifecycleStatus = Extract<AnalyticsStatus, 'complete' | 'missing' | 'pending'>

export interface TimestampedObservation {
  observedAt: string
}

export interface LifecycleObservationSelectionInput<T extends TimestampedObservation> {
  publishedAt: string | null
  observations: readonly T[]
  milestone: LifecycleMilestoneId
  asOf: string
}

export interface LifecycleMilestoneResult<T extends TimestampedObservation> {
  milestone: LifecycleMilestoneId
  status: LifecycleStatus
  targetAt: string | null
  observedAt: string | null
  /** Signed distance from the milestone target; negative values are observations before it. */
  offsetMs: number | null
  observation: T | null
}

/** Select the closest available observation inside the milestone tolerance window. */
export function selectLifecycleObservation<T extends TimestampedObservation>(
  input: LifecycleObservationSelectionInput<T>
): T | null {
  const publishedAt = timestamp(input.publishedAt)
  if (publishedAt === null) return null
  const asOf = requiredTimestamp(input.asOf, 'asOf')
  const definition = milestoneDefinition(input.milestone)
  const targetAt = publishedAt + definition.targetAgeMs
  let selected: { observation: T; observedAt: number; distance: number } | null = null

  for (const observation of input.observations) {
    const observedAt = timestamp(observation.observedAt)
    if (observedAt === null || observedAt < publishedAt || observedAt > asOf) continue
    const distance = Math.abs(observedAt - targetAt)
    if (distance > definition.toleranceMs) continue
    if (selected === null || distance < selected.distance ||
      (distance === selected.distance && observedAt < selected.observedAt)) {
      selected = { observation, observedAt, distance }
    }
  }
  return selected?.observation ?? null
}

export function deriveLifecycleMilestone<T extends TimestampedObservation>(
  input: LifecycleObservationSelectionInput<T>
): LifecycleMilestoneResult<T> {
  const publishedAt = timestamp(input.publishedAt)
  if (publishedAt === null) return emptyLifecycleMilestone(input.milestone, 'missing', null)
  const asOf = requiredTimestamp(input.asOf, 'asOf')
  const definition = milestoneDefinition(input.milestone)
  const targetTime = publishedAt + definition.targetAgeMs
  const targetAt = new Date(targetTime).toISOString()

  if (asOf < targetTime) return emptyLifecycleMilestone(input.milestone, 'pending', targetAt)

  const observation = selectLifecycleObservation(input)
  if (observation === null) return emptyLifecycleMilestone(input.milestone, 'missing', targetAt)
  const observedTime = requiredTimestamp(observation.observedAt, 'observation')
  return {
    milestone: input.milestone,
    status: 'complete',
    targetAt,
    observedAt: new Date(observedTime).toISOString(),
    offsetMs: observedTime - targetTime,
    observation
  }
}

export function deriveLifecycleMilestones<T extends TimestampedObservation>(
  input: Omit<LifecycleObservationSelectionInput<T>, 'milestone'>
): Array<LifecycleMilestoneResult<T>> {
  return lifecycleMilestones.map(({ id }) => deriveLifecycleMilestone({ ...input, milestone: id }))
}

function emptyLifecycleMilestone<T extends TimestampedObservation>(
  milestone: LifecycleMilestoneId,
  status: 'missing' | 'pending',
  targetAt: string | null
): LifecycleMilestoneResult<T> {
  return { milestone, status, targetAt, observedAt: null, offsetMs: null, observation: null }
}

function milestoneDefinition(id: LifecycleMilestoneId): (typeof lifecycleMilestones)[number] {
  const definition = lifecycleMilestones.find((item) => item.id === id)
  if (!definition) throw new RangeError(`unknown lifecycle milestone: ${String(id)}`)
  return definition
}

function timestamp(value: string | null): number | null {
  if (value === null || value.trim() === '') return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function requiredTimestamp(value: string, label: string): number {
  const parsed = timestamp(value)
  if (parsed === null) throw new TypeError(`${label} must be a valid timestamp`)
  return parsed
}

/** Median of the finite samples. Missing and non-finite samples never become zeroes. */
export function median(values: readonly (number | null | undefined)[]): number | null {
  const samples = values.filter((value): value is number => (
    typeof value === 'number' && Number.isFinite(value)
  )).sort((left, right) => left - right)
  if (samples.length === 0) return null
  const middle = Math.floor(samples.length / 2)
  if (samples.length % 2 === 1) return samples[middle]!
  return (samples[middle - 1]! + samples[middle]!) / 2
}
