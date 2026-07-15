import type {
  ContentMetricDefinition,
  ContentSnapshot,
  ContentSummary,
  MetricValues
} from '../../../../shared/contracts'
import { formatNumber } from '../shared/format'

export type ContentMetricKey = keyof MetricValues
export type ContentMetricId = string

const coreMetricDefinitions: readonly ContentMetricDefinition[] = [
  metricDefinition('views', '浏览', 'reach', 20),
  metricDefinition('likes', '点赞', 'engagement', 40),
  metricDefinition('comments', '评论', 'engagement', 50),
  metricDefinition('favorites', '收藏', 'engagement', 60),
  metricDefinition('shares', '分享', 'engagement', 80)
]

const coreMetricIds = new Set<ContentMetricKey>(
  coreMetricDefinitions.map((definition) => definition.id as ContentMetricKey)
)

export interface PrimaryContentMetric {
  key: ContentMetricKey | null
  label: string
  value: number | null
  previousValue: number | null
}

export function primaryContentMetric(
  item: Pick<ContentSummary, 'latestSnapshot' | 'previousSnapshot'> &
    Partial<Pick<ContentSummary, 'platformId'>>
): PrimaryContentMetric {
  const definition = coreMetricDefinitions.find((candidate) => (
    contentMetricValue(item.latestSnapshot, candidate.id) !== null
  ))
  const key = definition?.id as ContentMetricKey | undefined
  return definition && key
    ? {
        key,
        label: platformMetricLabel(item.platformId, definition),
        value: contentMetricValue(item.latestSnapshot, key),
        previousValue: contentMetricValue(item.previousSnapshot, key)
      }
    : { key: null, label: '指标', value: null, previousValue: null }
}

function platformMetricLabel(
  platformId: ContentSummary['platformId'] | undefined,
  definition: ContentMetricDefinition
): string {
  if (platformId === 'zhihu' && definition.id === 'likes') return '赞同'
  return definition.label
}

export function resolveContentMetricDefinitions(
  declared: readonly ContentMetricDefinition[] = []
): ContentMetricDefinition[] {
  const result = new Map(coreMetricDefinitions.map((definition) => [definition.id, definition]))
  for (const definition of declared) result.set(definition.id, definition)
  return [...result.values()].sort((left, right) => (
    left.sortOrder - right.sortOrder || left.label.localeCompare(right.label, 'zh-CN')
  ))
}

export function contentMetricValue(
  snapshot: ContentSnapshot | null | undefined,
  metricId: ContentMetricId
): number | null {
  if (!snapshot) return null
  if (coreMetricIds.has(metricId as ContentMetricKey)) {
    return snapshot[metricId as ContentMetricKey]
  }
  return snapshot.metrics?.[metricId] ?? null
}

export function contentMetricDelta(
  latest: ContentSnapshot | null | undefined,
  previous: ContentSnapshot | null | undefined,
  metricId: ContentMetricId
): number | null {
  const current = contentMetricValue(latest, metricId)
  const before = contentMetricValue(previous, metricId)
  return current === null || before === null ? null : current - before
}

export function availableContentMetricDefinitions(
  definitions: readonly ContentMetricDefinition[],
  snapshots: readonly ContentSnapshot[]
): ContentMetricDefinition[] {
  return resolveContentMetricDefinitions(definitions).filter((definition) => (
    snapshots.some((snapshot) => contentMetricValue(snapshot, definition.id) !== null)
  ))
}

export function preferredContentMetricId(
  definitions: readonly ContentMetricDefinition[],
  snapshots: readonly ContentSnapshot[]
): ContentMetricId | null {
  return availableContentMetricDefinitions(definitions, snapshots)[0]?.id ?? null
}

/** Backwards-compatible helper for callers that only understand the five core fields. */
export function preferredSnapshotMetricKey(
  snapshots: readonly ContentSnapshot[]
): ContentMetricKey | null {
  return (coreMetricDefinitions.find((definition) => (
    snapshots.some((snapshot) => contentMetricValue(snapshot, definition.id) !== null)
  ))?.id as ContentMetricKey | undefined) ?? null
}

export function contentMetricLabel(key: ContentMetricKey): string {
  return coreMetricDefinitions.find((definition) => definition.id === key)?.label ?? key
}

export function formatContentMetric(
  value: number | null | undefined,
  definition: Pick<ContentMetricDefinition, 'valueKind' | 'unit'>
): string {
  if (value === null || value === undefined) return '—'
  if (definition.valueKind === 'ratio' || definition.unit === 'ratio') {
    return new Intl.NumberFormat('zh-CN', {
      style: 'percent',
      minimumFractionDigits: 0,
      maximumFractionDigits: 2
    }).format(value)
  }
  if (definition.valueKind === 'duration' || definition.unit === 'seconds') {
    return formatDurationSeconds(value)
  }
  return formatNumber(value)
}

export function formatContentMetricDelta(
  value: number | null,
  definition: Pick<ContentMetricDefinition, 'valueKind' | 'unit'>
): string {
  if (value === null) return '暂无对比'
  if (value === 0) return '与上次持平'
  const prefix = value > 0 ? '+' : ''
  if (definition.valueKind === 'ratio' || definition.unit === 'ratio') {
    const percentagePoints = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(value * 100)
    return `${prefix}${percentagePoints} 个百分点`
  }
  if (definition.valueKind === 'duration' || definition.unit === 'seconds') {
    return `${prefix}${formatDurationSeconds(value)} 较上次`
  }
  return `${prefix}${formatNumber(value)} 较上次`
}

function metricDefinition(
  id: ContentMetricKey,
  label: string,
  group: ContentMetricDefinition['group'],
  sortOrder: number
): ContentMetricDefinition {
  return { id, label, valueKind: 'count', unit: 'count', group, sortOrder }
}

function formatDurationSeconds(value: number): string {
  const sign = value < 0 ? '-' : ''
  const absolute = Math.abs(value)
  if (absolute < 60) {
    return `${sign}${new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 }).format(absolute)} 秒`
  }
  const minutes = Math.floor(absolute / 60)
  const seconds = Math.round((absolute - minutes * 60) * 10) / 10
  return seconds > 0 ? `${sign}${minutes} 分 ${seconds} 秒` : `${sign}${minutes} 分钟`
}
