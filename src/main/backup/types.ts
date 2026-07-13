export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

export const BACKUP_FORMAT = 'social-vault-encrypted-backup' as const
export const BACKUP_FORMAT_VERSION = 1 as const

export interface EncryptedBackupEnvelopeV1 {
  format: typeof BACKUP_FORMAT
  version: typeof BACKUP_FORMAT_VERSION
  kdf: {
    name: 'scrypt'
    salt: string
    N: number
    r: number
    p: number
    keyLength: 32
  }
  cipher: {
    name: 'aes-256-gcm'
    iv: string
    tag: string
  }
  checksum: {
    name: 'sha256'
    value: string
  }
  ciphertext: string
}
