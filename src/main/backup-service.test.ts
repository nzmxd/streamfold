import { mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BackupService } from './backup-service'

describe('BackupService', () => {
  let directory = ''

  afterEach(() => {
    if (directory) rmSync(directory, { recursive: true, force: true })
    directory = ''
  })

  it('creates and restores one encrypted database image through native file choices', async () => {
    directory = mkdtempSync(join(tmpdir(), 'social-vault-backup-service-'))
    const path = join(directory, 'vault.svbackup')
    const image = sqliteLikeImage()
    const settings = new Map<string, string>()
    let restored: Buffer | null = null
    let beforeRestore = false
    let afterRestore = false
    const service = new BackupService({
      dialog: {
        showSaveDialog: async () => ({ canceled: false, filePath: path }),
        showOpenDialog: async () => ({ canceled: false, filePaths: [path] })
      },
      repository: {
        getSchemaVersion: () => 3,
        createBackupImage: () => Buffer.from(image),
        restoreBackupImage: (value, afterReplace) => {
          restored = Buffer.from(value)
          afterReplace?.()
        },
        setSetting: (key, value) => { settings.set(key, value) }
      },
      beforeRestore: () => { beforeRestore = true },
      afterRestore: () => { afterRestore = true },
      clock: () => new Date('2026-07-13T08:00:00.000Z')
    })

    await expect(service.create({ password: 'correct horse battery staple' })).resolves.toEqual({
      cancelled: false,
      fileName: 'vault.svbackup',
      databaseBytes: image.length,
      warning: ''
    })
    await expect(service.restore({
      password: 'correct horse battery staple',
      confirmReplace: true
    })).resolves.toEqual({
      cancelled: false,
      fileName: 'vault.svbackup',
      databaseBytes: image.length,
      warning: ''
    })
    expect(restored).toEqual(image)
    expect(beforeRestore).toBe(true)
    expect(afterRestore).toBe(true)
    expect(settings).toEqual(new Map([
      ['last_backup_at', '2026-07-13T08:00:00.000Z'],
      ['last_restore_at', '2026-07-13T08:00:00.000Z']
    ]))
  })

  it('does not replace the database on a wrong password or missing confirmation', async () => {
    directory = mkdtempSync(join(tmpdir(), 'social-vault-backup-service-'))
    const path = join(directory, 'vault.svbackup')
    let restoreCount = 0
    const repository = {
      getSchemaVersion: () => 3,
      createBackupImage: () => sqliteLikeImage(),
      restoreBackupImage: (_value: Uint8Array, afterReplace?: () => void) => {
        restoreCount += 1
        afterReplace?.()
      },
      setSetting: () => undefined
    }
    const service = new BackupService({
      dialog: {
        showSaveDialog: async () => ({ canceled: false, filePath: path }),
        showOpenDialog: async () => ({ canceled: false, filePaths: [path] })
      },
      repository
    })
    await service.create({ password: 'correct horse battery staple' })
    await expect(service.restore({ password: 'wrong password value', confirmReplace: true }))
      .rejects.toThrow('密码错误或文件已被篡改')
    await expect(service.restore({ password: 'correct horse battery staple', confirmReplace: false }))
      .rejects.toThrow('必须确认替换')
    expect(restoreCount).toBe(0)
  })

  it('returns a neutral result when a native dialog is cancelled', async () => {
    const service = new BackupService({
      dialog: {
        showSaveDialog: async () => ({ canceled: true, filePath: '' }),
        showOpenDialog: async () => ({ canceled: true, filePaths: [] })
      },
      repository: {
        getSchemaVersion: () => 3,
        createBackupImage: () => { throw new Error('should not run') },
        restoreBackupImage: () => { throw new Error('should not run') },
        setSetting: () => undefined
      }
    })
    await expect(service.create({ password: 'correct horse battery staple' })).resolves.toEqual({
      cancelled: true, fileName: null, databaseBytes: 0, warning: ''
    })
    await expect(service.restore({
      password: 'correct horse battery staple', confirmReplace: true
    })).resolves.toEqual({ cancelled: true, fileName: null, databaseBytes: 0, warning: '' })
  })

  it('rejects an oversized sparse file before reading or replacing the database', async () => {
    directory = mkdtempSync(join(tmpdir(), 'social-vault-backup-service-'))
    const path = join(directory, 'oversized.svbackup')
    writeFileSync(path, '')
    truncateSync(path, 512 * 1024 * 1024 + 1)
    let restored = false
    const service = new BackupService({
      dialog: {
        showSaveDialog: async () => ({ canceled: true, filePath: '' }),
        showOpenDialog: async () => ({ canceled: false, filePaths: [path] })
      },
      repository: {
        getSchemaVersion: () => 3,
        createBackupImage: () => sqliteLikeImage(),
        restoreBackupImage: () => { restored = true },
        setSetting: () => undefined
      }
    })
    await expect(service.restore({
      password: 'correct horse battery staple', confirmReplace: true
    })).rejects.toThrow('无法读取所选备份文件')
    expect(restored).toBe(false)
  })
})

function sqliteLikeImage(): Buffer {
  const value = Buffer.alloc(256, 0)
  value.write('SQLite format 3\0', 0, 'utf8')
  value.write('test-image', 32, 'utf8')
  return value
}
