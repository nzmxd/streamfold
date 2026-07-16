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

export type ContentMetricValueKind = 'count' | 'ratio' | 'duration'
export type ContentMetricUnit = 'count' | 'ratio' | 'seconds'
export type ContentMetricGroup = 'reach' | 'engagement' | 'conversion' | 'other'
export const metricMeasurements = ['cumulative', 'period_total', 'gauge'] as const
export type MetricMeasurement = (typeof metricMeasurements)[number]

export const standardContentMetricIds = [
  'views',
  'likes',
  'comments',
  'shares',
  'favorites'
] as const
export type StandardContentMetricId = (typeof standardContentMetricIds)[number]
export const standardAccountMetricIds = ['followers', 'content_count'] as const
export type StandardAccountMetricId = (typeof standardAccountMetricIds)[number]
export const standardAnalyticsMetricIds = [
  ...standardContentMetricIds,
  ...standardAccountMetricIds
] as const
export type StandardAnalyticsMetricId = (typeof standardAnalyticsMetricIds)[number]

export interface ContentMetricDefinition {
  id: string
  label: string
  valueKind: ContentMetricValueKind
  unit: ContentMetricUnit
  group: ContentMetricGroup
  sortOrder: number
  /** Omitted by legacy adapters; the host then treats the metric as a gauge. */
  measurementKind?: MetricMeasurement
  /** Enables defensible cross-platform comparison when explicitly declared. */
  standardMetricId?: StandardContentMetricId | null
}

export const accountMetricPeriods = [
  'daily',
  'last_7_days',
  'last_14_days',
  'last_30_days',
  'lifetime'
] as const
export type AccountMetricPeriod = (typeof accountMetricPeriods)[number]

export interface AccountMetricDefinition {
  id: string
  label: string
  valueKind: ContentMetricValueKind
  unit: ContentMetricUnit
  group: ContentMetricGroup
  sortOrder: number
}

export interface AccountMetricSnapshot {
  accountId: string
  period: AccountMetricPeriod
  periodStart: string | null
  periodEnd: string
  status: string | null
  metrics: Record<string, number | null>
  capturedAt: string
}

export interface AccountMetricQuery {
  accountId: string
  period?: AccountMetricPeriod
  from?: string
  to?: string
  limit?: number
  offset?: number
}

export interface AccountMetricHistory {
  accountId: string
  platformId: PlatformId
  metricDefinitions: AccountMetricDefinition[]
  snapshots: AccountMetricSnapshot[]
}

export interface ContentSnapshot extends MetricValues {
  metrics: Record<string, number | null>
  capturedAt: string
}

export interface ContentHistorySnapshot extends ContentSnapshot {
  snapshotId: string
  contributionId: string
  semanticsRevision: string
}

export interface ContentMetricSemanticsRevision {
  contributionId: string
  semanticsRevision: string
  metricDefinitions: ContentMetricDefinition[]
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
  lastCapturedAt: string
  updatedAt: string
  note: string
  tags: string[]
  isBookmarked: boolean
  latestSnapshot: ContentSnapshot | null
  previousSnapshot: ContentSnapshot | null
}

export interface ContentDetail extends ContentSummary {
  snapshots: ContentHistorySnapshot[]
  snapshotCount: number
  snapshotsTruncated: boolean
  metricDefinitions: ContentMetricDefinition[]
  metricSemantics: ContentMetricSemanticsRevision[]
}

export interface ContentDetailOptions {
  /** Null is reserved for explicit full-history exports. */
  historyLimit?: number | null
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
  isBookmarked?: boolean
}

export const contentSearchSorts = [
  'relevance',
  'published',
  'captured',
  'views',
  'interactions'
] as const
export type ContentSearchSort = (typeof contentSearchSorts)[number]
export type ContentSearchOrder = 'asc' | 'desc'
export type ContentTagMatch = 'all' | 'any'

export interface ContentSearchQuery {
  keyword?: string
  accountIds?: string[]
  platformId?: PlatformId
  groupId?: string
  type?: ContentType
  tags?: string[]
  tagMatch?: ContentTagMatch
  bookmarked?: boolean
  publishedFrom?: string
  publishedTo?: string
  capturedFrom?: string
  capturedTo?: string
  sort?: ContentSearchSort
  order?: ContentSearchOrder
  limit?: number
  offset?: number
}

export interface ContentSearchPage {
  items: ContentSummary[]
  total: number
  offset: number
  limit: number
  hasMore: boolean
  searchMode: 'none' | 'fts' | 'like' | 'hybrid'
}

export interface ContentTagFacetQuery {
  search?: string
  accountIds?: string[]
  platformId?: PlatformId
  groupId?: string
  limit?: number
}

export interface ContentTagFacet {
  tag: string
  count: number
}

export interface BulkUpdateContentsInput {
  contentIds: string[]
  isBookmarked?: boolean
  tagChange?: {
    action: 'add' | 'remove'
    tags: string[]
  }
}

export interface BulkUpdateContentsResult {
  requestedCount: number
  updatedCount: number
}

export interface ExportFilteredContentsInput {
  query: ContentSearchQuery
  format: 'json' | 'csv'
  includeSnapshots?: boolean
}

export interface ContentObservation {
  id: string
  contentId: string
  jobId: string | null
  snapshotId: string | null
  contributionId: string
  semanticsRevision: string
  observedAt: string
}

export interface AccountSnapshot extends MetricValues {
  accountId: string
  followers: number | null
  following: number | null
  contentCount: number | null
  viewsTotal: number | null
  likesAndFavoritesTotal: number | null
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

export type AnalyticsReliabilityStatus = 'complete' | 'partial' | 'missing' | 'revision' | 'pending'

export interface AnalyticsScope {
  accountIds?: string[]
  platformId?: PlatformId
  groupId?: string
  publishedFrom?: string
  publishedTo?: string
  capturedFrom?: string
  capturedTo?: string
}

export interface AnalyticsSummaryQuery extends AnalyticsScope {
  standardMetricIds?: StandardAnalyticsMetricId[]
}

export interface AnalyticsMetricSummary {
  metricId: StandardAnalyticsMetricId
  label: string
  current: number | null
  delta: number | null
  growthRate: number | null
  sampleCount: number
  missingCount: number
  revisionCount: number
  status: AnalyticsReliabilityStatus
}

export interface AnalyticsDataQuality {
  contentCount: number
  observedContentCount: number
  unobservedContentCount: number
  missingPublishedAtCount: number
  missingMetricCounts: Partial<Record<StandardAnalyticsMetricId, number>>
  revisionCount: number
  latestObservationAt: string | null
  accounts: AnalyticsAccountQuality[]
  warnings: AnalyticsQualityWarning[]
}

export interface AnalyticsAccountQuality {
  accountId: string
  accountAlias: string
  platformId: PlatformId
  contentCount: number
  observedContentCount: number
  missingPublishedAtCount: number
  lastSyncedAt: string | null
  latestObservationAt: string | null
}

export interface AnalyticsQualityWarning {
  accountId: string
  jobId: string
  occurredAt: string
  message: string
}

export interface AnalyticsSummary {
  metrics: AnalyticsMetricSummary[]
  quality: AnalyticsDataQuality
  generatedAt: string
}

export type AnalyticsComparisonDimension = 'account' | 'platform' | 'group' | 'week'

export interface AnalyticsComparisonQuery extends AnalyticsScope {
  dimension: AnalyticsComparisonDimension
  standardMetricIds?: StandardAnalyticsMetricId[]
}

export interface AnalyticsComparisonRow {
  id: string
  label: string
  platformId: PlatformId | null
  contentCount: number
  metrics: AnalyticsMetricSummary[]
}

export interface AnalyticsComparison {
  dimension: AnalyticsComparisonDimension
  rows: AnalyticsComparisonRow[]
  generatedAt: string
}

export const lifecycleMilestoneIds = ['24h', '7d', '30d'] as const
export type LifecycleMilestoneId = (typeof lifecycleMilestoneIds)[number]

export interface ContentLifecycleQuery extends AnalyticsScope {
  standardMetricId?: StandardContentMetricId
  limit?: number
  offset?: number
}

export interface ContentLifecycleMilestone {
  id: LifecycleMilestoneId
  targetHours: number
  status: AnalyticsReliabilityStatus
  value: number | null
  delta: number | null
  growthRate: number | null
  observedAt: string | null
}

export interface ContentLifecycleItem {
  contentId: string
  accountId: string
  accountAlias: string
  platformId: PlatformId
  title: string
  publishedAt: string
  milestones: ContentLifecycleMilestone[]
}

export interface ContentLifecycleAggregate {
  id: LifecycleMilestoneId
  medianValue: number | null
  medianDelta: number | null
  sampleCount: number
  pendingCount: number
  missingCount: number
  revisionCount: number
}

export interface ContentLifecycleResult {
  metricId: StandardContentMetricId
  items: ContentLifecycleItem[]
  aggregates: ContentLifecycleAggregate[]
  total: number
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
  reminders: DashboardReminder[]
}
