export const jobStatuses = [
  'queued',
  'validating',
  'committing',
  'succeeded',
  'failed',
  'cancelled',
  'interrupted'
] as const
export type JobStatus = (typeof jobStatuses)[number]
export type JobKind = 'managed_sync'

export interface JobRecord {
  id: string
  kind: JobKind
  accountId: string
  pluginId: string
  status: JobStatus
  progress: number
  stage: string
  result: Record<string, unknown> | null
  errorCode: string
  errorMessage: string
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
}
