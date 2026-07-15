import type {
  ContentMetricDefinition,
  ContentType,
  MetricValues
} from '../../shared/content-contracts'

export interface StandardProfile {
  remoteId: string
  remoteName: string
  /** Transient, manifest-constrained source URL; the host converts it to a local cache key. */
  avatarUrl?: string
  avatarCacheKey?: string | null
  avatarMime?: string | null
  bio?: string
  creatorLevel?: number | null
  followers: number | null
  following: number | null
  contentCount: number | null
  viewsTotal: number | null
  likesAndFavoritesTotal?: number | null
  views?: number | null
  likes?: number | null
  comments?: number | null
  shares?: number | null
  favorites?: number | null
}

export interface StandardContentSnapshot extends MetricValues {
  /** Optional on adapter input for compatibility; the host always returns a concrete record. */
  metrics?: Record<string, number | null>
  capturedAt: string
}

export interface StandardContent {
  remoteId: string
  type: ContentType
  title: string
  bodyExcerpt: string
  url: string
  publishedAt: string | null
  snapshots: StandardContentSnapshot[]
}

/** Platform-neutral dataset produced by a verified, read-only platform adapter. */
export interface StandardDataset {
  capturedAt: string
  profile: StandardProfile | null
  contents: StandardContent[]
  contentMetricDefinitions?: ContentMetricDefinition[]
  warnings: string[]
}

export interface DatasetCommitStats {
  newContentCount: number
  updatedContentCount: number
  snapshotCount: number
  skippedSnapshotCount: number
}
