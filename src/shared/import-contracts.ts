import type { ContentSnapshot, ContentType } from './content-contracts'
import type { JobRecord } from './job-contracts'

export interface ImportIdentityPreview {
  remoteId: string
  remoteName: string
  followers: number | null
  following: number | null
  contentCount: number | null
  viewsTotal: number | null
}

export interface ImportContentPreview {
  remoteId: string
  type: ContentType
  title: string
  publishedAt: string | null
  latestSnapshot: ContentSnapshot | null
}

export interface FileImportPreview {
  token: string
  accountId: string
  fileName: string
  format: 'json' | 'csv'
  fileHash: string
  expiresAt: string
  identity: ImportIdentityPreview | null
  contentCount: number
  snapshotCount: number
  warnings: string[]
  sample: ImportContentPreview[]
}

export interface CommitFileImportInput {
  token: string
  accountId: string
  confirmOwnership: boolean
}

export interface FileImportResult {
  job: JobRecord
  newContentCount: number
  updatedContentCount: number
  snapshotCount: number
  skippedSnapshotCount: number
}
