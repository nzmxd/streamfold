export interface CreateEncryptedBackupInput {
  password: string
}

export interface RestoreEncryptedBackupInput {
  password: string
  confirmReplace: boolean
}

export interface EncryptedBackupResult {
  cancelled: boolean
  fileName: string | null
  databaseBytes: number
  warning: string
}
