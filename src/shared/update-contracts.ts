export const updatePhases = [
  'unsupported',
  'idle',
  'checking',
  'up-to-date',
  'available',
  'downloading',
  'downloaded',
  'error'
] as const

export type UpdatePhase = (typeof updatePhases)[number]

export type UpdateUnsupportedReason =
  | 'development'
  | 'missing-source'
  | 'unsupported-package'

export interface UpdateProgress {
  percent: number
  transferred: number
  total: number
  bytesPerSecond: number
}

export interface UpdateState {
  phase: UpdatePhase
  currentVersion: string
  availableVersion: string | null
  releaseDate: string | null
  lastCheckedAt: string | null
  progress: UpdateProgress | null
  error: string
  automaticChecks: boolean
  unsupportedReason: UpdateUnsupportedReason | null
}

export interface UpdateApi {
  getState(): Promise<UpdateState>
  check(): Promise<UpdateState>
  download(): Promise<UpdateState>
  restartAndInstall(): Promise<void>
  onChanged(callback: (state: UpdateState) => void): () => void
}
