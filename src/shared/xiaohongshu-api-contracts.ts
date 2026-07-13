import type { JobRecord } from './job-contracts'

export type ApiIdentityStatus =
  | 'confirmation_required'
  | 'verified'
  | 'identity_mismatch'
  | 'login_required'

export interface ApiIdentityCheckResult {
  accountId: string
  status: ApiIdentityStatus
  remoteId: string | null
  remoteName: string | null
  confirmationToken: string | null
  confirmationExpiresAt: string | null
  verifiedAt: string | null
  message: string
}

export interface ConfirmApiIdentityInput {
  accountId: string
  token: string
  confirmIdentity: boolean
}

export interface XiaohongshuSyncProfile {
  remoteId: string
  remoteName: string
  avatarAvailable: boolean
  followers: number
  following: number
  likesAndFavorites: number
  bio: string
  creatorLevel: number | null
}

export interface XiaohongshuSyncResult {
  accountId: string
  mode: 'profile_only' | 'recent_20' | 'recent_100'
  capturedAt: string
  profile: XiaohongshuSyncProfile
  contentCount: number
  stats: {
    newContentCount: number
    updatedContentCount: number
    snapshotCount: number
    skippedSnapshotCount: number
  }
  job: JobRecord
  message: string
}
