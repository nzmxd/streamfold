import type {
  AccountMetricDefinition,
  AccountMetricPeriod,
  AccountMetricSnapshot
} from '../../../../shared/contracts'

export const accountMetricPeriodOptions: ReadonlyArray<{
  value: Exclude<AccountMetricPeriod, 'daily'>
  label: string
  trendLimit: number
}> = [
  { value: 'last_7_days', label: '近 7 天', trendLimit: 7 },
  { value: 'last_14_days', label: '近 14 天', trendLimit: 14 },
  { value: 'last_30_days', label: '近 30 天', trendLimit: 30 },
  { value: 'lifetime', label: '累计', trendLimit: 90 }
]

export interface AccountMetricSeriesPoint {
  date: string
  capturedAt: string
  value: number
}

export interface AccountMetricChartPoint extends AccountMetricSeriesPoint {
  x: number
  y: number
}

export function latestAccountMetricSnapshot(
  snapshots: readonly AccountMetricSnapshot[]
): AccountMetricSnapshot | null {
  return [...snapshots].sort(compareSnapshotDescending)[0] ?? null
}

export function previousAccountMetricSnapshot(
  snapshots: readonly AccountMetricSnapshot[]
): AccountMetricSnapshot | null {
  return [...snapshots].sort(compareSnapshotDescending)[1] ?? null
}

export function accountMetricDefinitions(
  definitions: readonly AccountMetricDefinition[]
): AccountMetricDefinition[] {
  return [...definitions].sort((left, right) => (
    left.sortOrder - right.sortOrder || left.label.localeCompare(right.label, 'zh-CN')
  ))
}

export function accountMetricDefinitionsForSnapshot(
  definitions: readonly AccountMetricDefinition[],
  snapshot: AccountMetricSnapshot | null | undefined
): AccountMetricDefinition[] {
  if (!snapshot) return []
  return accountMetricDefinitions(definitions).filter((definition) => (
    Object.prototype.hasOwnProperty.call(snapshot.metrics, definition.id)
  ))
}

export function accountMetricValue(
  snapshot: AccountMetricSnapshot | null | undefined,
  metricId: string
): number | null {
  return snapshot?.metrics[metricId] ?? null
}

export function accountMetricDelta(
  latest: AccountMetricSnapshot | null | undefined,
  previous: AccountMetricSnapshot | null | undefined,
  metricId: string
): number | null {
  const current = accountMetricValue(latest, metricId)
  const before = accountMetricValue(previous, metricId)
  return current === null || before === null ? null : current - before
}

export function accountMetricSeries(
  snapshots: readonly AccountMetricSnapshot[],
  metricId: string
): AccountMetricSeriesPoint[] {
  const latestByDate = new Map<string, AccountMetricSnapshot>()
  for (const snapshot of snapshots) {
    if (accountMetricValue(snapshot, metricId) === null) continue
    const current = latestByDate.get(snapshot.periodEnd)
    if (!current || Date.parse(snapshot.capturedAt) > Date.parse(current.capturedAt)) {
      latestByDate.set(snapshot.periodEnd, snapshot)
    }
  }
  return [...latestByDate.values()]
    .sort((left, right) => left.periodEnd.localeCompare(right.periodEnd))
    .map((snapshot) => ({
      date: snapshot.periodEnd,
      capturedAt: snapshot.capturedAt,
      value: accountMetricValue(snapshot, metricId) as number
    }))
}

export function accountMetricChartPoints(
  series: readonly AccountMetricSeriesPoint[],
  width = 720,
  height = 164,
  padding = 14
): AccountMetricChartPoint[] {
  if (series.length === 0) return []
  const values = series.map((point) => point.value)
  const minimum = Math.min(...values)
  const maximum = Math.max(...values)
  const range = maximum - minimum
  const drawableWidth = Math.max(0, width - padding * 2)
  const drawableHeight = Math.max(0, height - padding * 2)

  return series.map((point, index) => ({
    ...point,
    x: series.length === 1
      ? width / 2
      : padding + (index / (series.length - 1)) * drawableWidth,
    y: range === 0
      ? height / 2
      : padding + ((maximum - point.value) / range) * drawableHeight
  }))
}

export function accountMetricPolyline(points: readonly AccountMetricChartPoint[]): string {
  return points.map((point) => `${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(' ')
}

export function accountMetricZeroLineY(
  series: readonly AccountMetricSeriesPoint[],
  height = 164,
  padding = 14
): number | null {
  if (series.length === 0) return null
  const values = series.map((point) => point.value)
  const minimum = Math.min(...values)
  const maximum = Math.max(...values)
  if (minimum >= 0 || maximum <= 0) return null
  const drawableHeight = Math.max(0, height - padding * 2)
  return padding + (maximum / (maximum - minimum)) * drawableHeight
}

export function accountMetricStatusLabel(status: string): string {
  const normalized = status.toLowerCase()
  if (['normal', 'available', 'success', 'ok', '0'].includes(normalized)) return '本周期暂无数据'
  if (normalized.includes('updat') || normalized.includes('calculat')) return '平台数据更新中'
  if (normalized.includes('level') || normalized.includes('grade')) return '当前创作等级暂不可用'
  if (normalized.includes('read') || normalized.includes('view') || normalized.includes('threshold') || normalized.includes('pv')) {
    return '阅读量达到要求后显示'
  }
  return '平台暂未提供该指标'
}

export function formatAccountMetricDate(value: string | null | undefined): string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return '—'
  return value.replaceAll('-', '/')
}

function compareSnapshotDescending(
  left: AccountMetricSnapshot,
  right: AccountMetricSnapshot
): number {
  return right.periodEnd.localeCompare(left.periodEnd) || right.capturedAt.localeCompare(left.capturedAt)
}
