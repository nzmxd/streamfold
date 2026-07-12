import type { PlatformId } from './contracts'

export const contentTypes = ['article', 'post', 'image', 'video', 'answer'] as const
export type ContentType = (typeof contentTypes)[number]

export interface MetricValues {
  views: number | null
  likes: number | null
  comments: number | null
  shares: number | null
  favorites: number | null
}

export interface ContentSnapshot extends MetricValues {
  capturedAt: string
}

export interface ContentSummary {
  id: string
  accountId: string
  accountAlias: string
  platformId: PlatformId
  remoteId: string
  type: ContentType
  title: string
  bodyExcerpt: string
  url: string
  publishedAt: string | null
  firstCapturedAt: string
  updatedAt: string
  note: string
  tags: string[]
  latestSnapshot: ContentSnapshot | null
  previousSnapshot: ContentSnapshot | null
}

export interface ContentDetail extends ContentSummary {
  snapshots: ContentSnapshot[]
}

export interface ContentQuery {
  accountId?: string
  platformId?: PlatformId
  type?: ContentType
  query?: string
  from?: string
  to?: string
  limit?: number
  offset?: number
}

export interface UpdateContentInput {
  id: string
  note?: string
  tags?: string[]
}

export interface AccountSnapshot extends MetricValues {
  accountId: string
  followers: number | null
  following: number | null
  contentCount: number | null
  viewsTotal: number | null
  capturedAt: string
}

export interface AnalyticsQuery {
  accountId?: string
  platformId?: PlatformId
  days?: 7 | 30 | 90 | 365
}

export interface AnalyticsTimelinePoint {
  date: string
  views: number
  interactions: number
  followers: number | null
}

export interface AnalyticsAccountRow {
  accountId: string
  accountAlias: string
  platformId: PlatformId
  contentCount: number
  views: number
  interactions: number
  followers: number | null
}

export interface AnalyticsOverview {
  days: 7 | 30 | 90 | 365
  contentCount: number
  views: number
  interactions: number
  followers: number
  timeline: AnalyticsTimelinePoint[]
  accounts: AnalyticsAccountRow[]
  byType: Array<{ type: ContentType; count: number }>
  generatedAt: string
}

export interface DashboardReminder {
  id: string
  tone: 'info' | 'warning' | 'danger'
  title: string
  detail: string
  accountId: string | null
}

export interface DashboardOverview {
  accountCount: number
  readyAccountCount: number
  attentionAccountCount: number
  contentCount: number
  views: number
  interactions: number
  lastImportedAt: string | null
  reminders: DashboardReminder[]
}
