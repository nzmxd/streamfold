export const adapterOperations = ['probe', 'whoami'] as const
export type AdapterOperation = (typeof adapterOperations)[number]

export const adapterPageKinds = ['creator', 'login', 'unsupported'] as const
export type AdapterPageKind = (typeof adapterPageKinds)[number]

export const adapterExecutionStatuses = [
  'ready',
  'login_required',
  'challenge',
  'page_not_ready',
  'unsupported'
] as const
export type AdapterExecutionStatus = (typeof adapterExecutionStatuses)[number]

export const probeEvidenceCodes = [
  'dom_ready',
  'official_creator_host',
  'login_route',
  'visible_login_control',
  'challenge_route',
  'visible_challenge',
  'document_loading',
  'visible_account_control',
  'visible_profile_link'
] as const
export type ProbeEvidenceCode = (typeof probeEvidenceCodes)[number]

export const whoamiEvidenceCodes = [
  'official_creator_host',
  'login_route',
  'visible_login_control',
  'challenge_route',
  'visible_challenge',
  'document_loading',
  'visible_account_control',
  'visible_profile_link',
  'visible_user_id',
  'conflicting_identity'
] as const
export type WhoamiEvidenceCode = (typeof whoamiEvidenceCodes)[number]

export interface AdapterProbeResult {
  schemaVersion: 1
  operation: 'probe'
  adapterId: string
  adapterVersion: string
  scriptVersion: string
  pageUrl: string
  pageKind: AdapterPageKind
  supported: boolean
  status: AdapterExecutionStatus
  evidence: ProbeEvidenceCode[]
}

export interface AdapterIdentity {
  remoteId: string
  remoteName: string
  profileUrl: string | null
}

export interface AdapterWhoamiResult {
  schemaVersion: 1
  operation: 'whoami'
  adapterId: string
  adapterVersion: string
  scriptVersion: string
  pageUrl: string
  pageKind: AdapterPageKind
  status: AdapterExecutionStatus
  identity: AdapterIdentity | null
  evidence: WhoamiEvidenceCode[]
}

export interface AdapterScriptMetadata {
  operation: AdapterOperation
  version: string
  sha256: string
  executionWorld: 'isolated'
  permissions: readonly ['location.read', 'visible_dom.read']
  networkAccess: false
  credentialAccess: false
  mutatesPage: false
}

export interface PinnedAdapterScript {
  metadata: Readonly<AdapterScriptMetadata>
  script: string
}

export interface ManagedBrowserAdapterMetadata {
  schemaVersion: 1
  id: string
  version: string
  platformId: 'xiaohongshu'
  allowedHosts: readonly string[]
  readOnly: true
  capabilities: readonly AdapterOperation[]
}

export interface ManagedBrowserAdapter {
  metadata: Readonly<ManagedBrowserAdapterMetadata>
  scripts: Readonly<Record<AdapterOperation, PinnedAdapterScript>>
  parseProbeResult(value: unknown): AdapterProbeResult
  parseWhoamiResult(value: unknown): AdapterWhoamiResult
}
