import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { decryptJsonBackup, encryptJsonBackup } from './crypto'
import { SafeBackupError } from './errors'
import { BACKUP_FORMAT } from './types'

const PASSWORD = 'correct horse battery staple'

describe('encrypted JSON backups', () => {
  it('round-trips nested JSON without changing its value', async () => {
    const payload = {
      account: { id: 'account-1', alias: '工作号', active: true },
      metrics: [0, 12.5, null],
      note: '仅保存在本地'
    }
    const backup = await encryptJsonBackup(payload, PASSWORD)

    expect(await decryptJsonBackup(backup, PASSWORD)).toEqual(payload)
  })

  it('uses a strict versioned AES-GCM and scrypt envelope', async () => {
    const backup = await encryptJsonBackup({ ok: true }, PASSWORD)
    const envelope = JSON.parse(backup.toString('utf8'))

    expect(envelope.format).toBe(BACKUP_FORMAT)
    expect(envelope.version).toBe(1)
    expect(envelope.kdf).toMatchObject({ name: 'scrypt', N: 65_536, r: 8, p: 1, keyLength: 32 })
    expect(Buffer.from(envelope.kdf.salt, 'base64')).toHaveLength(16)
    expect(envelope.cipher.name).toBe('aes-256-gcm')
    expect(Buffer.from(envelope.cipher.iv, 'base64')).toHaveLength(12)
    expect(Buffer.from(envelope.cipher.tag, 'base64')).toHaveLength(16)
    expect(Buffer.from(envelope.checksum.value, 'base64')).toEqual(
      createHash('sha256').update(Buffer.from(envelope.ciphertext, 'base64')).digest()
    )
  })

  it('creates different ciphertext, salt and IV for the same input', async () => {
    const first = JSON.parse((await encryptJsonBackup('same', PASSWORD)).toString('utf8'))
    const second = JSON.parse((await encryptJsonBackup('same', PASSWORD)).toString('utf8'))

    expect(first.kdf.salt).not.toBe(second.kdf.salt)
    expect(first.cipher.iv).not.toBe(second.cipher.iv)
    expect(first.ciphertext).not.toBe(second.ciphertext)
  })

  it('does not distinguish a wrong password from authenticated tampering', async () => {
    const backup = await encryptJsonBackup({ secret: 'value' }, PASSWORD)
    await expect(decryptJsonBackup(backup, 'another secure password')).rejects.toMatchObject({
      code: 'BACKUP_AUTHENTICATION_FAILED',
      message: '备份密码错误或文件已被篡改'
    })

    const envelope = JSON.parse(backup.toString('utf8'))
    const tag = Buffer.from(envelope.cipher.tag, 'base64')
    tag[0] = (tag[0] ?? 0) ^ 1
    envelope.cipher.tag = tag.toString('base64')
    await expect(decryptJsonBackup(Buffer.from(JSON.stringify(envelope)), PASSWORD)).rejects.toMatchObject({
      code: 'BACKUP_AUTHENTICATION_FAILED'
    })
  })

  it('checks ciphertext corruption before deriving/decrypting', async () => {
    const envelope = JSON.parse((await encryptJsonBackup({ secret: true }, PASSWORD)).toString('utf8'))
    const ciphertext = Buffer.from(envelope.ciphertext, 'base64')
    ciphertext[0] = (ciphertext[0] ?? 0) ^ 1
    envelope.ciphertext = ciphertext.toString('base64')

    await expect(decryptJsonBackup(Buffer.from(JSON.stringify(envelope)), PASSWORD)).rejects.toMatchObject({
      code: 'BACKUP_INTEGRITY_FAILED'
    })
  })

  it('rejects unknown versions, extra fields and non-canonical base64', async () => {
    const envelope = JSON.parse((await encryptJsonBackup(null, PASSWORD)).toString('utf8'))

    await expect(decryptJsonBackup(
      Buffer.from(JSON.stringify({ ...envelope, version: 2 })), PASSWORD
    )).rejects.toMatchObject({ code: 'BACKUP_VERSION_UNSUPPORTED' })

    await expect(decryptJsonBackup(
      Buffer.from(JSON.stringify({ ...envelope, unexpected: true })), PASSWORD
    )).rejects.toMatchObject({ code: 'BACKUP_FORMAT_INVALID' })

    envelope.kdf.salt = `${envelope.kdf.salt}\n`
    await expect(decryptJsonBackup(
      Buffer.from(JSON.stringify(envelope)), PASSWORD
    )).rejects.toMatchObject({ code: 'BACKUP_FORMAT_INVALID' })
  })

  it('rejects values that JSON.stringify would silently change', async () => {
    await expect(encryptJsonBackup({ number: Number.NaN } as never, PASSWORD)).rejects.toBeInstanceOf(SafeBackupError)
    await expect(encryptJsonBackup({ date: new Date() } as never, PASSWORD)).rejects.toMatchObject({
      code: 'BACKUP_PAYLOAD_INVALID'
    })
    await expect(encryptJsonBackup({ missing: undefined } as never, PASSWORD)).rejects.toMatchObject({
      code: 'BACKUP_PAYLOAD_INVALID'
    })
    const accessor = Object.defineProperty({}, 'secret', { enumerable: true, get: () => 'value' })
    await expect(encryptJsonBackup(accessor as never, PASSWORD)).rejects.toMatchObject({
      code: 'BACKUP_PAYLOAD_INVALID'
    })
    await expect(encryptJsonBackup({ [Symbol('hidden')]: true } as never, PASSWORD)).rejects.toMatchObject({
      code: 'BACKUP_PAYLOAD_INVALID'
    })
  })

  it('enforces password byte-length limits without including passwords in errors', async () => {
    const short = '1234567'
    const long = 'x'.repeat(1_025)
    const shortError = await encryptJsonBackup({}, short).catch((error: unknown) => error)
    const longError = await encryptJsonBackup({}, long).catch((error: unknown) => error)

    expect(shortError).toMatchObject({ code: 'BACKUP_PASSWORD_TOO_SHORT' })
    expect(longError).toMatchObject({ code: 'BACKUP_PASSWORD_TOO_LONG' })
    expect(String(shortError)).not.toContain(short)
    expect(String(longError)).not.toContain(long)
  })
})
