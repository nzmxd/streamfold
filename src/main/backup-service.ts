import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename } from 'node:path'
import type {
  OpenDialogOptions,
  OpenDialogReturnValue,
  SaveDialogOptions,
  SaveDialogReturnValue
} from 'electron'
import type {
  CreateEncryptedBackupInput,
  EncryptedBackupResult,
  RestoreEncryptedBackupInput
} from '../shared/contracts'
import { decryptJsonBackup, encryptJsonBackup, type JsonValue } from './backup'

const DATABASE_BACKUP_FORMAT = 'social-vault-sqlite-image'
const DATABASE_BACKUP_VERSION = 1
const MAX_DATABASE_BYTES = 48 * 1024 * 1024
const MAX_ENCRYPTED_BACKUP_BYTES = 96 * 1024 * 1024

interface BackupDialog {
  showSaveDialog(options: SaveDialogOptions): Promise<SaveDialogReturnValue>
  showOpenDialog(options: OpenDialogOptions): Promise<OpenDialogReturnValue>
}

interface BackupRepository {
  getSchemaVersion(): number
  createBackupImage(): Buffer
  restoreBackupImage(image: Uint8Array, afterReplace?: () => void): void
  setSetting(key: string, value: string): void
}

export interface BackupServiceOptions {
  dialog: BackupDialog
  repository: BackupRepository
  beforeRestore?: () => void | Promise<void>
  afterRestore?: () => void
  afterCommit?: () => void | Promise<void>
  clock?: () => Date
}

export class BackupService {
  private readonly clock: () => Date

  constructor(private readonly options: BackupServiceOptions) {
    this.clock = options.clock ?? (() => new Date())
  }

  async create(input: CreateEncryptedBackupInput): Promise<EncryptedBackupResult> {
    const result = await this.options.dialog.showSaveDialog({
      title: '创建归页加密备份',
      defaultPath: `streamfold-${this.now().slice(0, 10)}.svbackup`,
      filters: [{ name: '归页加密备份', extensions: ['svbackup'] }],
      properties: ['createDirectory', 'showOverwriteConfirmation']
    })
    if (result.canceled || !result.filePath) return cancelledResult()

    const image = this.options.repository.createBackupImage()
    let encrypted: Buffer | undefined
    try {
      if (image.length === 0 || image.length > MAX_DATABASE_BYTES) {
        throw new Error('本地数据库超过 48 MB 备份上限')
      }
      const payload: JsonValue = {
        format: DATABASE_BACKUP_FORMAT,
        version: DATABASE_BACKUP_VERSION,
        createdAt: this.now(),
        schemaVersion: this.options.repository.getSchemaVersion(),
        databaseSha256: digest(image).toString('hex'),
        databaseBase64: image.toString('base64')
      }
      encrypted = await encryptJsonBackup(payload, input.password)
      try {
        await writeAtomic(result.filePath, encrypted)
      } catch {
        throw new Error('加密备份写入失败，请检查目标目录权限')
      }
      this.options.repository.setSetting('last_backup_at', this.now())
      return {
        cancelled: false,
        fileName: basename(result.filePath),
        databaseBytes: image.length,
        warning: ''
      }
    } finally {
      image.fill(0)
      encrypted?.fill(0)
    }
  }

  async restore(input: RestoreEncryptedBackupInput): Promise<EncryptedBackupResult> {
    if (!input.confirmReplace) throw new Error('恢复前必须确认替换当前本地数据库')
    const result = await this.options.dialog.showOpenDialog({
      title: '选择归页加密备份',
      filters: [{ name: '归页加密备份', extensions: ['svbackup'] }],
      properties: ['openFile', 'dontAddToRecent']
    })
    const path = result.filePaths[0]
    if (result.canceled || !path) return cancelledResult()

    let encrypted: Buffer | undefined
    let image: Buffer | undefined
    try {
      let fileSize = 0
      try {
        const info = await stat(path)
        if (!info.isFile() || info.size <= 0 || info.size > MAX_ENCRYPTED_BACKUP_BYTES) {
          throw new Error('invalid backup size')
        }
        fileSize = info.size
        encrypted = await readFile(path)
        if (encrypted.length !== fileSize || encrypted.length > MAX_ENCRYPTED_BACKUP_BYTES) {
          throw new Error('backup changed while reading')
        }
      } catch {
        throw new Error('无法读取所选备份文件')
      }
      const payload = await decryptJsonBackup(encrypted, input.password)
      image = parseDatabasePayload(payload)
      await this.options.beforeRestore?.()
      this.options.repository.restoreBackupImage(image, () => {
        this.options.repository.setSetting('last_restore_at', this.now())
        this.options.afterRestore?.()
      })
      let warning = ''
      try {
        await this.options.afterCommit?.()
      } catch {
        warning = '数据库已恢复，但部分旧浏览器会话清理失败；请重启应用后逐个断开不再使用的账号。'
      }
      return {
        cancelled: false,
        fileName: basename(path),
        databaseBytes: image.length,
        warning
      }
    } finally {
      encrypted?.fill(0)
      image?.fill(0)
    }
  }

  private now(): string {
    const value = this.clock()
    if (!Number.isFinite(value.getTime())) throw new Error('备份时钟无效')
    return value.toISOString()
  }
}

function parseDatabasePayload(value: JsonValue): Buffer {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalidPayload()
  const record = value as Record<string, JsonValue>
  const keys = Object.keys(record).sort()
  const expected = [
    'createdAt', 'databaseBase64', 'databaseSha256', 'format', 'schemaVersion', 'version'
  ].sort()
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) invalidPayload()
  if (
    record.format !== DATABASE_BACKUP_FORMAT || record.version !== DATABASE_BACKUP_VERSION ||
    typeof record.createdAt !== 'string' || !isIsoDate(record.createdAt) ||
    typeof record.schemaVersion !== 'number' || !Number.isSafeInteger(record.schemaVersion) ||
    record.schemaVersion < 1 ||
    typeof record.databaseSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(record.databaseSha256) ||
    typeof record.databaseBase64 !== 'string' || !isCanonicalBase64(record.databaseBase64)
  ) invalidPayload()

  const image = Buffer.from(record.databaseBase64, 'base64')
  if (image.length === 0 || image.length > MAX_DATABASE_BYTES) {
    image.fill(0)
    return invalidPayload()
  }
  const actual = digest(image)
  const expectedDigest = Buffer.from(record.databaseSha256, 'hex')
  const matches = timingSafeEqual(actual, expectedDigest)
  actual.fill(0)
  expectedDigest.fill(0)
  if (!matches) {
    image.fill(0)
    return invalidPayload()
  }
  return image
}

function cancelledResult(): EncryptedBackupResult {
  return { cancelled: true, fileName: null, databaseBytes: 0, warning: '' }
}

function digest(value: Uint8Array): Buffer {
  return createHash('sha256').update(value).digest()
}

function isCanonicalBase64(value: string): boolean {
  return value.length > 0 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value) &&
    Buffer.from(value, 'base64').toString('base64') === value
}

function isIsoDate(value: string): boolean {
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value
}

function invalidPayload(): never {
  throw new Error('备份中的数据库载荷无效')
}

async function writeAtomic(path: string, value: Uint8Array): Promise<void> {
  const temporaryPath = `${path}.tmp-${randomUUID()}`
  const previousPath = `${path}.previous-${randomUUID()}`
  let movedExisting = false
  try {
    await writeFile(temporaryPath, value, { mode: 0o600, flag: 'wx' })
    try {
      await rename(path, previousPath)
      movedExisting = true
    } catch (error) {
      if (!isFileNotFound(error)) throw error
    }
    await rename(temporaryPath, path)
    if (movedExisting) await rm(previousPath, { force: true })
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined)
    if (movedExisting) {
      await rm(path, { force: true }).catch(() => undefined)
      await rename(previousPath, path).catch(() => undefined)
    }
    throw error
  }
}

function isFileNotFound(value: unknown): boolean {
  return Boolean(value && typeof value === 'object' && 'code' in value && value.code === 'ENOENT')
}
