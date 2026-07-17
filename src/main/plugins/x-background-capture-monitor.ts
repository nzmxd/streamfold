import { createHash, randomUUID } from 'node:crypto'
import type { WebContents } from 'electron'
import type { PlatformCaptureDeclaration } from '../../shared/plugin-host-contracts'
import {
  hasPluginApiError,
  normalizePluginNetworkError,
  pluginNetworkResponseError
} from './network-diagnostics'

const CACHE_TTL_MS = 2 * 60_000
const MAX_REGISTRATIONS = 8
const MAX_TRACKED_REQUESTS = 128
const MAX_PENDING_BODIES = 16
const MAX_BODY_READS = 2
const BODY_READ_TIMEOUT_MS = 5_000
const RESTART_DELAY_MS = 1_000

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
  declaration: PlatformCaptureDeclaration
  expected: URL
  routeUrl: string
  limit: number
  armed: boolean
  cache: CachedCapture[]
  failure: Error | null
}

interface TrackedRequest {
  keys: string[]
  method: string
}

interface PendingBody {
  keys: string[]
  status: number
  mimeType: string
}

export interface XBackgroundCaptureNotice {
  captureId: string
  generation: string
  revision: number
}

/**
 * Long-lived, host-owned discovery listener for the two official X identity captures.
 * It never exposes request metadata and stores only a narrow host projection in memory.
 */
export class XBackgroundCaptureMonitor {
  readonly generation = randomUUID()
  private readonly registrations = new Map<string, CaptureRegistration>()
  private readonly requests = new Map<string, TrackedRequest>()
  private readonly pending = new Map<string, PendingBody>()
  private readonly bodyQueue: string[] = []
  private readonly retryKeys = new Set<string>()
  private startPromise: Promise<void> | null = null
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private navigationTail = Promise.resolve()
  private attachedByUs = false
  private started = false
  private disposed = false
  private activeBodyReads = 0
  private revision = 0

  constructor(
    private readonly contents: CaptureContents,
    private readonly onCapture: (notice: XBackgroundCaptureNotice) => void,
    private readonly clock: () => number = Date.now
  ) {}

  read(
    namespace: string,
    declaration: PlatformCaptureDeclaration,
    expectedUrl: string,
    routeUrl: string,
    limit: number
  ): unknown[] {
    if (this.disposed || this.contents.isDestroyed()) throw new Error('账号浏览器工作区已关闭')
    if (!isSupportedXIdentityCapture(declaration.id)) {
      throw new Error('后台监听仅允许官方 X 身份捕获规则')
    }
    this.purgeExpired()
    const key = captureKey(namespace, declaration.id, expectedUrl, routeUrl)
    let registration = this.registrations.get(key)
    if (!registration) {
      this.evictRegistrationIfNeeded()
      registration = {
        key,
        declaration,
        expected: new URL(expectedUrl),
        routeUrl,
        limit: Math.min(limit, declaration.maximumResponses ?? 1),
        armed: false,
        cache: [],
        failure: null
      }
      this.registrations.set(key, registration)
    }
    if (registration.failure) throw registration.failure
    this.arm(registration)
    return registration.cache.map((entry) => JSON.parse(entry.bytes.toString('utf8')))
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    const browserDebugger = this.contents.debugger
    browserDebugger.removeListener('message', this.onMessage)
    browserDebugger.removeListener('detach', this.onDetach)
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = null
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
  }

  private arm(registration: CaptureRegistration): void {
    if (registration.armed) return
    registration.armed = true
    void this.ensureStarted().then(() => {
      if (this.disposed || this.contents.isDestroyed()) return
      this.navigationTail = this.navigationTail.catch(() => undefined).then(async () => {
        if (this.disposed || this.contents.isDestroyed()) return
        await this.contents.loadURL(registration.routeUrl)
      })
      void this.navigationTail.catch((error) => {
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
    this.attachedByUs = true
    browserDebugger.on('message', this.onMessage)
    browserDebugger.on('detach', this.onDetach)
    try {
      // Listener lifetime is tied to the workspace. Network.enable is intentionally not wrapped
      // in the one-shot capture deadline that previously made cold X sessions fail.
      await browserDebugger.sendCommand('Network.enable', {
        maxTotalBufferSize: 4 * 1024 * 1024,
        maxResourceBufferSize: 512 * 1024
      })
      if (this.disposed) return
      if (!this.attachedByUs || !browserDebugger.isAttached()) {
        throw new Error('账号浏览器调试通道在初始化期间断开')
      }
      this.started = true
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
    const browserDebugger = this.contents.debugger
    this.attachedByUs = false
    this.started = false
    this.startPromise = null
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
        return
      }
      this.pending.set(requestId, { keys, status, mimeType })
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
      if (this.disposed) return
      const raw = typeof body.body === 'string' ? body.body : ''
      rawBytes = body.base64Encoded === true ? Buffer.from(raw, 'base64') : Buffer.from(raw, 'utf8')
      const acceptedKeys: string[] = []
      const failedKeys: string[] = []
      for (const key of metadata.keys) {
        const registration = this.registrations.get(key)
        if (!registration) continue
        const diagnosticInput = {
          status: metadata.status,
          contentType: metadata.mimeType,
          body: rawBytes
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
        let projected: unknown
        try {
          projected = projectXIdentityCapture(registration.declaration.id, value)
        } catch {
          reject('平台后台响应投影失败')
          continue
        }
        const bytes = Buffer.from(JSON.stringify(projected), 'utf8')
        if (bytes.byteLength > (registration.declaration.maximumTotalBytes ?? 512 * 1024)) {
          bytes.fill(0)
          reject('平台后台身份投影超过清单限制')
          continue
        }
        const digest = createHash('sha256').update(bytes).digest('hex')
        registration.failure = null
        acceptedKeys.push(key)
        const duplicate = registration.cache.find((entry) => entry.digest === digest)
        if (duplicate) {
          duplicate.capturedAt = this.clock()
          bytes.fill(0)
          continue
        }
        while (registration.cache.length >= registration.limit) {
          const removed = registration.cache.shift()
          removed?.bytes.fill(0)
        }
        registration.cache.push({ bytes, digest, capturedAt: this.clock() })
      }
      const changedKeys = [...new Set([...acceptedKeys, ...failedKeys])]
      if (changedKeys.length > 0) this.emitNotice(changedKeys)
    } catch (error) {
      this.recordFailure(
        metadata.keys,
        normalizePluginNetworkError(error, '平台后台响应正文读取失败')
      )
    } finally {
      rawBytes?.fill(0)
    }
  }

  private emitNotice(keys: readonly string[]): void {
    const captureIds = new Set<string>()
    for (const key of keys) {
      const captureId = this.registrations.get(key)?.declaration.id
      if (captureId) captureIds.add(captureId)
    }
    for (const captureId of captureIds) {
      this.onCapture({ captureId, generation: this.generation, revision: ++this.revision })
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
    if (changed.length > 0) this.emitNotice(changed)
  }

  private scheduleRetry(keys: readonly string[]): void {
    if (this.disposed) return
    for (const key of keys) {
      const registration = this.registrations.get(key)
      if (!registration) continue
      registration.armed = false
      this.retryKeys.add(key)
    }
    if (this.restartTimer || this.retryKeys.size === 0) return
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      const pendingKeys = [...this.retryKeys]
      this.retryKeys.clear()
      for (const key of pendingKeys) {
        const registration = this.registrations.get(key)
        if (!registration || this.disposed) continue
        registration.failure = null
        this.arm(registration)
      }
    }, RESTART_DELAY_MS)
    this.restartTimer.unref?.()
  }

  private purgeExpired(): void {
    const cutoff = this.clock() - CACHE_TTL_MS
    for (const registration of this.registrations.values()) {
      const fresh: CachedCapture[] = []
      for (const entry of registration.cache) {
        if (entry.capturedAt >= cutoff) fresh.push(entry)
        else entry.bytes.fill(0)
      }
      registration.cache = fresh
    }
  }

  private evictRegistrationIfNeeded(): void {
    if (this.registrations.size < MAX_REGISTRATIONS) return
    const oldest = this.registrations.values().next().value as CaptureRegistration | undefined
    if (!oldest) return
    clearRegistration(oldest)
    this.registrations.delete(oldest.key)
  }
}

function isSupportedXIdentityCapture(captureId: string): boolean {
  return captureId === 'x.identity.settings' || captureId === 'x.identity.profile.initial'
}

function captureKey(namespace: string, captureId: string, expectedUrl: string, routeUrl: string): string {
  return createHash('sha256')
    .update(namespace)
    .update('\0')
    .update(captureId)
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

function projectXIdentityCapture(captureId: string, value: unknown): unknown {
  const source = objectRecord(value)
  const errors = Array.isArray(source.errors) && source.errors.length > 0 ? [{}] : undefined
  if (captureId === 'x.identity.settings') {
    return {
      ...(errors ? { errors } : {}),
      ...(typeof source.screen_name === 'string' ? { screen_name: source.screen_name } : {})
    }
  }

  const data = objectRecord(source.data)
  const user = objectRecord(data.user ?? data.user_result_by_screen_name)
  let result = objectRecord(user.result)
  for (let depth = 0; depth < 2 && result.rest_id === undefined && result.result; depth += 1) {
    result = objectRecord(result.result)
  }
  const legacy = objectRecord(result.legacy)
  const core = objectRecord(result.core)
  const avatar = objectRecord(result.avatar)
  const profileBio = objectRecord(result.profile_bio)
  return {
    ...(errors ? { errors } : {}),
    data: {
      user: {
        result: compactRecord({
          __typename: primitive(result.__typename),
          rest_id: primitive(result.rest_id),
          core: compactRecord({
            screen_name: primitive(core.screen_name),
            name: primitive(core.name)
          }),
          avatar: compactRecord({ image_url: primitive(avatar.image_url) }),
          profile_bio: compactRecord({ description: primitive(profileBio.description) }),
          legacy: compactRecord({
            screen_name: primitive(legacy.screen_name),
            name: primitive(legacy.name),
            profile_image_url_https: primitive(legacy.profile_image_url_https),
            description: primitive(legacy.description),
            followers_count: primitive(legacy.followers_count),
            friends_count: primitive(legacy.friends_count),
            statuses_count: primitive(legacy.statuses_count)
          })
        })
      }
    }
  }
}

function primitive(value: unknown): string | number | boolean | null | undefined {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value)
    ? value as string | number | boolean | null
    : undefined
}

function compactRecord(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined))
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
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('平台响应正文读取超时')), milliseconds)
    timer.unref?.()
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      () => { clearTimeout(timer); reject(new Error('平台响应正文读取失败')) }
    )
  })
}

export const __xBackgroundCaptureTest = Object.freeze({
  project: projectXIdentityCapture,
  matches: matchesCaptureUrl
})
