import { createHash, randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import type { FileImportPreview, FileImportResult } from '../../shared/import-contracts'
import type { JobRecord } from '../../shared/job-contracts'
import {
  parseCsvImport,
  parseJsonImport
} from '../plugins/file-parser'
import {
  SafeImportError,
  toSafeImportError
} from '../plugins/errors'
import {
  GENERIC_FILE_IMPORT_PLUGIN_ID,
  PluginRegistry
} from '../plugins/registry'
import type {
  ImportCommitMetadata,
  ImportCommitStats,
  NormalizedImportPayload
} from '../plugins/types'
import type { JobService, MaybePromise } from './job-service'

export const MAX_IMPORT_FILE_BYTES = 10 * 1024 * 1024
export const PREVIEW_TTL_MS = 5 * 60 * 1_000
export const DEFAULT_MAX_CACHED_PREVIEWS = 12

export interface NativeOpenDialog {
  showOpenDialog(options: {
    title: string
    properties: Array<'openFile'>
    filters: Array<{ name: string; extensions: string[] }>
  }): Promise<{ canceled: boolean; filePaths: string[] }>
}

export interface ImportFileSystem {
  stat(path: string): Promise<{ size: number; isFile(): boolean }>
  readFile(path: string): Promise<Uint8Array>
}

export interface PluginRunRecord {
  jobId: string
  pluginId: string
  accountId: string
  status: 'succeeded' | 'failed'
  startedAt: string
  finishedAt: string
  fileName: string
  fileHash: string
  result: Record<string, unknown> | null
  errorCode: string
  errorMessage: string
}

/** Small persistence boundary implemented by SocialDatabase or an adapter around it. */
export interface ImportRepository {
  accountExists(accountId: string): MaybePromise<boolean>
  isPluginEnabled(pluginId: string): MaybePromise<boolean>
  commitImport(
    payload: NormalizedImportPayload,
    metadata: ImportCommitMetadata
  ): MaybePromise<ImportCommitStats>
  recordPluginRun(record: PluginRunRecord): MaybePromise<void>
}

export interface ImportServiceOptions {
  dialog: NativeOpenDialog
  repository: ImportRepository
  jobs: JobService
  fileSystem?: ImportFileSystem
  registry?: PluginRegistry
  clock?: () => Date
  createToken?: () => string
  maxCachedPreviews?: number
}

interface CachedPreview {
  token: string
  accountId: string
  pluginId: string
  fileName: string
  fileHash: string
  format: 'json' | 'csv'
  createdAtMs: number
  expiresAtMs: number
  payload: NormalizedImportPayload
}

const nodeFileSystem: ImportFileSystem = {
  async stat(path) {
    const result = await stat(path)
    return { size: result.size, isFile: () => result.isFile() }
  },
  readFile
}

export class ImportService {
  private readonly previews = new Map<string, CachedPreview>()
  private readonly inFlight = new Set<string>()
  private readonly consumedTokens = new Map<string, number>()
  private readonly fileSystem: ImportFileSystem
  private readonly registry: PluginRegistry
  private readonly clock: () => Date
  private readonly createToken: () => string
  private readonly maxCachedPreviews: number

  constructor(private readonly options: ImportServiceOptions) {
    this.fileSystem = options.fileSystem ?? nodeFileSystem
    this.registry = options.registry ?? new PluginRegistry()
    this.clock = options.clock ?? (() => new Date())
    this.createToken = options.createToken ?? randomUUID
    const maximum = options.maxCachedPreviews ?? DEFAULT_MAX_CACHED_PREVIEWS
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 64) {
      throw new Error('maxCachedPreviews must be an integer between 1 and 64')
    }
    this.maxCachedPreviews = maximum
  }

  /** The renderer supplies only an account id; the native main-process dialog chooses the file. */
  async preview(accountId: string): Promise<FileImportPreview | null> {
    assertAccountId(accountId)
    if (!(await this.options.repository.accountExists(accountId))) {
      throw new SafeImportError('ACCOUNT_NOT_FOUND', '账号不存在')
    }

    const selection = await this.options.dialog.showOpenDialog({
      title: '选择要导入的 JSON 或 CSV 文件',
      properties: ['openFile'],
      filters: [
        { name: '社媒数据文件', extensions: ['json', 'csv'] }
      ]
    })
    if (selection.canceled || selection.filePaths.length === 0) return null

    const selectedPath = selection.filePaths[0]
    if (!selectedPath) return null
    const extension = extname(selectedPath).toLowerCase()
    if (extension !== '.json' && extension !== '.csv') {
      throw new SafeImportError('UNSUPPORTED_IMPORT_FORMAT', '只支持 .json 和 .csv 文件')
    }

    const fileInfo = await this.safeStat(selectedPath)
    if (!fileInfo.isFile()) throw new SafeImportError('IMPORT_NOT_A_FILE', '选择的项目不是普通文件')
    if (!Number.isSafeInteger(fileInfo.size) || fileInfo.size < 0 || fileInfo.size > MAX_IMPORT_FILE_BYTES) {
      throw new SafeImportError('IMPORT_FILE_TOO_LARGE', '导入文件不能超过 10 MB')
    }

    const bytes = await this.safeReadFile(selectedPath)
    if (bytes.byteLength > MAX_IMPORT_FILE_BYTES) {
      throw new SafeImportError('IMPORT_FILE_TOO_LARGE', '导入文件不能超过 10 MB')
    }
    const source = decodeUtf8(bytes)
    const capturedAt = this.now().toISOString()
    const format = extension === '.json' ? 'json' : 'csv'
    const payload = format === 'json'
      ? parseJsonImport(source, { capturedAt })
      : parseCsvImport(source, { capturedAt })
    const token = this.createToken()
    assertToken(token)
    if (this.previews.has(token) || this.inFlight.has(token) || this.consumedTokens.has(token)) {
      throw new SafeImportError('PREVIEW_TOKEN_COLLISION', '无法生成安全的预览凭证，请重试')
    }
    const createdAtMs = this.now().getTime()
    const fileName = safeBaseName(selectedPath)
    const preview: CachedPreview = {
      token,
      accountId,
      pluginId: GENERIC_FILE_IMPORT_PLUGIN_ID,
      fileName,
      fileHash: createHash('sha256').update(bytes).digest('hex'),
      format,
      createdAtMs,
      expiresAtMs: createdAtMs + PREVIEW_TTL_MS,
      payload
    }
    this.cache(preview)
    return toPublicPreview(preview)
  }

  async commit(input: {
    token: string
    accountId: string
    confirmOwnership: boolean
  }): Promise<FileImportResult> {
    assertToken(input.token)
    assertAccountId(input.accountId)
    if (typeof input.confirmOwnership !== 'boolean') {
      throw new SafeImportError('INVALID_OWNERSHIP_CONFIRMATION', '所有权确认参数无效')
    }
    this.purgeConsumedTokens()
    if (this.inFlight.has(input.token) || this.consumedTokens.has(input.token)) {
      throw new SafeImportError('PREVIEW_TOKEN_USED', '预览凭证已使用，请重新选择文件')
    }
    const preview = this.previews.get(input.token)
    if (!preview) throw new SafeImportError('PREVIEW_NOT_FOUND', '预览不存在或已过期')
    if (preview.expiresAtMs <= this.now().getTime()) {
      this.previews.delete(input.token)
      throw new SafeImportError('PREVIEW_EXPIRED', '预览已过期，请重新选择文件')
    }
    if (preview.accountId !== input.accountId) {
      throw new SafeImportError('PREVIEW_ACCOUNT_MISMATCH', '预览凭证与账号不匹配')
    }
    if (!input.confirmOwnership) {
      throw new SafeImportError('OWNERSHIP_CONFIRMATION_REQUIRED', '必须确认导入的是本人账号数据')
    }
    this.registry.requireExecutable(preview.pluginId)

    this.inFlight.add(input.token)
    try {
      if (!(await this.options.repository.accountExists(input.accountId))) {
        throw new SafeImportError('ACCOUNT_NOT_FOUND', '账号不存在')
      }
      if (!(await this.options.repository.isPluginEnabled(preview.pluginId))) {
        throw new SafeImportError('PLUGIN_DISABLED', '请先启用通用文件导入插件')
      }

      this.previews.delete(input.token)
      this.rememberConsumed(input.token, preview.expiresAtMs)
      return await this.commitPreview(preview)
    } finally {
      this.inFlight.delete(input.token)
    }
  }

  private async commitPreview(preview: CachedPreview): Promise<FileImportResult> {
    const startedAt = this.now().toISOString()
    let job = await this.options.jobs.createValidating(preview.accountId, preview.pluginId)

    try {
      job = await this.options.jobs.transition(job, 'committing', {
        progress: 50,
        stage: '写入本地数据库'
      })
      const stats = await this.options.repository.commitImport(preview.payload, {
        accountId: preview.accountId,
        pluginId: preview.pluginId,
        jobId: job.id,
        fileName: preview.fileName,
        fileHash: preview.fileHash,
        confirmOwnership: true
      })
      assertCommitStats(stats)
      const result = statsToRecord(stats)
      const finishedAt = this.now().toISOString()
      let persistedJob: JobRecord
      try {
        persistedJob = await this.options.jobs.refresh(job.id)
      } catch {
        // A successful repository commit is authoritative. Avoid reporting failure merely because
        // the follow-up read/notification could not be completed.
        persistedJob = {
          ...job,
          status: 'succeeded',
          progress: 100,
          stage: '导入完成',
          result,
          errorCode: '',
          errorMessage: '',
          finishedAt
        }
      }
      job = persistedJob.status === 'succeeded'
        ? persistedJob
        : await this.options.jobs.transition(job, 'succeeded', {
            progress: 100,
            stage: '导入完成',
            result,
            finishedAt
          })
      try {
        await this.options.repository.recordPluginRun({
          jobId: job.id,
          pluginId: preview.pluginId,
          accountId: preview.accountId,
          status: 'succeeded',
          startedAt,
          finishedAt,
          fileName: preview.fileName,
          fileHash: preview.fileHash,
          result,
          errorCode: '',
          errorMessage: ''
        })
      } catch {
        // The content transaction and succeeded job are already durable. A secondary statistics
        // update must not turn a successful import into a misleading failure in the UI.
      }
      return { job, ...stats }
    } catch (error) {
      const safeError = toSafeImportError(error, 'IMPORT_COMMIT_FAILED', '导入写入失败，未保存不完整数据')
      const finishedAt = this.now().toISOString()
      job = await this.recordFailedJob(job, safeError, finishedAt)
      await this.recordFailedRun(preview, job, safeError, startedAt, finishedAt)
      throw safeError
    }
  }

  private async recordFailedJob(job: JobRecord, error: SafeImportError, finishedAt: string): Promise<JobRecord> {
    if (job.status !== 'validating' && job.status !== 'committing') return job
    try {
      return await this.options.jobs.transition(job, 'failed', {
        progress: job.progress,
        stage: '导入失败',
        errorCode: error.code,
        errorMessage: error.message,
        finishedAt
      })
    } catch {
      return job
    }
  }

  private async recordFailedRun(
    preview: CachedPreview,
    job: JobRecord,
    error: SafeImportError,
    startedAt: string,
    finishedAt: string
  ): Promise<void> {
    try {
      await this.options.repository.recordPluginRun({
        jobId: job.id,
        pluginId: preview.pluginId,
        accountId: preview.accountId,
        status: 'failed',
        startedAt,
        finishedAt,
        fileName: preview.fileName,
        fileHash: preview.fileHash,
        result: null,
        errorCode: error.code,
        errorMessage: error.message
      })
    } catch {
      // Preserve and rethrow the original safe import error.
    }
  }

  private async safeStat(path: string): Promise<{ size: number; isFile(): boolean }> {
    try {
      return await this.fileSystem.stat(path)
    } catch (error) {
      throw new SafeImportError('IMPORT_FILE_UNREADABLE', '无法读取所选文件', { cause: error })
    }
  }

  private async safeReadFile(path: string): Promise<Uint8Array> {
    try {
      return await this.fileSystem.readFile(path)
    } catch (error) {
      throw new SafeImportError('IMPORT_FILE_UNREADABLE', '无法读取所选文件', { cause: error })
    }
  }

  private cache(preview: CachedPreview): void {
    this.purgeExpired()
    while (this.previews.size >= this.maxCachedPreviews) {
      const oldestToken = this.previews.keys().next().value as string | undefined
      if (!oldestToken) break
      this.previews.delete(oldestToken)
    }
    this.previews.set(preview.token, preview)
  }

  private purgeExpired(): void {
    const now = this.now().getTime()
    for (const [token, preview] of this.previews) {
      if (preview.expiresAtMs <= now) this.previews.delete(token)
    }
    this.purgeConsumedTokens(now)
  }

  private purgeConsumedTokens(now = this.now().getTime()): void {
    for (const [token, expiry] of this.consumedTokens) {
      if (expiry <= now) this.consumedTokens.delete(token)
    }
  }

  private rememberConsumed(token: string, expiresAtMs: number): void {
    while (this.consumedTokens.size >= this.maxCachedPreviews * 2) {
      const oldestToken = this.consumedTokens.keys().next().value as string | undefined
      if (!oldestToken) break
      this.consumedTokens.delete(oldestToken)
    }
    this.consumedTokens.set(token, expiresAtMs)
  }

  private now(): Date {
    const value = this.clock()
    if (!Number.isFinite(value.getTime())) throw new Error('ImportService clock returned an invalid date')
    return value
  }
}

/** Alias documenting that this service coordinates preview and commit jobs. */
export { ImportService as ImportCoordinator }

function toPublicPreview(preview: CachedPreview): FileImportPreview {
  const sample = preview.payload.contents.slice(0, 10).map((content) => ({
    remoteId: content.remoteId,
    type: content.type,
    title: content.title,
    publishedAt: content.publishedAt,
    latestSnapshot: content.snapshots.at(-1) ?? null
  }))
  return {
    token: preview.token,
    accountId: preview.accountId,
    fileName: preview.fileName,
    format: preview.format,
    fileHash: preview.fileHash,
    expiresAt: new Date(preview.expiresAtMs).toISOString(),
    identity: preview.payload.profile ? { ...preview.payload.profile } : null,
    contentCount: preview.payload.contents.length,
    snapshotCount: preview.payload.contents.reduce((count, content) => count + content.snapshots.length, 0),
    warnings: [...preview.payload.warnings],
    sample
  }
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (error) {
    throw new SafeImportError('INVALID_UTF8', '导入文件必须使用 UTF-8 编码', { cause: error })
  }
}

function safeBaseName(path: string): string {
  const fileName = basename(path)
  if (
    fileName.length === 0 ||
    fileName.length > 255 ||
    /[\u0000-\u001f\u007f]/.test(fileName)
  ) {
    throw new SafeImportError('INVALID_FILE_NAME', '导入文件名无效')
  }
  return fileName
}

function assertAccountId(accountId: unknown): asserts accountId is string {
  if (
    typeof accountId !== 'string' ||
    accountId.length === 0 ||
    accountId.length > 128 ||
    accountId.trim() !== accountId ||
    /[\u0000-\u001f\u007f]/.test(accountId)
  ) {
    throw new SafeImportError('INVALID_ACCOUNT_ID', '账号 ID 无效')
  }
}

function assertToken(token: unknown): asserts token is string {
  if (
    typeof token !== 'string' ||
    token.length < 8 ||
    token.length > 128 ||
    !/^[a-zA-Z0-9-]+$/.test(token)
  ) {
    throw new SafeImportError('INVALID_PREVIEW_TOKEN', '预览凭证无效')
  }
}

function assertCommitStats(stats: ImportCommitStats): void {
  for (const value of Object.values(stats)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new SafeImportError('INVALID_COMMIT_RESULT', '数据库返回了无效的导入统计')
    }
  }
}

function statsToRecord(stats: ImportCommitStats): Record<string, unknown> {
  return {
    newContentCount: stats.newContentCount,
    updatedContentCount: stats.updatedContentCount,
    snapshotCount: stats.snapshotCount,
    skippedSnapshotCount: stats.skippedSnapshotCount
  }
}
