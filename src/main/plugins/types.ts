import type { ContentSnapshot, ContentType } from '../../shared/content-contracts'

export interface NormalizedImportProfile {
  remoteId: string
  remoteName: string
  followers: number | null
  following: number | null
  contentCount: number | null
  viewsTotal: number | null
}

export interface NormalizedImportContent {
  remoteId: string
  type: ContentType
  title: string
  bodyExcerpt: string
  url: string
  publishedAt: string | null
  snapshots: ContentSnapshot[]
}

export interface NormalizedImportPayload {
  capturedAt: string
  profile: NormalizedImportProfile | null
  contents: NormalizedImportContent[]
  warnings: string[]
}

export interface ImportCommitMetadata {
  accountId: string
  pluginId: string
  jobId?: string
  fileName: string
  fileHash: string
  confirmOwnership: boolean
}

export interface ImportCommitStats {
  newContentCount: number
  updatedContentCount: number
  snapshotCount: number
  skippedSnapshotCount: number
}
