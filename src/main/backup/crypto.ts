import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scrypt as nodeScrypt,
  timingSafeEqual
} from 'node:crypto'
import { isSafeBackupError, SafeBackupError } from './errors'
import {
  BACKUP_FORMAT,
  BACKUP_FORMAT_VERSION,
  type EncryptedBackupEnvelopeV1,
  type JsonValue
} from './types'

const SALT_BYTES = 16
const IV_BYTES = 12
const TAG_BYTES = 16
const KEY_BYTES = 32
const CHECKSUM_BYTES = 32

// 64 MiB of scrypt working memory. The explicit maxmem includes OpenSSL's
// overhead and prevents hostile backup files from choosing their own KDF cost.
const SCRYPT_N = 2 ** 16
const SCRYPT_R = 8
const SCRYPT_P = 1
const SCRYPT_MAXMEM = 96 * 1024 * 1024

const MIN_PASSWORD_BYTES = 8
const MAX_PASSWORD_BYTES = 1_024
// A 256 MiB SQLite image expands to roughly 342 MiB when embedded as base64.
// The encrypted envelope adds one more base64 layer, so the paired limits must
// be sized together rather than treating the database image as the JSON size.
const MAX_PLAINTEXT_BYTES = 384 * 1024 * 1024
const MAX_ENVELOPE_BYTES = 512 * 1024 * 1024

const ENVELOPE_KEYS = ['format', 'version', 'kdf', 'cipher', 'checksum', 'ciphertext']
const KDF_KEYS = ['name', 'salt', 'N', 'r', 'p', 'keyLength']
const CIPHER_KEYS = ['name', 'iv', 'tag']
const CHECKSUM_KEYS = ['name', 'value']

type AuthenticatedMetadata = {
  format: typeof BACKUP_FORMAT
  version: typeof BACKUP_FORMAT_VERSION
  kdf: EncryptedBackupEnvelopeV1['kdf']
  cipher: Pick<EncryptedBackupEnvelopeV1['cipher'], 'name' | 'iv'>
  checksum: Pick<EncryptedBackupEnvelopeV1['checksum'], 'name'>
}

/** Encrypts one strictly JSON-compatible value into a versioned backup file. */
export async function encryptJsonBackup(payload: JsonValue, password: string): Promise<Buffer> {
  let plaintext: Buffer
  try {
    assertJsonValue(payload)
    plaintext = Buffer.from(JSON.stringify(payload), 'utf8')
  } catch (error) {
    if (isSafeBackupError(error)) throw error
    throw new SafeBackupError('BACKUP_PAYLOAD_INVALID', '备份数据必须是有效的 JSON')
  }
  if (plaintext.length > MAX_PLAINTEXT_BYTES) {
    plaintext.fill(0)
    throw new SafeBackupError('BACKUP_TOO_LARGE', '备份数据超过允许的大小')
  }

  const salt = randomBytes(SALT_BYTES)
  const iv = randomBytes(IV_BYTES)
  let ciphertext: Buffer | undefined
  let key: Buffer | undefined

  try {
    key = await deriveKey(password, salt)
    const metadata = createMetadata(salt, iv)
    const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES })
    cipher.setAAD(serializeMetadata(metadata))
    ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
    const tag = cipher.getAuthTag()

    const envelope: EncryptedBackupEnvelopeV1 = {
      ...metadata,
      cipher: { ...metadata.cipher, tag: tag.toString('base64') },
      checksum: {
        name: 'sha256',
        value: sha256(ciphertext).toString('base64')
      },
      ciphertext: ciphertext.toString('base64')
    }
    return Buffer.from(JSON.stringify(envelope), 'utf8')
  } catch (error) {
    if (isSafeBackupError(error)) throw error
    throw new SafeBackupError('BACKUP_ENCRYPTION_FAILED', '无法创建加密备份')
  } finally {
    plaintext.fill(0)
    key?.fill(0)
    salt.fill(0)
    iv.fill(0)
    ciphertext?.fill(0)
  }
}

/** Decrypts and authenticates a backup file, returning its original JSON value. */
export async function decryptJsonBackup(file: Uint8Array, password: string): Promise<JsonValue> {
  const envelope = parseEnvelope(file)
  const salt = decodeBase64(envelope.kdf.salt, SALT_BYTES)
  const iv = decodeBase64(envelope.cipher.iv, IV_BYTES)
  const tag = decodeBase64(envelope.cipher.tag, TAG_BYTES)
  const expectedChecksum = decodeBase64(envelope.checksum.value, CHECKSUM_BYTES)
  const ciphertext = decodeBase64(envelope.ciphertext)
  const actualChecksum = sha256(ciphertext)

  if (!timingSafeEqual(actualChecksum, expectedChecksum)) {
    throw new SafeBackupError('BACKUP_INTEGRITY_FAILED', '备份文件完整性校验失败')
  }

  let key: Buffer | undefined
  let plaintext: Buffer | undefined
  try {
    key = await deriveKey(password, salt)
    const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES })
    decipher.setAAD(serializeMetadata(envelope))
    decipher.setAuthTag(tag)
    try {
      plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
    } catch {
      throw new SafeBackupError(
        'BACKUP_AUTHENTICATION_FAILED',
        '备份密码错误或文件已被篡改'
      )
    }

    if (plaintext.length > MAX_PLAINTEXT_BYTES) {
      throw new SafeBackupError('BACKUP_TOO_LARGE', '备份数据超过允许的大小')
    }
    const value = parseJsonPayload(plaintext)
    assertJsonValue(value)
    return value
  } catch (error) {
    if (isSafeBackupError(error)) throw error
    throw new SafeBackupError('BACKUP_DECRYPTION_FAILED', '无法解密备份文件')
  } finally {
    key?.fill(0)
    plaintext?.fill(0)
    salt.fill(0)
    iv.fill(0)
    tag.fill(0)
    expectedChecksum.fill(0)
    actualChecksum.fill(0)
    ciphertext.fill(0)
  }
}

function createMetadata(salt: Buffer, iv: Buffer): AuthenticatedMetadata {
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_FORMAT_VERSION,
    kdf: {
      name: 'scrypt',
      salt: salt.toString('base64'),
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
      keyLength: KEY_BYTES
    },
    cipher: { name: 'aes-256-gcm', iv: iv.toString('base64') },
    checksum: { name: 'sha256' }
  }
}

function serializeMetadata(envelope: AuthenticatedMetadata): Buffer {
  return Buffer.from(JSON.stringify({
    format: envelope.format,
    version: envelope.version,
    kdf: envelope.kdf,
    cipher: { name: envelope.cipher.name, iv: envelope.cipher.iv },
    checksum: { name: envelope.checksum.name }
  }), 'utf8')
}

async function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
  if (typeof password !== 'string') {
    throw new SafeBackupError('BACKUP_PASSWORD_TOO_SHORT', '备份密码至少需要 8 个字节')
  }
  const passwordBytes = Buffer.from(password, 'utf8')
  try {
    if (passwordBytes.length < MIN_PASSWORD_BYTES) {
      throw new SafeBackupError('BACKUP_PASSWORD_TOO_SHORT', '备份密码至少需要 8 个字节')
    }
    if (passwordBytes.length > MAX_PASSWORD_BYTES) {
      throw new SafeBackupError('BACKUP_PASSWORD_TOO_LONG', '备份密码超过允许的长度')
    }
    return await deriveScryptKey(passwordBytes, salt)
  } finally {
    passwordBytes.fill(0)
  }
}

function deriveScryptKey(password: Buffer, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    nodeScrypt(password, salt, KEY_BYTES, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
      maxmem: SCRYPT_MAXMEM
    }, (error, key) => error ? reject(error) : resolve(key))
  })
}

function parseEnvelope(file: Uint8Array): EncryptedBackupEnvelopeV1 {
  if (!(file instanceof Uint8Array) || file.byteLength === 0 || file.byteLength > MAX_ENVELOPE_BYTES) {
    throw new SafeBackupError(
      file.byteLength > MAX_ENVELOPE_BYTES ? 'BACKUP_TOO_LARGE' : 'BACKUP_FORMAT_INVALID',
      file.byteLength > MAX_ENVELOPE_BYTES ? '备份文件超过允许的大小' : '备份文件格式无效'
    )
  }

  let value: unknown
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(file))
  } catch {
    throw new SafeBackupError('BACKUP_FORMAT_INVALID', '备份文件格式无效')
  }
  const envelope = asRecord(value)
  assertExactKeys(envelope, ENVELOPE_KEYS)
  if (envelope.format !== BACKUP_FORMAT) invalidFormat()
  if (envelope.version !== BACKUP_FORMAT_VERSION) {
    throw new SafeBackupError('BACKUP_VERSION_UNSUPPORTED', '不支持此备份文件版本')
  }

  const kdf = asRecord(envelope.kdf)
  const cipher = asRecord(envelope.cipher)
  const checksum = asRecord(envelope.checksum)
  assertExactKeys(kdf, KDF_KEYS)
  assertExactKeys(cipher, CIPHER_KEYS)
  assertExactKeys(checksum, CHECKSUM_KEYS)
  if (
    kdf.name !== 'scrypt' || kdf.N !== SCRYPT_N || kdf.r !== SCRYPT_R ||
    kdf.p !== SCRYPT_P || kdf.keyLength !== KEY_BYTES || typeof kdf.salt !== 'string' ||
    cipher.name !== 'aes-256-gcm' || typeof cipher.iv !== 'string' || typeof cipher.tag !== 'string' ||
    checksum.name !== 'sha256' || typeof checksum.value !== 'string' ||
    typeof envelope.ciphertext !== 'string'
  ) invalidFormat()

  // The caller decodes and validates every field before running the KDF. Keep
  // this parser allocation-light so a large ciphertext is not decoded twice.
  return envelope as unknown as EncryptedBackupEnvelopeV1
}

function decodeBase64(value: string, exactBytes?: number): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    invalidFormat()
  }
  const decoded = Buffer.from(value, 'base64')
  if (decoded.toString('base64') !== value || (exactBytes !== undefined && decoded.length !== exactBytes)) {
    decoded.fill(0)
    invalidFormat()
  }
  return decoded
}

function parseJsonPayload(plaintext: Buffer): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext))
  } catch {
    throw new SafeBackupError('BACKUP_PAYLOAD_INVALID', '备份中的 JSON 数据无效')
  }
}

function assertJsonValue(value: unknown, seen = new Set<object>()): asserts value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return
    throw new SafeBackupError('BACKUP_PAYLOAD_INVALID', '备份数据必须是有效的 JSON')
  }
  if (typeof value !== 'object') {
    throw new SafeBackupError('BACKUP_PAYLOAD_INVALID', '备份数据必须是有效的 JSON')
  }
  if (seen.has(value)) {
    throw new SafeBackupError('BACKUP_PAYLOAD_INVALID', '备份数据必须是有效的 JSON')
  }
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      const keys = Reflect.ownKeys(value)
      if (keys.some((key) => {
        if (key === 'length') return false
        if (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key)) return true
        const index = Number(key)
        return !Number.isSafeInteger(index) || index >= value.length || String(index) !== key
      })) {
        invalidPayload()
      }
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) invalidPayload()
        assertJsonValue(descriptor.value, seen)
      }
      return
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      invalidPayload()
    }
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') invalidPayload()
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor?.enumerable || !('value' in descriptor)) invalidPayload()
      assertJsonValue(descriptor.value, seen)
    }
  } finally {
    seen.delete(value)
  }
}

function invalidPayload(): never {
  throw new SafeBackupError('BACKUP_PAYLOAD_INVALID', '备份数据必须是有效的 JSON')
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalidFormat()
  return value as Record<string, unknown>
}

function assertExactKeys(value: Record<string, unknown>, expected: string[]): void {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) invalidFormat()
}

function invalidFormat(): never {
  throw new SafeBackupError('BACKUP_FORMAT_INVALID', '备份文件格式无效')
}

function sha256(value: Uint8Array): Buffer {
  return createHash('sha256').update(value).digest()
}
