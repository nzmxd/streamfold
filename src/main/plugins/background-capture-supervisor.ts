import { createHash, randomUUID } from 'node:crypto'
import type { WebContents } from 'electron'
import {
  isSensitiveBackgroundFieldName,
  type PlatformBackgroundResponseCorrelationDeclaration,
  type PlatformCaptureDeclaration
} from '../../shared/plugin-host-contracts'
import {
  hasPluginApiError,
  normalizePluginNetworkError,
  pluginNetworkResponseError
} from './network-diagnostics'
import { sanitizeSandboxDiagnostic } from './sandbox-diagnostics'

const MAX_REGISTRATIONS = 8
const MAX_TRACKED_REQUESTS = 128
const MAX_PENDING_BODIES = 16
const MAX_BODY_READS = 2
const BODY_READ_TIMEOUT_MS = 5_000
const NETWORK_ENABLE_TIMEOUT_MS = 5_000
const DEFAULT_CACHE_TTL_MS = 2 * 60_000
const DEFAULT_RETRY_INITIAL_DELAY_MS = 1_000
const DEFAULT_RETRY_MAXIMUM_DELAY_MS = 60_000
const MAX_TIMEOUT_DELAY_MS = 2_147_483_647
const MAX_PROJECTED_NODES = 50_000
const MAX_PROJECTED_DEPTH = 64

type CaptureContents = Pick<
  WebContents,
  'debugger' | 'getURL' | 'isDestroyed' | 'loadURL'
>

interface CachedCapture {
  bytes: Buffer
  digest: string
  capturedAt: number
}

interface CaptureRegistration {
  key: string
  namespace: string
  declaration: PlatformCaptureDeclaration
  responseFieldPaths: string[]
  responseCorrelations: PlatformBackgroundResponseCorrelationDeclaration[]
  routeParameters: Readonly<Record<string, string>>
  expected: URL
  routeUrl: string
  limit: number
  armed: boolean
  cache: CachedCapture[]
  failure: Error | null
  retryKind: 'transport' | 'response' | null
}

interface TrackedRequest {
  keys: string[]
  method: string
}

interface PendingBody {
  keys: string[]
  status: number
  mimeType: string
  epoch: number
}

export type BackgroundCaptureHealthStatus =
  | 'idle'
  | 'starting'
  | 'listening'
  | 'retrying'
  | 'degraded'
  | 'stopped'

export interface BackgroundCaptureHealth {
  status: BackgroundCaptureHealthStatus
  retryAttempt: number
  nextRetryAt: string | null
  lastCaptureAt: string | null
  lastError: string
}

export interface BackgroundCaptureNotice {
  captureId: string | null
  reason: 'capture' | 'health'
  generation: string
  revision: number
  health: BackgroundCaptureHealth
  error: Error | null
}

export interface BackgroundCaptureSupervisorOptions {
  cacheTtlMs?: number
  retryInitialDelayMs?: number
  retryMaximumDelayMs?: number
}

/**
 * Long-lived, host-owned listener for manifest-declared platform captures.
 * Request metadata never leaves the host; cached JSON is bounded and credential-redacted.
 */
export class BackgroundCaptureSupervisor {
  readonly generation = randomUUID()
  private readonly registrations = new Map<string, CaptureRegistration>()
  private readonly requests = new Map<string, TrackedRequest>()
  private readonly pending = new Map<string, PendingBody>()
  private readonly bodyQueue: string[] = []
  private readonly retryKeys = new Set<string>()
  private startPromise: Promise<void> | null = null
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private cacheExpiryTimer: ReturnType<typeof setTimeout> | null = null
  private navigationTail = Promise.resolve()
  private attachedByUs = false
  private started = false
  private disposed = false
  private activeBodyReads = 0
  private attachmentEpoch = 0
  private revision = 0
  private retryAttempt = 0
  private healthState: BackgroundCaptureHealth = {
    status: 'idle',
    retryAttempt: 0,
    nextRetryAt: null,
    lastCaptureAt: null,
    lastError: ''
  }
  private readonly cacheTtlMs: number
  private readonly retryInitialDelayMs: number
  private readonly retryMaximumDelayMs: number

  constructor(
    private readonly contents: CaptureContents,
    private readonly onNotice: (notice: BackgroundCaptureNotice) => void,
    private readonly clock: () => number = Date.now,
    options: BackgroundCaptureSupervisorOptions = {}
  ) {
    this.cacheTtlMs = positiveMilliseconds(options.cacheTtlMs, DEFAULT_CACHE_TTL_MS)
    this.retryInitialDelayMs = positiveMilliseconds(
      options.retryInitialDelayMs,
      DEFAULT_RETRY_INITIAL_DELAY_MS
    )
    this.retryMaximumDelayMs = Math.max(
      this.retryInitialDelayMs,
      positiveMilliseconds(options.retryMaximumDelayMs, DEFAULT_RETRY_MAXIMUM_DELAY_MS)
    )
  }

  health(): BackgroundCaptureHealth {
    return { ...this.healthState }
  }

  read(
    namespace: string,
    declaration: PlatformCaptureDeclaration,
    responseFieldPaths: readonly string[],
    responseCorrelations: readonly PlatformBackgroundResponseCorrelationDeclaration[],
    routeParameters: Readonly<Record<string, string>>,
    expectedUrl: string,
    routeUrl: string,
    limit: number
  ): unknown[] {
    if (this.disposed || this.contents.isDestroyed()) throw new Error('账号浏览器工作区已关闭')
    this.purgeExpired()
    const requestedLimit = Math.max(1, Math.min(
      Number.isSafeInteger(limit) ? limit : 1,
      declaration.maximumResponses ?? 1
    ))
    const key = captureKey(
      namespace,
      declaration.id,
      responseFieldPaths,
      responseCorrelations,
      routeParameters,
      expectedUrl,
      routeUrl
    )
    let registration = this.registrations.get(key)
    if (!registration) {
      const supersededKeys: string[] = []
      for (const [existingKey, existing] of this.registrations) {
        if (existing.namespace !== namespace || existing.declaration.id !== declaration.id) continue
        clearRegistration(existing)
        this.registrations.delete(existingKey)
        supersededKeys.push(existingKey)
      }
      if (supersededKeys.length > 0) {
        this.clearRetries(supersededKeys)
        this.scheduleCacheExpiry()
      }
      this.evictRegistrationIfNeeded()
      registration = {
        key,
        namespace,
        declaration,
        responseFieldPaths: [...responseFieldPaths],
        responseCorrelations: responseCorrelations.map((correlation) => ({
          ...correlation,
          responseFieldPaths: [...correlation.responseFieldPaths]
        })),
        routeParameters: Object.freeze({ ...routeParameters }),
        expected: new URL(expectedUrl),
        routeUrl,
        limit: requestedLimit,
        armed: false,
        cache: [],
        failure: null,
        retryKind: null
      }
      this.registrations.set(key, registration)
    } else {
      registration.limit = Math.max(registration.limit, requestedLimit)
    }
    if (registration.failure) throw registration.failure
    this.arm(registration)
    return registration.cache
      .slice(-requestedLimit)
      .map((entry) => JSON.parse(entry.bytes.toString('utf8')))
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.attachmentEpoch += 1
    const browserDebugger = this.contents.debugger
    browserDebugger.removeListener('message', this.onMessage)
    browserDebugger.removeListener('detach', this.onDetach)
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = null
    if (this.cacheExpiryTimer) clearTimeout(this.cacheExpiryTimer)
    this.cacheExpiryTimer = null
    this.retryKeys.clear()
    this.requests.clear()
    this.pending.clear()
    this.bodyQueue.length = 0
    for (const registration of this.registrations.values()) clearRegistration(registration)
    this.registrations.clear()
    const attachedByUs = this.attachedByUs
    this.attachedByUs = false
    this.started = false
    if (attachedByUs) {
      void browserDebugger.sendCommand('Network.disable').catch(() => undefined)
      try { browserDebugger.detach() } catch {}
    }
    this.setHealth('stopped', { nextRetryAt: null, lastError: '' })
  }

  private arm(registration: CaptureRegistration): void {
    if (registration.armed) return
    registration.armed = true
    if (!this.started) this.setHealth('starting', { nextRetryAt: null })
    void this.ensureStarted().then(() => {
      if (this.disposed || this.contents.isDestroyed()) return
      const navigation = this.navigationTail.catch(() => undefined).then(async () => {
        if (this.disposed || this.contents.isDestroyed()) return
        await this.contents.loadURL(registration.routeUrl)
      })
      this.navigationTail = navigation
      void navigation.then(() => {
        if (!this.disposed) this.recordTransportRecovery([registration.key])
      }).catch((error) => {
        registration.armed = false
        this.recordFailure(
          [registration.key],
          normalizePluginNetworkError(error, '平台身份页加载失败')
        )
        this.scheduleRetry([registration.key])
      })
    }).catch((error) => {
      registration.armed = false
      this.recordFailure(
        [registration.key],
        normalizePluginNetworkError(error, '平台响应后台监听初始化失败')
      )
      this.scheduleRetry([registration.key])
    })
  }

  private async ensureStarted(): Promise<void> {
    if (this.started) return
    if (this.startPromise) return await this.startPromise
    const pending = this.start()
    this.startPromise = pending
    try {
      await pending
    } finally {
      if (this.startPromise === pending) this.startPromise = null
    }
  }

  private async start(): Promise<void> {
    if (this.disposed || this.contents.isDestroyed()) throw new Error('账号浏览器工作区已关闭')
    const browserDebugger = this.contents.debugger
    if (browserDebugger.isAttached()) throw new Error('账号浏览器调试通道正在使用')
    browserDebugger.attach('1.3')
    this.attachmentEpoch += 1
    this.attachedByUs = true
    browserDebugger.on('message', this.onMessage)
    browserDebugger.on('detach', this.onDetach)
    try {
      // Listener lifetime is tied to the workspace and is intentionally not wrapped
      // in the one-shot capture deadline used for fresh captures.
      await withTimeout(browserDebugger.sendCommand('Network.enable', {
        maxTotalBufferSize: 4 * 1024 * 1024,
        maxResourceBufferSize: 512 * 1024
      }), NETWORK_ENABLE_TIMEOUT_MS, '平台后台监听初始化超时', '平台后台监听初始化失败')
      if (this.disposed) return
      if (!this.attachedByUs || !browserDebugger.isAttached()) {
        throw new Error('账号浏览器调试通道在初始化期间断开')
      }
      this.started = true
      const awaitingRetry = this.retryKeys.size > 0
      if (!awaitingRetry) this.retryAttempt = 0
      this.setHealth(awaitingRetry ? 'retrying' : 'listening', {
        retryAttempt: awaitingRetry ? this.retryAttempt : 0,
        ...(awaitingRetry ? {} : { nextRetryAt: null, lastError: '' })
      })
    } catch (error) {
      browserDebugger.removeListener('message', this.onMessage)
      browserDebugger.removeListener('detach', this.onDetach)
      this.started = false
      if (this.attachedByUs) {
        this.attachedByUs = false
        try { browserDebugger.detach() } catch {}
      }
      throw normalizePluginNetworkError(error, '平台响应后台监听初始化失败')
    }
  }

  private readonly onDetach = (): void => {
    if (this.disposed || !this.attachedByUs) return
    this.attachmentEpoch += 1
    const browserDebugger = this.contents.debugger
    this.attachedByUs = false
    this.started = false
    browserDebugger.removeListener('message', this.onMessage)
    browserDebugger.removeListener('detach', this.onDetach)
    this.requests.clear()
    this.pending.clear()
    this.bodyQueue.length = 0
    const keys = [...this.registrations.keys()]
    for (const registration of this.registrations.values()) registration.armed = false
    this.recordFailure(
      keys,
      normalizePluginNetworkError(
        new Error('账号浏览器调试通道意外断开'),
        '平台响应后台监听意外断开'
      )
    )
    this.scheduleRetry(keys)
  }

  private readonly onMessage = (
    _event: Electron.Event,
    method: string,
    params: Record<string, unknown>
  ): void => {
    if (this.disposed) return
    if (method === 'Network.requestWillBeSent') {
      const requestId = typeof params.requestId === 'string' ? params.requestId : ''
      const request = objectRecord(params.request)
      const methodName = String(request.method ?? '').toUpperCase()
      if (!requestId || methodName !== 'GET' || this.requests.size >= MAX_TRACKED_REQUESTS) return
      const keys = this.matchingRegistrationKeys(String(request.url ?? ''))
      if (keys.length > 0) this.requests.set(requestId, { keys, method: methodName })
      return
    }
    if (method === 'Network.responseReceived') {
      const requestId = typeof params.requestId === 'string' ? params.requestId : ''
      const tracked = this.requests.get(requestId)
      if (!tracked || tracked.method !== 'GET') return
      const response = objectRecord(params.response)
      const keys = tracked.keys.filter((key) => {
        const registration = this.registrations.get(key)
        return Boolean(registration) &&
          registration!.declaration.resourceTypes.includes(String(params.type ?? '') as 'Fetch' | 'XHR') &&
          matchesCaptureUrl(String(response.url ?? ''), registration!)
      })
      if (keys.length === 0) return
      const status = Number(response.status)
      const mimeType = String(response.mimeType ?? '')
      if (this.pending.size >= MAX_PENDING_BODIES) {
        this.recordFailure(
          keys,
          normalizePluginNetworkError(new Error('后台响应正文队列已满'), '平台后台响应读取失败')
        )
        this.scheduleRetry(keys, 'response')
        return
      }
      this.pending.set(requestId, { keys, status, mimeType, epoch: this.attachmentEpoch })
      return
    }
    if (method === 'Network.loadingFinished') {
      const requestId = typeof params.requestId === 'string' ? params.requestId : ''
      if (requestId && this.pending.has(requestId)) {
        this.bodyQueue.push(requestId)
        this.drainBodies()
      }
      this.requests.delete(requestId)
      return
    }
    if (method === 'Network.loadingFailed') {
      const requestId = typeof params.requestId === 'string' ? params.requestId : ''
      const metadata = this.pending.get(requestId)
      this.pending.delete(requestId)
      this.requests.delete(requestId)
      if (metadata) {
        this.recordFailure(metadata.keys, pluginNetworkResponseError(
          '平台后台响应加载失败',
          { status: metadata.status, contentType: metadata.mimeType, body: '' }
        ))
        this.scheduleRetry(metadata.keys, 'response')
      }
    }
  }

  private matchingRegistrationKeys(url: string): string[] {
    const keys: string[] = []
    for (const registration of this.registrations.values()) {
      if (matchesCaptureUrl(url, registration)) keys.push(registration.key)
    }
    return keys
  }

  private drainBodies(): void {
    while (!this.disposed && this.activeBodyReads < MAX_BODY_READS && this.bodyQueue.length > 0) {
      const requestId = this.bodyQueue.shift()
      if (!requestId) return
      const metadata = this.pending.get(requestId)
      this.pending.delete(requestId)
      if (!metadata) continue
      this.activeBodyReads += 1
      void this.harvest(requestId, metadata).finally(() => {
        this.activeBodyReads -= 1
        this.drainBodies()
      })
    }
  }

  private async harvest(requestId: string, metadata: PendingBody): Promise<void> {
    let rawBytes: Buffer | null = null
    try {
      const body = objectRecord(await withTimeout(
        this.contents.debugger.sendCommand('Network.getResponseBody', { requestId }),
        BODY_READ_TIMEOUT_MS
      ))
      if (this.disposed || metadata.epoch !== this.attachmentEpoch) return
      const raw = typeof body.body === 'string' ? body.body : ''
      rawBytes = body.base64Encoded === true ? Buffer.from(raw, 'base64') : Buffer.from(raw, 'utf8')
      const acceptedKeys: string[] = []
      const changedKeys: string[] = []
      const failedKeys: string[] = []
      for (const key of metadata.keys) {
        const registration = this.registrations.get(key)
        if (!registration) continue
        const diagnosticInput = {
          status: metadata.status,
          contentType: metadata.mimeType,
          body: backgroundDiagnosticBody(rawBytes, registration.responseFieldPaths),
          responseBytes: rawBytes.byteLength
        }
        const reject = (message: string): void => {
          registration.failure = pluginNetworkResponseError(message, diagnosticInput)
          failedKeys.push(key)
        }
        if (rawBytes.byteLength > (registration.declaration.maximumResponseBytes ?? 512 * 1024)) {
          reject('平台后台响应超过清单限制')
          continue
        }
        if (metadata.status === 401 || metadata.status === 403) {
          reject('平台登录状态已失效，请重新登录')
          continue
        }
        if (metadata.status === 429) {
          reject('平台请求暂时受限，请稍后重试')
          continue
        }
        if (metadata.status < 200 || metadata.status >= 300) {
          reject('平台后台捕获端点返回异常状态')
          continue
        }
        if (!/\bjson\b/iu.test(metadata.mimeType)) {
          reject('平台后台捕获端点未返回 JSON')
          continue
        }
        let value: unknown
        try {
          value = JSON.parse(rawBytes.toString('utf8'))
        } catch {
          reject('平台后台捕获端点返回了无效 JSON')
          continue
        }
        if (hasPluginApiError(value)) {
          reject('平台后台捕获端点返回 API 错误')
          continue
        }
        if (!matchesBackgroundResponseCorrelations(
          value,
          registration.responseCorrelations,
          registration.routeParameters
        )) continue
        let projected: unknown
        try {
          projected = projectBackgroundCaptureValue(value, registration.responseFieldPaths)
        } catch {
          reject('平台后台响应未命中清单字段或字段类型不兼容')
          continue
        }
        const bytes = Buffer.from(JSON.stringify(projected), 'utf8')
        if (bytes.byteLength > (registration.declaration.maximumTotalBytes ?? 512 * 1024)) {
          bytes.fill(0)
          reject('平台后台响应缓存超过清单限制')
          continue
        }
        const digest = createHash('sha256').update(bytes).digest('hex')
        registration.failure = null
        acceptedKeys.push(key)
        const duplicateIndex = registration.cache.findIndex((entry) => entry.digest === digest)
        if (duplicateIndex >= 0) {
          const [duplicate] = registration.cache.splice(duplicateIndex, 1)
          if (!duplicate) throw new Error('平台后台响应缓存状态无效')
          duplicate.capturedAt = this.clock()
          registration.cache.push(duplicate)
          bytes.fill(0)
          continue
        }
        changedKeys.push(key)
        while (registration.cache.length >= registration.limit) {
          const removed = registration.cache.shift()
          removed?.bytes.fill(0)
        }
        while (
          registration.cache.length > 0 &&
          cachedBytes(registration) + bytes.byteLength >
            (registration.declaration.maximumTotalBytes ?? 512 * 1024)
        ) {
          const removed = registration.cache.shift()
          removed?.bytes.fill(0)
        }
        registration.cache.push({ bytes, digest, capturedAt: this.clock() })
      }
      if (acceptedKeys.length > 0) {
        this.scheduleCacheExpiry()
        this.clearRetries(acceptedKeys)
        const awaitingRetry = this.retryKeys.size > 0
        const outstandingFailure = [...this.registrations.values()]
          .map((registration) => registration.failure)
          .find((error): error is Error => Boolean(error))
        if (awaitingRetry) {
          this.setHealth('retrying', { lastCaptureAt: isoTime(this.clock()) })
        } else if (outstandingFailure) {
          this.setHealth('degraded', {
            lastCaptureAt: isoTime(this.clock()),
            lastError: safeHealthMessage(outstandingFailure.message),
            nextRetryAt: null
          }, true, outstandingFailure)
        } else {
          this.retryAttempt = 0
          this.setHealth('listening', {
            retryAttempt: 0,
            nextRetryAt: null,
            lastCaptureAt: isoTime(this.clock()),
            lastError: ''
          })
        }
        if (changedKeys.length > 0) this.emitCaptureNotice([...new Set(changedKeys)])
      }
      if (failedKeys.length > 0) {
        this.recordCurrentFailures(failedKeys)
        this.scheduleRetry(failedKeys, 'response')
      }
    } catch (error) {
      if (this.disposed || metadata.epoch !== this.attachmentEpoch) return
      this.recordFailure(
        metadata.keys,
        normalizePluginNetworkError(error, '平台后台响应正文读取失败')
      )
      this.scheduleRetry(metadata.keys, 'response')
    } finally {
      rawBytes?.fill(0)
    }
  }

  private emitCaptureNotice(keys: readonly string[]): void {
    const captureIds = new Set<string>()
    for (const key of keys) {
      const captureId = this.registrations.get(key)?.declaration.id
      if (captureId) captureIds.add(captureId)
    }
    for (const captureId of captureIds) {
      this.emitNotice({
        captureId,
        reason: 'capture',
        generation: this.generation,
        revision: ++this.revision,
        health: this.health(),
        error: null
      })
    }
  }

  private recordFailure(keys: readonly string[], error: Error): void {
    if (this.disposed) return
    const changed: string[] = []
    for (const key of keys) {
      const registration = this.registrations.get(key)
      if (!registration) continue
      registration.failure = error
      changed.push(key)
    }
    if (changed.length > 0) this.recordCurrentFailures(changed)
  }

  private recordCurrentFailures(keys: readonly string[]): void {
    const error = keys
      .map((key) => this.registrations.get(key)?.failure)
      .find((value): value is Error => Boolean(value))
    if (!error) return
    this.setHealth('degraded', {
      lastError: safeHealthMessage(error.message),
      nextRetryAt: null
    }, true, error)
  }

  private scheduleRetry(
    keys: readonly string[],
    kind: 'transport' | 'response' = 'transport'
  ): void {
    if (this.disposed) return
    for (const key of keys) {
      const registration = this.registrations.get(key)
      if (!registration) continue
      registration.armed = false
      if (registration.retryKind !== 'response') registration.retryKind = kind
      this.retryKeys.add(key)
    }
    if (this.restartTimer || this.retryKeys.size === 0) return
    this.retryAttempt += 1
    const delay = Math.min(
      this.retryMaximumDelayMs,
      this.retryInitialDelayMs * (2 ** Math.min(this.retryAttempt - 1, 20))
    )
    this.setHealth('retrying', {
      retryAttempt: this.retryAttempt,
      nextRetryAt: isoTime(this.clock() + delay)
    })
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      const pendingKeys = [...this.retryKeys]
      for (const key of pendingKeys) {
        const registration = this.registrations.get(key)
        if (!registration || this.disposed) continue
        registration.failure = null
        this.arm(registration)
      }
    }, delay)
    this.restartTimer.unref?.()
  }

  private clearRetries(keys: readonly string[]): void {
    for (const key of keys) {
      this.retryKeys.delete(key)
      const registration = this.registrations.get(key)
      if (registration) {
        registration.armed = true
        registration.retryKind = null
      }
    }
    if (this.retryKeys.size > 0 || !this.restartTimer) return
    clearTimeout(this.restartTimer)
    this.restartTimer = null
  }

  private recordTransportRecovery(keys: readonly string[]): void {
    const transportKeys: string[] = []
    const responseKeys: string[] = []
    for (const key of keys) {
      const registration = this.registrations.get(key)
      if (registration?.retryKind === 'response') responseKeys.push(key)
      else transportKeys.push(key)
    }
    this.clearRetries(transportKeys)
    if (responseKeys.length > 0) this.scheduleRetry(responseKeys, 'response')
    const outstandingFailure = [...this.registrations.values()]
      .map((registration) => registration.failure)
      .find((error): error is Error => Boolean(error))
    if (this.retryKeys.size > 0) return
    if (outstandingFailure) {
      this.setHealth('degraded', {
        lastError: safeHealthMessage(outstandingFailure.message),
        nextRetryAt: null
      }, true, outstandingFailure)
      return
    }
    this.retryAttempt = 0
    this.setHealth('listening', {
      retryAttempt: 0,
      nextRetryAt: null,
      lastError: ''
    })
  }

  private purgeExpired(): void {
    const now = this.clock()
    for (const registration of this.registrations.values()) {
      const hadCachedResponse = registration.cache.length > 0
      const fresh: CachedCapture[] = []
      for (const entry of registration.cache) {
        if (entry.capturedAt + this.cacheTtlMs > now) fresh.push(entry)
        else entry.bytes.fill(0)
      }
      registration.cache = fresh
      if (hadCachedResponse && fresh.length === 0) registration.armed = false
    }
    this.scheduleCacheExpiry()
  }

  private scheduleCacheExpiry(): void {
    if (this.cacheExpiryTimer) clearTimeout(this.cacheExpiryTimer)
    this.cacheExpiryTimer = null
    if (this.disposed) return

    let expiresAt = Number.POSITIVE_INFINITY
    for (const registration of this.registrations.values()) {
      for (const entry of registration.cache) {
        expiresAt = Math.min(expiresAt, entry.capturedAt + this.cacheTtlMs)
      }
    }
    if (!Number.isFinite(expiresAt)) return

    const delay = Math.max(1, Math.min(MAX_TIMEOUT_DELAY_MS, expiresAt - this.clock()))
    this.cacheExpiryTimer = setTimeout(() => {
      this.cacheExpiryTimer = null
      if (!this.disposed) this.purgeExpired()
    }, delay)
    this.cacheExpiryTimer.unref?.()
  }

  private evictRegistrationIfNeeded(): void {
    if (this.registrations.size < MAX_REGISTRATIONS) return
    const oldest = this.registrations.values().next().value as CaptureRegistration | undefined
    if (!oldest) return
    clearRegistration(oldest)
    this.registrations.delete(oldest.key)
    this.clearRetries([oldest.key])
    this.scheduleCacheExpiry()
  }

  private setHealth(
    status: BackgroundCaptureHealthStatus,
    patch: Partial<Omit<BackgroundCaptureHealth, 'status'>> = {},
    emit = true,
    error: Error | null = null
  ): void {
    const next = { ...this.healthState, ...patch, status }
    const changed = JSON.stringify(next) !== JSON.stringify(this.healthState)
    this.healthState = next
    if (!emit || (!changed && !error)) return
    this.emitNotice({
      captureId: null,
      reason: 'health',
      generation: this.generation,
      revision: ++this.revision,
      health: this.health(),
      error
    })
  }

  private emitNotice(notice: BackgroundCaptureNotice): void {
    try { this.onNotice(notice) } catch {}
  }
}

function captureKey(
  namespace: string,
  captureId: string,
  responseFieldPaths: readonly string[],
  responseCorrelations: readonly PlatformBackgroundResponseCorrelationDeclaration[],
  routeParameters: Readonly<Record<string, string>>,
  expectedUrl: string,
  routeUrl: string
): string {
  return createHash('sha256')
    .update(namespace)
    .update('\0')
    .update(captureId)
    .update('\0')
    .update([...responseFieldPaths].sort().join('\0'))
    .update('\0')
    .update(JSON.stringify(responseCorrelations))
    .update('\0')
    .update(JSON.stringify(Object.entries(routeParameters).sort(([left], [right]) => left.localeCompare(right))))
    .update('\0')
    .update(expectedUrl)
    .update('\0')
    .update(routeUrl)
    .digest('hex')
}

function matchesCaptureUrl(value: string, registration: CaptureRegistration): boolean {
  try {
    const url = new URL(value)
    const expected = registration.expected
    if (url.origin !== expected.origin || url.username || url.password) return false
    const operationName = registration.declaration.graphqlOperationName
    if (!operationName) return url.pathname === expected.pathname
    const prefix = `${expected.pathname}/`
    if (!url.pathname.startsWith(prefix)) return false
    const suffix = url.pathname.slice(prefix.length)
    const separator = suffix.indexOf('/')
    return separator > 0 && suffix.indexOf('/', separator + 1) === -1 &&
      /^[A-Za-z0-9_-]{1,128}$/.test(suffix.slice(0, separator)) &&
      suffix.slice(separator + 1) === operationName
  } catch {
    return false
  }
}

interface ProjectionNode {
  scalar: boolean
  children: Map<string, ProjectionNode>
}

function projectBackgroundCaptureValue(value: unknown, paths: readonly string[]): unknown {
  const root = projectionTree(paths)
  const projected = projectBackgroundNode(value, root, 0, { remaining: MAX_PROJECTED_NODES })
  if (projected === undefined || !hasProjectedScalar(projected, { remaining: MAX_PROJECTED_NODES })) {
    throw new Error('平台后台响应未命中清单字段')
  }
  return projected
}

function hasProjectedScalar(value: unknown, budget: { remaining: number }): boolean {
  if (budget.remaining <= 0) return false
  budget.remaining -= 1
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.some((item) => hasProjectedScalar(item, budget))
  if (!value || typeof value !== 'object') return false
  return Object.values(value as Record<string, unknown>)
    .some((item) => hasProjectedScalar(item, budget))
}

export function matchesBackgroundResponseCorrelations(
  value: unknown,
  correlations: readonly PlatformBackgroundResponseCorrelationDeclaration[],
  routeParameters: Readonly<Record<string, string>>
): boolean {
  return correlations.every((correlation) => {
    const expected = routeParameters[correlation.routeParameter]
    if (typeof expected !== 'string' || expected.length === 0) return false
    return correlation.responseFieldPaths.some((path) => (
      backgroundValuesAtPath(value, path).some((candidate) => {
        const actual = scalarText(candidate)
        if (actual === null) return false
        return correlation.comparison === 'case-insensitive'
          ? actual.toLowerCase() === expected.toLowerCase()
          : actual === expected
      })
    ))
  })
}

function backgroundValuesAtPath(value: unknown, path: string): unknown[] {
  const segments = path.slice(1).split('/').map((segment) => (
    segment.replace(/~1/gu, '/').replace(/~0/gu, '~')
  ))
  let values = [value]
  let budget = 4_096
  for (const segment of segments) {
    const next: unknown[] = []
    for (const current of values) {
      if (budget <= 0) break
      budget -= 1
      if (segment === '*') {
        if (Array.isArray(current)) next.push(...current.slice(0, Math.max(0, budget)))
      } else if (current && typeof current === 'object' && !Array.isArray(current) &&
        Object.prototype.hasOwnProperty.call(current, segment)) {
        next.push((current as Record<string, unknown>)[segment])
      }
    }
    values = next.slice(0, Math.max(0, budget))
    if (values.length === 0) break
  }
  return values
}

function scalarText(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'boolean') return String(value)
  return null
}

function backgroundDiagnosticBody(rawBytes: Buffer, paths: readonly string[]): string {
  let value: unknown
  try {
    value = JSON.parse(rawBytes.toString('utf8'))
  } catch (error) {
    const sample = rawBytes.subarray(0, 8 * 1024).toString('utf8').trim()
    const message = error instanceof Error ? error.message : ''
    const offsetMatch = /(?:position|at)\s+(\d+)/iu.exec(message)
    const html = /^(?:<!doctype\s+html|<html|<head|<body)\b/iu.test(sample)
    return JSON.stringify({
      diagnostic: rawBytes.byteLength === 0
        ? 'empty_response'
        : html
          ? 'html_response'
          : 'invalid_json',
      ...(offsetMatch ? { parseErrorOffset: Number(offsetMatch[1]) } : {}),
      ...(html ? {
        loginPageLikely: /(?:sign[ -]?in|log[ -]?in|登录)/iu.test(sample),
        challengePageLikely: /(?:captcha|challenge|cloudflare|verify|验证)/iu.test(sample)
      } : {})
    })
  }
  let response: unknown = {}
  try { response = projectBackgroundCaptureValue(value, paths) } catch {}
  const apiError = projectBackgroundApiError(value)
  return JSON.stringify({ response, ...(apiError === null ? {} : { apiError }) })
}

function projectBackgroundApiError(value: unknown): unknown {
  if (!hasPluginApiError(value) || !value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  for (const key of ['error_code', 'errorCode', 'errcode', 'errno', 'code', 'message', 'msg', 'detail', 'reason']) {
    const projected = backgroundErrorScalar(record[key])
    if (projected !== undefined) result[key] = projected
  }
  for (const key of ['error', 'errors']) {
    const projected = backgroundErrorValue(record[key], 0)
    if (projected !== undefined) result[key] = projected
  }
  return Object.keys(result).length > 0 ? result : null
}

function backgroundErrorValue(value: unknown, depth: number): unknown {
  const scalar = backgroundErrorScalar(value)
  if (scalar !== undefined) return scalar
  if (depth >= 2) return undefined
  if (Array.isArray(value)) {
    return value.slice(0, 8).flatMap((item) => {
      const projected = backgroundErrorValue(item, depth + 1)
      return projected === undefined ? [] : [projected]
    })
  }
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  for (const key of ['error_code', 'errorCode', 'errcode', 'errno', 'code', 'message', 'msg', 'detail', 'reason']) {
    const projected = backgroundErrorScalar(record[key])
    if (projected !== undefined) result[key] = projected
  }
  return Object.keys(result).length > 0 ? result : undefined
}

function backgroundErrorScalar(value: unknown): string | number | boolean | null | undefined {
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string') return sanitizeSandboxDiagnostic(value).slice(0, 2_000)
  return undefined
}

function projectionTree(paths: readonly string[]): ProjectionNode {
  const root: ProjectionNode = { scalar: false, children: new Map() }
  for (const path of paths) {
    const segments = path.slice(1).split('/').map((segment) => (
      segment.replace(/~1/gu, '/').replace(/~0/gu, '~')
    ))
    let node = root
    for (const segment of segments) {
      if (node.scalar) throw new Error('后台响应字段路径不能包含其他字段路径')
      if (isSensitiveBackgroundFieldName(segment)) throw new Error('后台响应投影包含敏感字段')
      let child = node.children.get(segment)
      if (!child) {
        child = { scalar: false, children: new Map() }
        node.children.set(segment, child)
      }
      node = child
    }
    if (segments.at(-1) === '*') throw new Error('后台响应字段路径不能以数组通配符结尾')
    if (node.children.size > 0) throw new Error('后台响应字段路径不能包含其他字段路径')
    node.scalar = true
  }
  return root
}

function projectBackgroundNode(
  value: unknown,
  node: ProjectionNode,
  depth: number,
  budget: { remaining: number }
): unknown {
  if (budget.remaining <= 0 || depth > MAX_PROJECTED_DEPTH) {
    throw new Error('平台后台响应结构超过安全上限')
  }
  budget.remaining -= 1
  if (node.scalar) {
    if (value === null || typeof value === 'boolean') return value
    if (typeof value === 'number') return Number.isFinite(value) ? value : null
    if (typeof value === 'string') return sanitizeSandboxDiagnostic(value)
    throw new Error('后台响应白名单字段必须是标量')
  }
  if (Array.isArray(value)) {
    const child = node.children.get('*')
    if (!child) return undefined
    return value.flatMap((item) => {
      const projected = projectBackgroundNode(item, child, depth + 1, budget)
      return projected === undefined ? [] : [projected]
    })
  }
  if (!value || typeof value !== 'object') return undefined
  if (node.children.has('*')) throw new Error('后台响应数组字段结构无效')
  const source = value as Record<string, unknown>
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  for (const [key, child] of node.children) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue
    const projected = projectBackgroundNode(source[key], child, depth + 1, budget)
    if (projected !== undefined) result[key] = projected
  }
  return Object.keys(result).length > 0 ? result : undefined
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function clearRegistration(registration: CaptureRegistration): void {
  for (const entry of registration.cache) entry.bytes.fill(0)
  registration.cache.length = 0
  registration.failure = null
  registration.retryKind = null
}

function cachedBytes(registration: CaptureRegistration): number {
  return registration.cache.reduce((total, entry) => total + entry.bytes.byteLength, 0)
}

function positiveMilliseconds(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && value !== undefined && value > 0 ? value : fallback
}

function isoTime(value: number): string | null {
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}

function safeHealthMessage(value: string): string {
  return sanitizeSandboxDiagnostic(value).replace(/\s+/gu, ' ').trim().slice(0, 240)
}

function withTimeout<T>(
  promise: Promise<T>,
  milliseconds: number,
  timeoutMessage = '平台响应正文读取超时',
  failureMessage = '平台响应正文读取失败'
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(timeoutMessage)), milliseconds)
    timer.unref?.()
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(failureMessage, { cause: error }))
      }
    )
  })
}

export const __backgroundCaptureSupervisorTest = Object.freeze({
  project: projectBackgroundCaptureValue,
  matches: matchesCaptureUrl
})
