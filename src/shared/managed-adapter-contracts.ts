export const managedIdentityStatuses = [
  'verified',
  'login_required',
  'challenge',
  'page_not_ready',
  'unsupported',
  'identity_mismatch',
  'confirmation_required'
] as const
export type ManagedIdentityStatus = (typeof managedIdentityStatuses)[number]

export interface ManagedIdentityCheckResult {
  accountId: string
  adapterId: string
  adapterVersion: string
  status: ManagedIdentityStatus
  pageUrl: string
  remoteId: string | null
  remoteName: string
  profileUrl: string | null
  evidence: string[]
  verifiedAt: string | null
  message: string
  confirmationToken: string | null
  confirmationExpiresAt: string | null
}

export interface ConfirmManagedIdentityInput {
  accountId: string
  token: string
  confirmIdentity: boolean
}
