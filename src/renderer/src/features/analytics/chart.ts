import type { AnalyticsTimelinePoint, ContentType } from '../../../../shared/contracts'

export type TimelineMetric = 'views' | 'interactions'

export interface ChartPoint {
  x: number
  y: number
  value: number
  date: string
}

export function chartPoints(
  timeline: AnalyticsTimelinePoint[],
  metric: TimelineMetric,
  width = 800,
  height = 180,
  padding = 12
): ChartPoint[] {
  if (timeline.length === 0) return []
  const maximum = Math.max(1, ...timeline.map((point) => point[metric]))
  const drawableWidth = Math.max(0, width - padding * 2)
  const drawableHeight = Math.max(0, height - padding * 2)
  return timeline.map((point, index) => ({
    x: timeline.length === 1 ? width / 2 : padding + (index / (timeline.length - 1)) * drawableWidth,
    y: padding + drawableHeight - (point[metric] / maximum) * drawableHeight,
    value: point[metric],
    date: point.date
  }))
}

export function polylineValue(points: ChartPoint[]): string {
  return points.map((point) => `${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(' ')
}

export function typeDistribution(
  values: Array<{ type: ContentType; count: number }>
): Array<{ type: ContentType; count: number; percent: number }> {
  const total = values.reduce((sum, item) => sum + Math.max(0, item.count), 0)
  return values.map((item) => ({
    ...item,
    percent: total === 0 ? 0 : (Math.max(0, item.count) / total) * 100
  }))
}
