import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as nodeSign,
  verify as nodeVerify,
  KeyObject
} from 'node:crypto'
import yauzl, { type Entry, type ZipFile } from 'yauzl'
import type { PluginManifestV2 } from './contracts.js'
import { validateManifest } from './manifest.js'

export const PLUGIN_PACKAGE_EXTENSION = '.streamfold-plugin'
export const MAX_PLUGIN_PACKAGE_BYTES = 10 * 1024 * 1024
export const MAX_PLUGIN_UNPACKED_BYTES = 10 * 1024 * 1024
export const MAX_PLUGIN_PACKAGE_ENTRIES = 96

const PACKAGE_SIGNATURE_DOMAIN = Buffer.from('Streamfold Plugin Package v1\0', 'utf8')
const ENTRY_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,239}$/
const DOCUMENT_ENTRY = /^(?:LICENSE|README)(?:\.(?:md|txt))?$/i
const ICON_ENTRY = /^icons\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.(?:png|webp|jpe?g|ico)$/i
const JAVASCRIPT_ENTRY = /^(?:entries\/)?[A-Za-z0-9][A-Za-z0-9._/-]{0,199}\.js$/
const SIGNATURE_KEYS = ['algorithm', 'keyId', 'digest', 'signature'] as const
const KEY_ID = /^[a-z0-9](?:[a-z0-9._-]{1,126}[a-z0-9])?$/
const SHA256 = /^sha256:[a-f0-9]{64}$/
const BASE64_SIGNATURE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (0xedb88320 & -(value & 1))
  return value >>> 0
})

export type PluginSdkErrorCode =
  | 'PACKAGE_INVALID'
  | 'PACKAGE_TOO_LARGE'
  | 'PACKAGE_UNSAFE_ENTRY'
  | 'MANIFEST_INVALID'
  | 'SIGNATURE_INVALID'
  | 'HASH_MISMATCH'

export class PluginSdkError extends Error {
  constructor(
    readonly code: PluginSdkErrorCode,
    message: string,
    options: ErrorOptions = {}
  ) {
    super(message, options)
    this.name = 'PluginSdkError'
  }
}

export interface PluginPackageSignature {
  algorithm: 'ed25519'
  keyId: string
  digest: string
  signature: string
}

export interface ValidatedPluginEntries {
  manifest: PluginManifestV2
  entries: ReadonlyMap<string, Buffer>
  contentHash: string
  signature: PluginPackageSignature | null
}

export interface VerifiedPluginArchive extends ValidatedPluginEntries {
  archiveHash: string
}

export interface VerifyArchiveOptions {
  publicKey?: string | Buffer | KeyObject
  expectedKeyId?: string
  requireSignature?: boolean
}

/** The digest is byte-for-byte compatible with Streamfold's package verifier. */
export function digestPluginEntries(entries: ReadonlyMap<string, Uint8Array>): Buffer {
  const chunks: Buffer[] = [PACKAGE_SIGNATURE_DOMAIN]
  const names = [...entries.keys()].filter((name) => name !== 'signature.json').sort(compareUtf8)
  for (const name of names) {
    const value = entries.get(name)
    if (!value) throw new PluginSdkError('PACKAGE_INVALID', '插件包条目无效')
    const nameBytes = Buffer.from(name, 'utf8')
    const header = Buffer.allocUnsafe(12)
    header.writeUInt32BE(nameBytes.length, 0)
    header.writeBigUInt64BE(BigInt(value.byteLength), 4)
    chunks.push(header, nameBytes, Buffer.from(value.buffer, value.byteOffset, value.byteLength))
  }
  return createHash('sha256').update(Buffer.concat(chunks)).digest()
}

export function createPluginPackageSignature(
  entries: ReadonlyMap<string, Uint8Array>,
  keyId: string,
  privateKey: string | Buffer | KeyObject
): PluginPackageSignature {
  if (!KEY_ID.test(keyId)) throw new PluginSdkError('SIGNATURE_INVALID', '发布者密钥 ID 非法')
  const key = privateKey instanceof KeyObject ? privateKey : createPrivateKey(privateKey)
  if (key.asymmetricKeyType !== 'ed25519') throw new PluginSdkError('SIGNATURE_INVALID', '签名密钥必须是 Ed25519')
  const digest = digestPluginEntries(entries)
  return {
    algorithm: 'ed25519',
    keyId,
    digest: `sha256:${digest.toString('hex')}`,
    signature: nodeSign(null, Buffer.concat([PACKAGE_SIGNATURE_DOMAIN, digest]), key).toString('base64')
  }
}

export function validatePluginEntryName(name: string): void {
  if (
    typeof name !== 'string' || name !== name.normalize('NFC') || !ENTRY_NAME.test(name) ||
    name.startsWith('/') || name.includes('\\') || name.includes('//') || name.includes(':') ||
    name.split('/').some((part) => part === '.' || part === '..' || part.length === 0)
  ) {
    throw new PluginSdkError('PACKAGE_UNSAFE_ENTRY', '插件包包含不安全的文件路径')
  }
  if (!isAllowedEntry(name)) throw new PluginSdkError('PACKAGE_UNSAFE_ENTRY', `插件包包含不允许的文件：${name}`)
}

export function validatePluginEntries(entries: ReadonlyMap<string, Uint8Array>): ValidatedPluginEntries {
  if (!(entries instanceof Map) || entries.size === 0) throw new PluginSdkError('PACKAGE_INVALID', '插件包没有文件')
  if (entries.size > MAX_PLUGIN_PACKAGE_ENTRIES) throw new PluginSdkError('PACKAGE_TOO_LARGE', '插件包文件数量过多')
  let totalBytes = 0
  const normalized = new Map<string, Buffer>()
  const foldedNames = new Set<string>()
  for (const [name, raw] of entries) {
    validatePluginEntryName(name)
    if (!(raw instanceof Uint8Array)) throw new PluginSdkError('PACKAGE_INVALID', '插件包条目不是字节数据')
    const folded = name.toLowerCase()
    if (foldedNames.has(folded)) throw new PluginSdkError('PACKAGE_UNSAFE_ENTRY', '插件包包含大小写重复文件')
    foldedNames.add(folded)
    totalBytes += raw.byteLength
    if (totalBytes > MAX_PLUGIN_UNPACKED_BYTES) throw new PluginSdkError('PACKAGE_TOO_LARGE', '插件包解压后超过 10 MiB')
    normalized.set(name, Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength))
  }

  const manifestBytes = normalized.get('manifest.json')
  if (!manifestBytes) throw new PluginSdkError('PACKAGE_INVALID', '插件包缺少 manifest.json')
  let manifest: PluginManifestV2
  try {
    manifest = validateManifest(parseJson(manifestBytes, '插件清单'))
  } catch (error) {
    if (error instanceof PluginSdkError) throw error
    throw new PluginSdkError('MANIFEST_INVALID', error instanceof Error ? error.message : '插件清单无效', { cause: error })
  }
  if (manifest.contributions.some((contribution) => contribution.runtime !== 'quickjs')) {
    throw new PluginSdkError('MANIFEST_INVALID', '第三方插件贡献点必须使用 QuickJS')
  }
  const declaredEntries = new Set(manifest.contributions.map((contribution) => contribution.entry))
  for (const entry of declaredEntries) {
    if (!normalized.has(entry)) throw new PluginSdkError('PACKAGE_INVALID', `插件包缺少贡献点入口：${entry}`)
  }
  for (const name of normalized.keys()) {
    if (JAVASCRIPT_ENTRY.test(name) && !declaredEntries.has(name)) {
      throw new PluginSdkError('PACKAGE_UNSAFE_ENTRY', `插件包包含未声明的 JavaScript：${name}`)
    }
  }

  const signatureBytes = normalized.get('signature.json')
  const signature = signatureBytes ? parseSignature(signatureBytes) : null
  const digest = digestPluginEntries(normalized)
  if (signature && signature.digest !== `sha256:${digest.toString('hex')}`) {
    throw new PluginSdkError('HASH_MISMATCH', '插件包内容摘要不一致')
  }
  if (signature && signature.keyId !== manifest.publisher.keyId) {
    throw new PluginSdkError('SIGNATURE_INVALID', '插件签名密钥与清单不一致')
  }
  return {
    manifest,
    entries: normalized,
    contentHash: `sha256:${digest.toString('hex')}`,
    signature
  }
}

export async function verifyPluginArchive(
  archive: Uint8Array,
  options: VerifyArchiveOptions = {}
): Promise<VerifiedPluginArchive> {
  if (!(archive instanceof Uint8Array) || archive.byteLength === 0) throw new PluginSdkError('PACKAGE_INVALID', '插件包无效')
  if (archive.byteLength > MAX_PLUGIN_PACKAGE_BYTES) throw new PluginSdkError('PACKAGE_TOO_LARGE', '插件包超过 10 MiB')
  const archiveBytes = Buffer.from(archive.buffer, archive.byteOffset, archive.byteLength)
  const validated = validatePluginEntries(await readPluginArchive(archiveBytes))
  const requireSignature = options.requireSignature ?? true
  if (requireSignature && !validated.signature) throw new PluginSdkError('SIGNATURE_INVALID', '插件包缺少发布者签名')
  if (validated.signature) {
    if (!options.publicKey) throw new PluginSdkError('SIGNATURE_INVALID', '缺少发布者公钥')
    if (options.expectedKeyId && validated.signature.keyId !== options.expectedKeyId) {
      throw new PluginSdkError('SIGNATURE_INVALID', '插件签名密钥 ID 不匹配')
    }
    const key = readPublicKey(options.publicKey)
    const signature = Buffer.from(validated.signature.signature, 'base64')
    const digest = Buffer.from(validated.signature.digest.slice(7), 'hex')
    try {
      if (!nodeVerify(null, Buffer.concat([PACKAGE_SIGNATURE_DOMAIN, digest]), key, signature)) {
        throw new PluginSdkError('SIGNATURE_INVALID', '插件包签名验证失败')
      }
    } finally {
      signature.fill(0)
    }
  }
  return {
    ...validated,
    archiveHash: `sha256:${createHash('sha256').update(archiveBytes).digest('hex')}`
  }
}

export async function readPluginArchive(archive: Uint8Array): Promise<Map<string, Buffer>> {
  if (archive.byteLength === 0 || archive.byteLength > MAX_PLUGIN_PACKAGE_BYTES) {
    throw new PluginSdkError(archive.byteLength === 0 ? 'PACKAGE_INVALID' : 'PACKAGE_TOO_LARGE', '插件包大小非法')
  }
  const bytes = Buffer.from(archive.buffer, archive.byteOffset, archive.byteLength)
  const zip = await openZip(bytes)
  return new Promise((resolve, reject) => {
    const entries = new Map<string, Buffer>()
    const foldedNames = new Set<string>()
    let totalBytes = 0
    let settled = false
    const fail = (error: unknown): void => {
      if (settled) return
      settled = true
      zip.close()
      reject(error instanceof PluginSdkError ? error : new PluginSdkError('PACKAGE_INVALID', '无法读取插件包', { cause: error }))
    }
    zip.once('error', fail)
    zip.on('entry', (entry: Entry) => {
      void (async () => {
        if (isDirectory(entry)) {
          validateDirectory(entry)
          const folded = entry.fileName.toLowerCase()
          if (foldedNames.has(folded)) throw new PluginSdkError('PACKAGE_UNSAFE_ENTRY', '插件包包含重复目录')
          foldedNames.add(folded)
          zip.readEntry()
          return
        }
        validatePluginEntryName(entry.fileName)
        if (isSymbolicLink(entry)) throw new PluginSdkError('PACKAGE_UNSAFE_ENTRY', '插件包不允许符号链接')
        const folded = entry.fileName.toLowerCase()
        if (entries.has(entry.fileName) || foldedNames.has(folded)) {
          throw new PluginSdkError('PACKAGE_UNSAFE_ENTRY', '插件包包含重复文件')
        }
        if (entries.size >= MAX_PLUGIN_PACKAGE_ENTRIES) throw new PluginSdkError('PACKAGE_TOO_LARGE', '插件包文件数量过多')
        if (entry.uncompressedSize > MAX_PLUGIN_UNPACKED_BYTES - totalBytes) {
          throw new PluginSdkError('PACKAGE_TOO_LARGE', '插件包解压后超过 10 MiB')
        }
        const value = await readEntry(zip, entry)
        if (value.length !== entry.uncompressedSize || crc32(value) !== entry.crc32) {
          throw new PluginSdkError('PACKAGE_INVALID', '插件包文件校验失败')
        }
        entries.set(entry.fileName, value)
        foldedNames.add(folded)
        totalBytes += value.length
        zip.readEntry()
      })().catch(fail)
    })
    zip.once('end', () => {
      if (settled) return
      settled = true
      resolve(entries)
    })
    zip.readEntry()
  })
}

/** Creates a deterministic, uncompressed ZIP accepted by the app host. */
export function writePluginArchive(entries: ReadonlyMap<string, Uint8Array>): Buffer {
  const validated = validatePluginEntries(entries)
  const names = [...validated.entries.keys()].sort(compareUtf8)
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let offset = 0
  for (const name of names) {
    const value = validated.entries.get(name)!
    const nameBytes = Buffer.from(name, 'utf8')
    const crc = crc32(value)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x800, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0x21, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(value.length, 18)
    local.writeUInt32LE(value.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    localParts.push(local, nameBytes, value)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE((3 << 8) | 20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x800, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0x21, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(value.length, 20)
    central.writeUInt32LE(value.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38)
    central.writeUInt32LE(offset, 42)
    centralParts.push(central, nameBytes)
    offset += local.length + nameBytes.length + value.length
  }
  const centralDirectory = Buffer.concat(centralParts)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(names.length, 8)
  end.writeUInt16LE(names.length, 10)
  end.writeUInt32LE(centralDirectory.length, 12)
  end.writeUInt32LE(offset, 16)
  const archive = Buffer.concat([...localParts, centralDirectory, end])
  if (archive.length > MAX_PLUGIN_PACKAGE_BYTES) throw new PluginSdkError('PACKAGE_TOO_LARGE', '插件包超过 10 MiB')
  return archive
}

function parseSignature(bytes: Uint8Array): PluginPackageSignature {
  const value = parseJson(bytes, '插件签名')
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidSignature()
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  if (keys.length !== SIGNATURE_KEYS.length || SIGNATURE_KEYS.some((key) => !keys.includes(key))) throw invalidSignature()
  if (
    record.algorithm !== 'ed25519' || typeof record.keyId !== 'string' || !KEY_ID.test(record.keyId) ||
    typeof record.digest !== 'string' || !SHA256.test(record.digest) ||
    typeof record.signature !== 'string' || record.signature.length !== 88 || !BASE64_SIGNATURE.test(record.signature)
  ) throw invalidSignature()
  const decoded = Buffer.from(record.signature, 'base64')
  if (decoded.length !== 64 || decoded.toString('base64') !== record.signature) throw invalidSignature()
  decoded.fill(0)
  return record as unknown as PluginPackageSignature
}

function readPublicKey(value: string | Buffer | KeyObject): KeyObject {
  try {
    const key = value instanceof KeyObject
      ? (value.type === 'public' ? value : createPublicKey(value))
      : createPublicKey(value)
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('not Ed25519')
    return key
  } catch (error) {
    throw new PluginSdkError('SIGNATURE_INVALID', '发布者公钥必须是 Ed25519', { cause: error })
  }
}

function isAllowedEntry(name: string): boolean {
  return name === 'manifest.json' || name === 'signature.json' || DOCUMENT_ENTRY.test(name) ||
    ICON_ENTRY.test(name) || JAVASCRIPT_ENTRY.test(name)
}

function parseJson(bytes: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch (error) {
    throw new PluginSdkError('PACKAGE_INVALID', `${label}不是有效 JSON`, { cause: error })
  }
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ byte) & 0xff]!
  return (crc ^ 0xffffffff) >>> 0
}

function openZip(archive: Buffer): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(archive, {
      autoClose: true,
      lazyEntries: true,
      decodeStrings: true,
      validateEntrySizes: true,
      strictFileNames: true
    }, (error, zip) => error || !zip
      ? reject(new PluginSdkError('PACKAGE_INVALID', '无法读取插件包', { cause: error ?? undefined }))
      : resolve(zip))
  })
}

function readEntry(zip: ZipFile, entry: Entry): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error || !stream) return reject(error ?? new Error('ZIP 条目无效'))
      const chunks: Buffer[] = []
      let length = 0
      stream.on('data', (chunk: Buffer) => {
        length += chunk.length
        if (length > entry.uncompressedSize || length > MAX_PLUGIN_UNPACKED_BYTES) {
          stream.destroy(new PluginSdkError('PACKAGE_TOO_LARGE', '插件包文件超过大小限制'))
          return
        }
        chunks.push(chunk)
      })
      stream.once('error', reject)
      stream.once('end', () => resolve(Buffer.concat(chunks, length)))
    })
  })
}

function isDirectory(entry: Entry): boolean {
  return entry.fileName.endsWith('/') || (entry.externalFileAttributes & 0x10) !== 0
}

function validateDirectory(entry: Entry): void {
  if (
    entry.uncompressedSize !== 0 || entry.compressedSize !== 0 ||
    (entry.fileName !== 'entries/' && entry.fileName !== 'icons/') ||
    isSymbolicLink(entry)
  ) throw new PluginSdkError('PACKAGE_UNSAFE_ENTRY', '插件包包含不安全的目录')
}

function isSymbolicLink(entry: Entry): boolean {
  const platform = entry.versionMadeBy >>> 8
  if (platform !== 3) return false
  const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff
  return (unixMode & 0o170000) === 0o120000
}

function invalidSignature(): PluginSdkError {
  return new PluginSdkError('SIGNATURE_INVALID', '插件签名文件无效')
}
