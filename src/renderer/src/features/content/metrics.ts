import type { ContentSnapshot, ContentSummary, MetricValues } from '../../../../shared/contracts'

export type ContentMetricKey = keyof MetricValues

const metricOrder: readonly ContentMetricKey[] = [
  'views',
  'likes',
  'comments',
  'shares',
  'favorites'
]

const labels: Record<ContentMetricKey, string> = {
  views: '浏览',
  likes: '点赞',
  comments: '评论',
  shares: '分享',
  favorites: '收藏'
}

export interface PrimaryContentMetric {
  key: ContentMetricKey | null
  label: string
  value: number | null
  previousValue: number | null
}

export function primaryContentMetric(
  item: Pick<ContentSummary, 'latestSnapshot' | 'previousSnapshot'>
): PrimaryContentMetric {
  const key = metricOrder.find((candidate) => item.latestSnapshot?.[candidate] !== null &&
    item.latestSnapshot?.[candidate] !== undefined) ?? null
  return key
    ? {
        key,
        label: labels[key],
        value: item.latestSnapshot?.[key] ?? null,
        previousValue: item.previousSnapshot?.[key] ?? null
      }
    : { key: null, label: '指标', value: null, previousValue: null }
}

export function preferredSnapshotMetricKey(
  snapshots: readonly ContentSnapshot[]
): ContentMetricKey | null {
  return metricOrder.find((candidate) => snapshots.some((snapshot) => snapshot[candidate] !== null)) ?? null
}

export function contentMetricLabel(key: ContentMetricKey): string {
  return labels[key]
}
