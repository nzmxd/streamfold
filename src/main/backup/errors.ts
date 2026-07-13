export type SafeBackupErrorCode =
  | 'BACKUP_PASSWORD_TOO_SHORT'
  | 'BACKUP_PASSWORD_TOO_LONG'
  | 'BACKUP_PAYLOAD_INVALID'
  | 'BACKUP_TOO_LARGE'
  | 'BACKUP_FORMAT_INVALID'
  | 'BACKUP_VERSION_UNSUPPORTED'
  | 'BACKUP_INTEGRITY_FAILED'
  | 'BACKUP_AUTHENTICATION_FAILED'
  | 'BACKUP_ENCRYPTION_FAILED'
  | 'BACKUP_DECRYPTION_FAILED'

/**
 * An error whose code and message are safe to expose to the renderer.
 *
 * Internal crypto errors are intentionally not attached as `cause`: their
 * messages are implementation details and must never end up in logs or IPC.
 */
export class SafeBackupError extends Error {
  readonly code: SafeBackupErrorCode

  constructor(code: SafeBackupErrorCode, message: string) {
    super(message)
    this.name = 'SafeBackupError'
    this.code = code
  }
}

export function isSafeBackupError(error: unknown): error is SafeBackupError {
  return error instanceof SafeBackupError
}
