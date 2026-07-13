import type { ContentType, JobStatus, PlatformId } from '../../../../shared/contracts'

export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—'
  return new Intl.NumberFormat('zh-CN', { notation: value >= 10_000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(value)
}

export function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`
  const units = ['KB', 'MB', 'GB']
  let size = value / 1024
  let unit = units[0]
  for (let index = 1; index < units.length && size >= 1024; index += 1) {
    size /= 1024
    unit = units[index]
  }
  return `${size.toFixed(size >= 10 ? 1 : 2)} ${unit}`
}

export function formatDate(value: string | null | undefined, includeTime = false): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat('zh-CN', includeTime
    ? { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }
    : { year: 'numeric', month: '2-digit', day: '2-digit' }).format(date)
}

export function delta(current: number | null | undefined, previous: number | null | undefined): number | null {
  if (current === null || current === undefined || previous === null || previous === undefined) return null
  return current - previous
}

export function deltaLabel(value: number | null): string {
  if (value === null) return '暂无对比'
  if (value === 0) return '与上次持平'
  return `${value > 0 ? '+' : ''}${formatNumber(value)} 较上次`
}

export function contentTypeLabel(type: ContentType): string {
  const labels: Record<ContentType, string> = {
    article: '文章',
    post: '动态',
    image: '图文',
    video: '视频',
    answer: '回答'
  }
  return labels[type]
}

export function platformLabel(id: PlatformId): string {
  const labels: Record<PlatformId, string> = {
    xiaohongshu: '小红书',
    weibo: '微博',
    douyin: '抖音',
    zhihu: '知乎'
  }
  return labels[id]
}

export function jobStatusLabel(status: JobStatus): string {
  const labels: Record<JobStatus, string> = {
    queued: '排队中',
    validating: '校验中',
    committing: '写入中',
    succeeded: '已完成',
    failed: '失败',
    cancelled: '已取消',
    interrupted: '已中断'
  }
  return labels[status]
}

export function messageOf(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value)
  return message
    .replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '')
    .replace(/^Error:\s*/, '')
}
