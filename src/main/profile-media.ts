import { createHash, randomUUID } from 'node:crypto'
import { open, lstat, mkdir, readFile, readdir, rename, rm } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'

export const PROFILE_AVATAR_MAX_BYTES = 512 * 1024
const MAX_REDIRECTS = 3
const DEFAULT_TIMEOUT_MS = 15_000
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const CACHE_KEY_RE = /^([0-9a-f]{64})\.(jpg|png|webp|gif|avif)$/
const MEDIA_PATH_RE = /^\/media\/avatars\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/([0-9a-f]{64}\.(?:jpg|png|webp|gif|avif))$/
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const ZHIHU_AVATAR_HOSTS = new Set([
  'pic.zhimg.com',
  'pic1.zhimg.com',
  'pic2.zhimg.com',
  'pic3.zhimg.com',
  'pic4.zhimg.com',
  'pica.zhimg.com',
  'picb.zhimg.com',
  'picx.zhimg.com'
])

const MIME_EXTENSIONS = Object.freeze({
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif'
} as const)

type SupportedMime = keyof typeof MIME_EXTENSIONS
type AvatarSourceFamily = 'xiaohongshu' | 'zhihu'

export interface CachedProfileAvatar {
  cacheKey: string
  mime: SupportedMime
}

export interface ProfileMediaAsset extends CachedProfileAvatar {
  accountId: string
  bytes: Uint8Array
}

export type ProfileMediaFetcher = (url: string, init: RequestInit) => Promise<Response>

export class ProfileMediaStore {
  private readonly rootDirectory: string
  private readonly avatarsDirectory: string

  constructor(
    rootDirectory: string,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS
  ) {
    if (!rootDirectory || !isAbsolute(rootDirectory)) {
      throw new Error('头像缓存目录必须是绝对路径')
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) {
      throw new Error('头像下载超时时间无效')
    }
    this.rootDirectory = resolve(rootDirectory)
    this.avatarsDirectory = resolve(this.rootDirectory, 'avatars')
    if (!isWithin(this.rootDirectory, this.avatarsDirectory)) throw new Error('头像缓存目录无效')
  }

  async cacheAvatar(
    accountId: string,
    sourceUrl: string,
    fetcher: ProfileMediaFetcher,
    allowedHosts?: readonly string[]
  ): Promise<CachedProfileAvatar> {
    assertAccountId(accountId)
    const hostPolicy = normalizeAvatarHosts(allowedHosts)
    assertAvatarSourceUrl(sourceUrl, undefined, hostPolicy)
    if (typeof fetcher !== 'function') throw new Error('头像下载器无效')

    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(new Error('头像下载超时'))
      }, this.timeoutMs)
    })
    try {
      return await Promise.race([
        this.downloadAndStore(accountId, sourceUrl, fetcher, controller.signal, hostPolicy),
        timeout
      ])
    } finally {
      if (timer) clearTimeout(timer)
      controller.abort()
    }
  }

  async readAppUrl(value: string): Promise<ProfileMediaAsset | null> {
    let url: URL
    try {
      url = new URL(value)
    } catch {
      return null
    }
    if (url.protocol !== 'app:' || url.hostname !== 'shell' || url.username || url.password ||
      url.port || url.search || url.hash || url.pathname.includes('%')) return null
    const match = MEDIA_PATH_RE.exec(url.pathname)
    if (!match) return null
    const accountId = match[1]!
    const cacheKey = match[2]!
    const parsed = parseCacheKey(cacheKey)
    if (!parsed) return null

    const accountDirectory = this.accountDirectory(accountId)
    const target = resolve(accountDirectory, cacheKey)
    if (!isWithin(accountDirectory, target)) return null
    if (!await isPlainDirectory(accountDirectory) || !await isPlainFile(target)) return null
    const bytes = await readBoundedFile(target)
    if (!bytes || !matchesMagic(bytes, parsed.mime) || sha256(bytes) !== parsed.hash) return null
    return { accountId, cacheKey, mime: parsed.mime, bytes }
  }

  async purgeAccount(accountId: string): Promise<void> {
    assertAccountId(accountId)
    const target = this.accountDirectory(accountId)
    if (!isWithin(this.avatarsDirectory, target)) throw new Error('头像账号目录无效')
    await rm(target, { recursive: true, force: true })
  }

  async pruneAccountAvatars(accountId: string, keepCacheKey: string): Promise<void> {
    assertAccountId(accountId)
    if (!parseCacheKey(keepCacheKey)) throw new Error('头像缓存键无效')
    const accountDirectory = this.accountDirectory(accountId)
    if (!await isPlainDirectory(accountDirectory)) return
    await this.removeOldAvatars(accountDirectory, keepCacheKey)
  }

  async pruneAccounts(accountIds: ReadonlySet<string>): Promise<void> {
    for (const id of accountIds) assertAccountId(id)
    if (!await isPlainDirectory(this.avatarsDirectory)) return
    const entries = await readdir(this.avatarsDirectory, { withFileTypes: true })
    for (const entry of entries) {
      if (!UUID_RE.test(entry.name) || accountIds.has(entry.name)) continue
      const target = this.accountDirectory(entry.name)
      if (isWithin(this.avatarsDirectory, target)) {
        await rm(target, { recursive: true, force: true })
      }
    }
  }

  private async downloadAndStore(
    accountId: string,
    sourceUrl: string,
    fetcher: ProfileMediaFetcher,
    signal: AbortSignal,
    allowedHosts: ReadonlySet<string> | null
  ): Promise<CachedProfileAvatar> {
    let current = assertAvatarSourceUrl(sourceUrl, undefined, allowedHosts)
    const sourceFamily = allowedHosts ? undefined : avatarSourceFamily(current.hostname) ?? undefined
    let response: Response | null = null
    for (let redirects = 0; ; redirects += 1) {
      if (signal.aborted) throw new Error('头像下载已取消')
      response = await fetcher(current.href, {
        method: 'GET',
        credentials: 'omit',
        redirect: 'manual',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        headers: {
          Accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif'
        },
        signal
      })
      if (response.redirected) throw new Error('头像请求发生了未经核验的自动跳转')
      if (response.url) assertAvatarSourceUrl(response.url, sourceFamily, allowedHosts)
      if (!REDIRECT_STATUSES.has(response.status)) break
      await cancelBody(response)
      if (redirects >= MAX_REDIRECTS) throw new Error('头像重定向次数超过上限')
      const location = response.headers.get('location')
      if (!location || location.length > 2_048) throw new Error('头像重定向地址无效')
      let next: URL
      try {
        next = new URL(location, current)
      } catch {
        throw new Error('头像重定向地址无效')
      }
      current = assertAvatarSourceUrl(next.href, sourceFamily, allowedHosts)
    }

    if (!response || response.status !== 200) {
      await cancelBody(response)
      throw new Error('头像下载未返回成功状态')
    }
    const mime = parseContentType(response.headers.get('content-type'))
    const declaredLength = parseContentLength(response.headers.get('content-length'))
    const bytes = await readLimitedBody(response, signal)
    if (declaredLength !== null && declaredLength !== bytes.byteLength) {
      throw new Error('头像 Content-Length 与正文长度不一致')
    }
    if (!matchesMagic(bytes, mime)) throw new Error('头像文件头与 MIME 类型不匹配')
    if (signal.aborted) throw new Error('头像下载已取消')

    const hash = sha256(bytes)
    const cacheKey = `${hash}.${MIME_EXTENSIONS[mime]}`
    const accountDirectory = await this.ensureAccountDirectory(accountId)
    const target = resolve(accountDirectory, cacheKey)
    if (!isWithin(accountDirectory, target)) throw new Error('头像目标路径无效')
    if (!await isValidCachedFile(target, hash, mime)) {
      await this.atomicWrite(target, bytes, accountDirectory)
      if (!await isValidCachedFile(target, hash, mime)) throw new Error('头像缓存写入校验失败')
    }
    return { cacheKey, mime }
  }

  private async ensureAccountDirectory(accountId: string): Promise<string> {
    await ensurePlainDirectory(this.rootDirectory)
    await ensurePlainDirectory(this.avatarsDirectory)
    const accountDirectory = this.accountDirectory(accountId)
    await ensurePlainDirectory(accountDirectory)
    return accountDirectory
  }

  private accountDirectory(accountId: string): string {
    assertAccountId(accountId)
    const target = resolve(this.avatarsDirectory, accountId)
    if (!isWithin(this.avatarsDirectory, target)) throw new Error('头像账号目录无效')
    return target
  }

  private async atomicWrite(target: string, bytes: Uint8Array, accountDirectory: string): Promise<void> {
    const temporary = resolve(accountDirectory, `.${randomUUID()}.tmp`)
    if (!isWithin(accountDirectory, temporary)) throw new Error('头像临时路径无效')
    let handle: Awaited<ReturnType<typeof open>> | null = null
    try {
      handle = await open(temporary, 'wx', 0o600)
      await handle.writeFile(bytes)
      await handle.sync()
      await handle.close()
      handle = null
      try {
        await rename(temporary, target)
      } catch (error) {
        await rm(target, { force: true })
        await rename(temporary, target).catch(() => { throw error })
      }
    } finally {
      await handle?.close().catch(() => undefined)
      await rm(temporary, { force: true }).catch(() => undefined)
    }
  }

  private async removeOldAvatars(accountDirectory: string, currentKey: string): Promise<void> {
    const entries = await readdir(accountDirectory, { withFileTypes: true })
    await Promise.all(entries.map(async (entry) => {
      if (entry.name === currentKey || !CACHE_KEY_RE.test(entry.name)) return
      const target = resolve(accountDirectory, entry.name)
      if (isWithin(accountDirectory, target)) await rm(target, { force: true })
    }))
  }
}

function assertAvatarSourceUrl(
  value: string,
  expectedFamily?: AvatarSourceFamily,
  allowedHosts: ReadonlySet<string> | null = null
): URL {
  if (typeof value !== 'string' || value.length < 1 || value.length > 2_048) {
    throw new Error('头像地址无效')
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('头像地址无效')
  }
  const authority = /^https:\/\/([^/?#]+)/i.exec(value)?.[1] ?? ''
  const hasExplicitPort = /:\d+$/.test(authority)
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '')
  const family = avatarSourceFamily(hostname)
  const allowed = allowedHosts ? allowedHosts.has(hostname) : Boolean(family && (!expectedFamily || family === expectedFamily))
  if (url.protocol !== 'https:' || !allowed ||
    url.username || url.password || url.port ||
    hasExplicitPort || url.hash) {
    throw new Error('头像地址不在允许的平台域名内')
  }
  return url
}

function normalizeAvatarHosts(value: readonly string[] | undefined): ReadonlySet<string> | null {
  if (value === undefined) return null
  const hosts = new Set(value.map((item) => item.toLowerCase().replace(/\.$/, '')))
  if (hosts.size === 0 || [...hosts].some((host) => (
    host.length > 253 || !/^[a-z0-9.-]+$/.test(host) || host.startsWith('.') ||
    host.endsWith('.') || host.includes('..') || host === 'localhost'
  ))) throw new Error('头像允许域名无效')
  return hosts
}

function avatarSourceFamily(hostname: string): AvatarSourceFamily | null {
  const normalized = hostname.toLowerCase().replace(/\.$/, '')
  if (normalized === 'xhscdn.com' || normalized.endsWith('.xhscdn.com') ||
    normalized === 'xiaohongshu.com' || normalized.endsWith('.xiaohongshu.com')) {
    return 'xiaohongshu'
  }
  return ZHIHU_AVATAR_HOSTS.has(normalized) ? 'zhihu' : null
}

function parseContentType(value: string | null): SupportedMime {
  const mime = String(value || '').split(';', 1)[0]!.trim().toLowerCase()
  if (!Object.hasOwn(MIME_EXTENSIONS, mime)) throw new Error('头像 MIME 类型不受支持')
  return mime as SupportedMime
}

function parseContentLength(value: string | null): number | null {
  if (value === null || value === '') return null
  if (!/^\d{1,10}$/.test(value)) throw new Error('头像 Content-Length 无效')
  const length = Number(value)
  if (!Number.isSafeInteger(length) || length < 1 || length > PROFILE_AVATAR_MAX_BYTES) {
    throw new Error('头像大小超过 512 KiB 上限')
  }
  return length
}

async function readLimitedBody(response: Response, signal: AbortSignal): Promise<Uint8Array> {
  if (!response.body) throw new Error('头像响应正文为空')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      if (signal.aborted) throw new Error('头像下载已取消')
      const part = await reader.read()
      if (part.done) break
      total += part.value.byteLength
      if (total > PROFILE_AVATAR_MAX_BYTES) {
        await reader.cancel()
        throw new Error('头像大小超过 512 KiB 上限')
      }
      chunks.push(part.value)
    }
  } finally {
    reader.releaseLock()
  }
  if (total < 1) throw new Error('头像响应正文为空')
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

async function readBoundedFile(target: string): Promise<Uint8Array | null> {
  try {
    const info = await lstat(target)
    if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > PROFILE_AVATAR_MAX_BYTES) {
      return null
    }
    const bytes = new Uint8Array(await readFile(target))
    return bytes.byteLength <= PROFILE_AVATAR_MAX_BYTES ? bytes : null
  } catch {
    return null
  }
}

async function ensurePlainDirectory(target: string): Promise<void> {
  await mkdir(target, { recursive: true, mode: 0o700 })
  if (!await isPlainDirectory(target)) throw new Error('头像缓存目录不是安全的本地目录')
}

async function isPlainDirectory(target: string): Promise<boolean> {
  try {
    const info = await lstat(target)
    return info.isDirectory() && !info.isSymbolicLink()
  } catch {
    return false
  }
}

async function isPlainFile(target: string): Promise<boolean> {
  try {
    const info = await lstat(target)
    return info.isFile() && !info.isSymbolicLink()
  } catch {
    return false
  }
}

async function isValidCachedFile(
  target: string,
  expectedHash: string,
  mime: SupportedMime
): Promise<boolean> {
  const bytes = await readBoundedFile(target)
  return Boolean(bytes && matchesMagic(bytes, mime) && sha256(bytes) === expectedHash)
}

function parseCacheKey(value: string): { hash: string; mime: SupportedMime } | null {
  const match = CACHE_KEY_RE.exec(value)
  if (!match) return null
  const mime = Object.entries(MIME_EXTENSIONS)
    .find(([, extension]) => extension === match[2])?.[0] as SupportedMime | undefined
  return mime ? { hash: match[1]!, mime } : null
}

function matchesMagic(bytes: Uint8Array, mime: SupportedMime): boolean {
  if (mime === 'image/jpeg') {
    return bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  }
  if (mime === 'image/png') {
    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
    return bytes.length >= signature.length && signature.every((value, index) => bytes[index] === value)
  }
  if (mime === 'image/gif') {
    return bytes.length >= 6 && (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a')
  }
  if (mime === 'image/webp') {
    return bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP'
  }
  if (bytes.length < 16 || ascii(bytes, 4, 8) !== 'ftyp') return false
  const boxLength = readUint32(bytes, 0)
  if (boxLength < 16 || boxLength > bytes.length) return false
  for (let offset = 8; offset + 4 <= Math.min(boxLength, 64); offset += 4) {
    const brand = ascii(bytes, offset, offset + 4)
    if (brand === 'avif' || brand === 'avis') return true
  }
  return false
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end))
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset]! * 0x1000000) + (bytes[offset + 1]! << 16) +
    (bytes[offset + 2]! << 8) + bytes[offset + 3]!) >>> 0
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function assertAccountId(value: string): void {
  if (typeof value !== 'string' || !UUID_RE.test(value)) throw new Error('头像账号 ID 无效')
}

function isWithin(root: string, target: string): boolean {
  const value = relative(root, target)
  return value !== '' && !value.startsWith('..') && !isAbsolute(value)
}

async function cancelBody(response: Response | null): Promise<void> {
  if (!response?.body) return
  try {
    await response.body.cancel()
  } catch {}
}
