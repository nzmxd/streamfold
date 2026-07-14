import type { SyncMode } from './contracts'
import type { JobRecord } from './job-contracts'

/** Identity states shared by every first-party, session-backed platform adapter. */
export type SessionApiIdentityStatus =
  | 'confirmation_required'
  | 'verified'
  | 'identity_mismatch'
  | 'login_required'

export interface SessionApiIdentityCheckResult {
  accountId: string
  status: SessionApiIdentityStatus
  remoteId: string | null
  remoteName: string | null
  confirmationToken: string | null
  confirmationExpiresAt: string | null
  verifiedAt: string | null
  message: string
}

export interface ConfirmSessionApiIdentityInput {
  accountId: string
  token: string
  confirmIdentity: boolean
}

/**
 * Platform-neutral profile summary returned after a managed sync.
 *
 * Platform-specific metrics are optional so adapters can expose only values
 * that their fixed JSON endpoints actually provide. Missing metrics must not
 * be coerced to zero.
 */
export interface SessionApiSyncProfile {
  remoteId: string
  remoteName: string
  avatarAvailable: boolean
  followers: number | null
  following: number | null
  bio: string
  contentCount?: number | null
  likes?: number | null
  favorites?: number | null
  likesAndFavorites?: number | null
  thanks?: number | null
  creatorLevel?: number | null
}

export interface SessionApiSyncStats {
  newContentCount: number
  updatedContentCount: number
  snapshotCount: number
  skippedSnapshotCount: number
}

export interface SessionApiSyncResult {
  accountId: string
  mode: Exclude<SyncMode, 'disabled'>
  capturedAt: string
  profile: SessionApiSyncProfile
  contentCount: number
  stats: SessionApiSyncStats
  job: JobRecord
  message: string
}
