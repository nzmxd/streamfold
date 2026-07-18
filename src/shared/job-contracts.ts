export const jobStatuses = [
  'queued',
  'validating',
  'committing',
  'succeeded',
  'succeeded_with_warnings',
  'failed',
  'cancelled',
  'interrupted'
] as const
export type JobStatus = (typeof jobStatuses)[number]
export type JobKind = 'managed_sync'

export const taskTriggers = ['manual', 'scheduled', 'event', 'retry'] as const
export type TaskTrigger = (typeof taskTriggers)[number]

export const requestedSyncModes = ['profile_only', 'recent_20', 'recent_100'] as const
export type RequestedSyncMode = (typeof requestedSyncModes)[number]

export const syncBatchScopes = ['account_default', ...requestedSyncModes] as const
export type SyncBatchScope = (typeof syncBatchScopes)[number]

export interface JobRecord {
  id: string
  batchId: string | null
  kind: JobKind
  accountId: string
  pluginId: string
  contributionId: string
  trigger: TaskTrigger
  status: JobStatus
  progress: number
  stage: string
  attempt: number
  retryOfJobId: string | null
  requestedSyncMode: RequestedSyncMode | null
  result: Record<string, unknown> | null
  errorCode: string
  errorMessage: string
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
}

export interface JobBatchRecord {
  id: string
  trigger: TaskTrigger
  requestedScope: SyncBatchScope
  createdAt: string
}

/** Stable renderer-facing view over account jobs and plugin runs. */
export const taskStatuses = [
  'queued',
  'running',
  'succeeded',
  'succeeded_with_warnings',
  'failed',
  'cancelled',
  'interrupted',
  'paused'
] as const
export type TaskStatus = (typeof taskStatuses)[number]

export const taskKinds = [
  'account.sync',
  'plugin.action',
  'plugin.event',
  'plugin.schedule'
] as const
export type TaskKind = (typeof taskKinds)[number]

export const taskSources = ['job', 'plugin-run'] as const
export type TaskSource = (typeof taskSources)[number]

export const taskAttentionStates = ['pending', 'handled', 'superseded'] as const
export type TaskAttentionState = (typeof taskAttentionStates)[number]

export const taskAttentionFilters = ['pending', 'resolved'] as const
export type TaskAttentionFilter = (typeof taskAttentionFilters)[number]

export interface TaskAttentionResolutionRecord {
  source: TaskSource
  taskId: string
  resolvedAt: string
}

export interface MarkTaskHandledInput {
  source: TaskSource
  taskId: string
}

export interface TaskView {
  id: string
  source: TaskSource
  batchId: string | null
  kind: TaskKind
  trigger: TaskTrigger
  status: TaskStatus
  accountId: string | null
  accountAlias: string
  platformId: string | null
  pluginId: string | null
  contributionId: string | null
  progress: number | null
  stage: string
  attempt: number
  errorCode: string
  errorMessage: string
  coverage: import('./contracts').SyncCoverage | null
  warnings: string[]
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  nextAttemptAt: string | null
  attentionState: TaskAttentionState | null
  attentionResolvedAt: string | null
  attentionSupersededByTaskId: string | null
}

export interface TaskQuery {
  batchId?: string
  kinds?: TaskKind[]
  statuses?: TaskStatus[]
  triggers?: TaskTrigger[]
  platformId?: string
  accountId?: string
  pluginId?: string
  contributionId?: string
  createdFrom?: string
  createdTo?: string
  search?: string
  attention?: TaskAttentionFilter
  offset?: number
  limit?: number
}

export interface TaskListResult {
  items: TaskView[]
  total: number
  offset: number
  limit: number
}

export interface TaskSummary {
  queuedCount: number
  runningCount: number
  needsAttentionCount: number
  completedTodayCount: number
  partialTodayCount: number
  failedTodayCount: number
  updatedAt: string
}

export interface TaskBatchView {
  batch: JobBatchRecord
  tasks: TaskView[]
  totalCount: number
  queuedCount: number
  runningCount: number
  succeededCount: number
  partialCount: number
  failedCount: number
  cancelledCount: number
  interruptedCount: number
  pausedCount: number
  needsAttentionCount: number
}

export type SyncBatchPreviewStatus =
  | 'ready'
  | 'sync_disabled'
  | 'login_required'
  | 'identity_required'
  | 'adapter_unavailable'
  | 'scope_not_authorized'
  | 'already_queued'

export interface SyncBatchPreviewAccount {
  accountId: string
  accountAlias: string
  platformId: string
  contributionId: string | null
  requestedSyncMode: RequestedSyncMode | null
  status: SyncBatchPreviewStatus
  message: string
}

export interface SyncBatchPreview {
  requestedScope: SyncBatchScope
  accounts: SyncBatchPreviewAccount[]
  eligibleAccountIds: string[]
  skippedAccountIds: string[]
}

/** Account IDs and group IDs are merged and de-duplicated by the host. */
export interface EnqueueSyncBatchInput {
  accountIds?: string[]
  groupIds?: string[]
  requestedScope?: SyncBatchScope
  trigger?: TaskTrigger
}

export interface EnqueueSyncBatchResult {
  batch: JobBatchRecord
  jobs: JobRecord[]
  skipped: SyncBatchPreviewAccount[]
}
