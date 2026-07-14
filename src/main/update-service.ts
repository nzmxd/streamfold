import type {
  UpdateProgress,
  UpdateState,
  UpdateUnsupportedReason
} from '../shared/contracts'

export interface UpdateDescriptor {
  version: string
  releaseDate?: string
}

export interface UpdateDownloadProgress {
  percent: number
  transferred: number
  total: number
  bytesPerSecond: number
}

export interface UpdateClientHandlers {
  checking(): void
  available(info: UpdateDescriptor): void
  notAvailable(info: UpdateDescriptor): void
  progress(info: UpdateDownloadProgress): void
  downloaded(info: UpdateDescriptor): void
  error(error: Error): void
}

export interface UpdateClient {
  subscribe(handlers: UpdateClientHandlers): () => void
  check(): Promise<void>
  download(): Promise<void>
  restartAndInstall(): void
}

export interface UpdateServiceOptions {
  currentVersion: string
  automaticChecks: boolean
  unsupportedReason: UpdateUnsupportedReason | null
  client: UpdateClient | null
  now?: () => Date
  initialCheckDelayMs?: number
  checkIntervalMs?: number
}

const DEFAULT_INITIAL_CHECK_DELAY_MS = 15_000
const DEFAULT_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1_000

export class UpdateService {
  private state: UpdateState
  private readonly listeners = new Set<(state: UpdateState) => void>()
  private readonly now: () => Date
  private readonly initialCheckDelayMs: number
  private readonly checkIntervalMs: number
  private removeClientListeners: (() => void) | null = null
  private scheduledCheck: ReturnType<typeof setTimeout> | null = null
  private checkOperation: Promise<UpdateState> | null = null
  private downloadOperation: Promise<UpdateState> | null = null
  private started = false
  private destroyed = false

  constructor(private readonly options: UpdateServiceOptions) {
    this.now = options.now ?? (() => new Date())
    this.initialCheckDelayMs = options.initialCheckDelayMs ?? DEFAULT_INITIAL_CHECK_DELAY_MS
    this.checkIntervalMs = options.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS
    this.state = {
      phase: options.unsupportedReason ? 'unsupported' : 'idle',
      currentVersion: normalizeVersion(options.currentVersion) ?? '0.0.0',
      availableVersion: null,
      releaseDate: null,
      lastCheckedAt: null,
      progress: null,
      error: '',
      automaticChecks: options.automaticChecks,
      unsupportedReason: options.unsupportedReason
    }
  }

  start(): void {
    if (this.started || this.destroyed) return
    this.started = true
    if (this.options.client && !this.state.unsupportedReason) {
      this.removeClientListeners = this.options.client.subscribe({
        checking: () => this.onChecking(),
        available: (info) => this.onAvailable(info),
        notAvailable: (info) => this.onNotAvailable(info),
        progress: (info) => this.onProgress(info),
        downloaded: (info) => this.onDownloaded(info),
        error: (error) => this.onError(error)
      })
      if (this.state.automaticChecks) this.scheduleCheck(this.initialCheckDelayMs)
    }
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.clearScheduledCheck()
    this.removeClientListeners?.()
    this.removeClientListeners = null
    this.listeners.clear()
  }

  getState(): UpdateState {
    return cloneState(this.state)
  }

  subscribe(listener: (state: UpdateState) => void): () => void {
    if (this.destroyed) return () => undefined
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  setAutomaticChecks(enabled: boolean): UpdateState {
    if (this.destroyed || this.state.automaticChecks === enabled) return this.getState()
    this.patch({ automaticChecks: enabled })
    this.clearScheduledCheck()
    if (enabled && this.started && !this.state.unsupportedReason) {
      this.scheduleCheck(this.initialCheckDelayMs)
    }
    return this.getState()
  }

  check(): Promise<UpdateState> {
    if (this.destroyed) return Promise.reject(new Error('更新服务已停止'))
    if (!this.options.client || this.state.unsupportedReason) return Promise.resolve(this.getState())
    if (this.state.phase === 'downloading' || this.state.phase === 'downloaded') {
      return Promise.resolve(this.getState())
    }
    if (this.checkOperation) return this.checkOperation

    this.clearScheduledCheck()
    this.patch({
      phase: 'checking',
      availableVersion: null,
      releaseDate: null,
      progress: null,
      error: ''
    })
    this.checkOperation = this.options.client.check()
      .then(() => {
        if (this.state.phase === 'checking') {
          this.setError(new Error('更新服务器没有返回有效结果'))
        }
        return this.getState()
      })
      .catch((error: unknown) => {
        this.setError(asError(error))
        return this.getState()
      })
      .finally(() => {
        this.checkOperation = null
        if (this.state.automaticChecks) this.scheduleCheck(this.checkIntervalMs)
      })
    return this.checkOperation
  }

  download(): Promise<UpdateState> {
    if (this.destroyed) return Promise.reject(new Error('更新服务已停止'))
    if (!this.options.client || this.state.unsupportedReason) return Promise.resolve(this.getState())
    if (this.state.phase === 'downloaded' || this.state.phase === 'downloading') {
      return this.downloadOperation ?? Promise.resolve(this.getState())
    }
    if (!this.state.availableVersion) return Promise.reject(new Error('当前没有可下载的更新'))
    if (this.downloadOperation) return this.downloadOperation

    this.patch({ phase: 'downloading', progress: emptyProgress(), error: '' })
    this.downloadOperation = this.options.client.download()
      .then(() => this.getState())
      .catch((error: unknown) => {
        this.setError(asError(error), true)
        return this.getState()
      })
      .finally(() => {
        this.downloadOperation = null
      })
    return this.downloadOperation
  }

  restartAndInstall(): void {
    if (this.destroyed) throw new Error('更新服务已停止')
    if (!this.options.client || this.state.phase !== 'downloaded') {
      throw new Error('更新尚未下载完成')
    }
    this.options.client.restartAndInstall()
  }

  private onChecking(): void {
    if (this.destroyed || this.state.phase === 'downloaded') return
    this.patch({ phase: 'checking', progress: null, error: '' })
  }

  private onAvailable(info: UpdateDescriptor): void {
    if (this.destroyed) return
    const version = normalizeVersion(info.version)
    if (!version) {
      this.setError(new Error('更新版本信息无效'))
      return
    }
    this.patch({
      phase: 'available',
      availableVersion: version,
      releaseDate: normalizeDate(info.releaseDate),
      lastCheckedAt: this.now().toISOString(),
      progress: null,
      error: ''
    })
    // Downloads use the update manifest generated by electron-builder. Installation
    // remains an explicit user action after the package has been verified.
    void this.download()
  }

  private onNotAvailable(_info: UpdateDescriptor): void {
    if (this.destroyed || this.state.phase === 'downloaded') return
    this.patch({
      phase: 'up-to-date',
      availableVersion: null,
      releaseDate: null,
      lastCheckedAt: this.now().toISOString(),
      progress: null,
      error: ''
    })
  }

  private onProgress(info: UpdateDownloadProgress): void {
    if (this.destroyed || !this.state.availableVersion) return
    this.patch({ phase: 'downloading', progress: normalizeProgress(info), error: '' })
  }

  private onDownloaded(info: UpdateDescriptor): void {
    if (this.destroyed) return
    const version = normalizeVersion(info.version) ?? this.state.availableVersion
    if (!version) {
      this.setError(new Error('更新版本信息无效'))
      return
    }
    this.patch({
      phase: 'downloaded',
      availableVersion: version,
      releaseDate: normalizeDate(info.releaseDate) ?? this.state.releaseDate,
      progress: this.state.progress && this.state.progress.total > 0
        ? { ...this.state.progress, percent: 100, transferred: this.state.progress.total }
        : null,
      error: ''
    })
  }

  private onError(error: Error): void {
    if (this.destroyed) return
    this.setError(error, Boolean(this.state.availableVersion))
  }

  private setError(error: Error, preserveAvailableVersion = false): void {
    this.patch({
      phase: 'error',
      availableVersion: preserveAvailableVersion ? this.state.availableVersion : null,
      releaseDate: preserveAvailableVersion ? this.state.releaseDate : null,
      lastCheckedAt: this.now().toISOString(),
      progress: null,
      error: updateErrorMessage(error)
    })
  }

  private patch(value: Partial<UpdateState>): void {
    this.state = { ...this.state, ...value }
    const snapshot = this.getState()
    for (const listener of this.listeners) listener(snapshot)
  }

  private scheduleCheck(delay: number): void {
    if (
      this.destroyed || !this.started || !this.state.automaticChecks ||
      !this.options.client || this.state.unsupportedReason || this.scheduledCheck
    ) return
    this.scheduledCheck = setTimeout(() => {
      this.scheduledCheck = null
      void this.check()
    }, Math.max(0, delay))
    this.scheduledCheck.unref?.()
  }

  private clearScheduledCheck(): void {
    if (!this.scheduledCheck) return
    clearTimeout(this.scheduledCheck)
    this.scheduledCheck = null
  }
}

function cloneState(state: UpdateState): UpdateState {
  return { ...state, progress: state.progress ? { ...state.progress } : null }
}

function normalizeVersion(value: string): string | null {
  const trimmed = value.trim()
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(trimmed)
    ? trimmed
    : null
}

function normalizeDate(value: string | undefined): string | null {
  if (!value) return null
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null
}

function emptyProgress(): UpdateProgress {
  return { percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 }
}

function normalizeProgress(value: UpdateDownloadProgress): UpdateProgress {
  const total = safePositiveNumber(value.total)
  const transferred = Math.min(safePositiveNumber(value.transferred), total || Number.MAX_SAFE_INTEGER)
  const calculatedPercent = total > 0 ? transferred / total * 100 : 0
  return {
    percent: clamp(Number.isFinite(value.percent) ? value.percent : calculatedPercent, 0, 100),
    transferred,
    total,
    bytesPerSecond: safePositiveNumber(value.bytesPerSecond)
  }
}

function safePositiveNumber(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 0
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

export function updateErrorMessage(error: Error): string {
  const message = error.message.toLowerCase()
  if (/sha512|checksum|signature|code sign|verify/.test(message)) {
    return '更新包校验未通过，已停止安装'
  }
  if (/appimage|package type|not supported/.test(message)) {
    return '当前安装方式不支持在线更新，请使用正式安装包'
  }
  if (/404|latest(?:-[a-z]+)?\.yml|no published versions|release/.test(message)) {
    return '更新服务暂不可用，请稍后重试'
  }
  if (/net::|network|timeout|timed out|econn|enotfound|dns|offline/.test(message)) {
    return '无法连接更新服务器，请检查网络后重试'
  }
  return '检查更新失败，请稍后重试'
}
