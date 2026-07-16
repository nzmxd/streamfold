import type { ContentSnapshot } from '../../../../shared/contracts'
import { contentMetricValue, type ContentMetricId } from '../content/metrics'

export interface ContentTrendSample {
  capturedAt: string
  value: number | null
  semanticsKey?: string
}

export interface ContentTrendPoint {
  capturedAt: string
  value: number
  x: number
  y: number
  semanticsKey?: string
}

export interface ContentTrendLatest {
  value: number | null
  delta: number | null
  missing: boolean
}

export function contentMetricTrend(
  snapshots: readonly ContentSnapshot[],
  metricId: ContentMetricId
): ContentTrendSample[] {
  return snapshots
    .map((snapshot) => {
      const semanticsKey = contentSnapshotSemanticsKey(snapshot)
      return {
        capturedAt: snapshot.capturedAt,
        value: contentMetricValue(snapshot, metricId),
        ...(semanticsKey ? { semanticsKey } : {})
      }
    })
    .sort((left, right) => Date.parse(left.capturedAt) - Date.parse(right.capturedAt))
}

export function contentTrendChartSegments(
  samples: readonly ContentTrendSample[],
  width = 360,
  height = 104,
  paddingX = 12,
  paddingY = 10
): ContentTrendPoint[][] {
  const validValues = samples
    .map((sample) => sample.value)
    .filter((value): value is number => value !== null && Number.isFinite(value))
  if (validValues.length === 0) return []

  const parsedTimes = samples.map((sample) => Date.parse(sample.capturedAt))
  const hasValidTimeline = parsedTimes.every(Number.isFinite)
  const firstTime = hasValidTimeline ? Math.min(...parsedTimes) : 0
  const lastTime = hasValidTimeline ? Math.max(...parsedTimes) : 0
  const minimum = Math.min(0, ...validValues)
  let maximum = Math.max(0, ...validValues)
  if (maximum === minimum) maximum = minimum + 1
  const drawableWidth = Math.max(0, width - paddingX * 2)
  const drawableHeight = Math.max(0, height - paddingY * 2)
  const segments: ContentTrendPoint[][] = []
  let segment: ContentTrendPoint[] = []
  let previousSemanticsKey: string | undefined

  samples.forEach((sample, index) => {
    if (sample.value === null || !Number.isFinite(sample.value)) {
      if (segment.length > 0) segments.push(segment)
      segment = []
      previousSemanticsKey = undefined
      return
    }
    if (segment.length > 0 && sample.semanticsKey !== previousSemanticsKey) {
      segments.push(segment)
      segment = []
    }
    const x = hasValidTimeline && lastTime > firstTime
      ? paddingX + ((parsedTimes[index]! - firstTime) / (lastTime - firstTime)) * drawableWidth
      : samples.length === 1
        ? width / 2
        : paddingX + (index / (samples.length - 1)) * drawableWidth
    segment.push({
      capturedAt: sample.capturedAt,
      value: sample.value,
      x,
      y: paddingY + ((maximum - sample.value) / (maximum - minimum)) * drawableHeight,
      ...(sample.semanticsKey ? { semanticsKey: sample.semanticsKey } : {})
    })
    previousSemanticsKey = sample.semanticsKey
  })
  if (segment.length > 0) segments.push(segment)
  return segments
}

export function contentTrendLatest(samples: readonly ContentTrendSample[]): ContentTrendLatest {
  const latest = samples.at(-1)
  const previous = samples.at(-2)
  const latestValue = latest?.value
  const previousValue = previous?.value
  const latestNumber = typeof latestValue === 'number' && Number.isFinite(latestValue) ? latestValue : null
  const previousNumber = typeof previousValue === 'number' && Number.isFinite(previousValue) ? previousValue : null
  return {
    value: latestNumber,
    delta: latestNumber !== null && previousNumber !== null && latest?.semanticsKey === previous?.semanticsKey
      ? latestNumber - previousNumber
      : null,
    missing: Boolean(latest) && latestNumber === null
  }
}

export function contentTrendChartPoints(
  samples: readonly ContentTrendSample[],
  width = 360,
  height = 104,
  paddingX = 12,
  paddingY = 10
): ContentTrendPoint[] {
  return contentTrendChartSegments(samples, width, height, paddingX, paddingY).flat()
}

export function contentTrendPolyline(points: readonly ContentTrendPoint[]): string {
  return points.map((point) => `${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(' ')
}

export function contentMetricSemanticsKey(contributionId: string, semanticsRevision: string): string {
  return `${contributionId}\u0000${semanticsRevision}`
}

function contentSnapshotSemanticsKey(snapshot: ContentSnapshot): string | null {
  const value = snapshot as ContentSnapshot & {
    contributionId?: unknown
    semanticsRevision?: unknown
  }
  return typeof value.contributionId === 'string' && value.contributionId &&
    typeof value.semanticsRevision === 'string' && value.semanticsRevision
    ? contentMetricSemanticsKey(value.contributionId, value.semanticsRevision)
    : null
}
