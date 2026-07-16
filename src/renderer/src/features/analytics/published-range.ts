import type { AnalyticsScope } from '../../../../shared/contracts'

export type PublishedRangePreset =
  | 'all'
  | 'this_week'
  | 'last_7_days'
  | 'this_month'
  | 'last_30_days'
  | 'last_90_days'
  | 'this_year'

export interface PublishedRangeOption {
  id: PublishedRangePreset
  label: string
  description: string
}

export const publishedRangeOptions: readonly PublishedRangeOption[] = [
  { id: 'all', label: '全部', description: '全部发帖时间' },
  { id: 'this_week', label: '本周', description: '本周一至现在' },
  { id: 'last_7_days', label: '近一周', description: '今天及此前 6 天' },
  { id: 'this_month', label: '本月', description: '本月 1 日至现在' },
  { id: 'last_30_days', label: '近一月', description: '今天及此前 29 天' },
  { id: 'last_90_days', label: '近三月', description: '今天及此前 89 天' },
  { id: 'this_year', label: '今年', description: '今年 1 月 1 日至现在' }
]

export function publishedRangeScope(
  preset: PublishedRangePreset,
  now = new Date()
): Pick<AnalyticsScope, 'publishedFrom' | 'publishedTo'> {
  if (preset === 'all') return {}

  const from = startOfLocalDay(now)
  if (preset === 'this_week') {
    const daysSinceMonday = (from.getDay() + 6) % 7
    from.setDate(from.getDate() - daysSinceMonday)
  } else if (preset === 'last_7_days') {
    from.setDate(from.getDate() - 6)
  } else if (preset === 'this_month') {
    from.setDate(1)
  } else if (preset === 'last_30_days') {
    from.setDate(from.getDate() - 29)
  } else if (preset === 'last_90_days') {
    from.setDate(from.getDate() - 89)
  } else {
    from.setMonth(0, 1)
  }

  return {
    publishedFrom: from.toISOString(),
    publishedTo: new Date(now).toISOString()
  }
}

function startOfLocalDay(value: Date): Date {
  const result = new Date(value)
  result.setHours(0, 0, 0, 0)
  return result
}
