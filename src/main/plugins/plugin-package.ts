import { createPublicKey, type KeyObject } from 'node:crypto'
import { stat, readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import yauzl, { type Entry, type ZipFile } from 'yauzl'
import {
  validatePluginManifestV2,
  type PluginManifestV2
} from '../../shared/plugin-host-contracts'
import {
  compareUtf8,
  decodeSignature,
  equalSha256,
  formatSha256,
  parseSha256,
  readEd25519PublicKey,
  sha256,
  verifyEd25519
} from './signing'
import { PluginSupplyChainError, isPluginSupplyChainError } from './supply-chain-errors'

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
const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (0xedb88320 & -(value & 1))
  return value >>> 0
})

export interface PluginPackageSignature {
  algorithm: 'ed25519'
  keyId: string
  digest: string
  signature: string
}

export interface VerifiedPluginPackage {
  manifest: PluginManifestV2
  entries: ReadonlyMap<string, Buffer>
  archiveHash: string
  contentHash: string
  signature: PluginPackageSignature | null
  development: boolean
}

export interface VerifyPluginPackageOptions {
  source: 'catalog' | 'local_development'
  publisherPublicKey?: string | KeyObject
  expectedArchiveHash?: string
  expectedPublisherKeyId?: string
}

export async function verifyPluginPackageFile(
  filePath: string,
  options: VerifyPluginPackageOptions
): Promise<VerifiedPluginPackage> {
  if (extname(filePath).toLowerCase() !== PLUGIN_PACKAGE_EXTENSION) {
    throw new PluginSupplyChainError('PLUGIN_PACKAGE_INVALID', '请选择 .streamfold-plugin 插件包')
  }
  const metadata = await stat(filePath)
  if (!metadata.isFile() || metadata.size === 0) {
    throw new PluginSupplyChainError('PLUGIN_PACKAGE_INVALID', '插件包无效')
  }
  if (metadata.size > MAX_PLUGIN_PACKAGE_BYTES) {
    throw new PluginSupplyChainError('PLUGIN_PACKAGE_TOO_LARGE', '插件包超过 10 MiB')
  }
  return verifyPluginPackage(await readFile(filePath), options)
}

export async function verifyPluginPackage(
  archive: Uint8Array,
  options: VerifyPluginPackageOptions
): Promise<VerifiedPluginPackage> {
  if (!(archive instanceof Uint8Array) || archive.byteLength === 0) {
    throw new PluginSupplyChainError('PLUGIN_PACKAGE_INVALID', '插件包无效')
  }
  if (archive.byteLength > MAX_PLUGIN_PACKAGE_BYTES) {
    throw new PluginSupplyChainError('PLUGIN_PACKAGE_TOO_LARGE', '插件包超过 10 MiB')
  }
  const archiveBytes = Buffer.from(archive.buffer, archive.byteOffset, archive.byteLength)
  if (options.expectedArchiveHash && !equalSha256(options.expectedArchiveHash, archiveBytes)) {
    throw new PluginSupplyChainError('PLUGIN_PACKAGE_HASH_MISMATCH', '插件包与目录记录不一致')
  }

  let entries: Map<string, Buffer>
  try {
    entries = await readZipEntries(archiveBytes)
  } catch (error) {
    if (isPluginSupplyChainError(error)) throw error
    if (error instanceof Error && /invalid relative path|backslash|absolute path|file name/i.test(error.message)) {
      throw new PluginSupplyChainError('PLUGIN_PACKAGE_UNSAFE_ENTRY', '插件包包含不安全的文件路径', { cause: error })
    }
    throw new PluginSupplyChainError('PLUGIN_PACKAGE_INVALID', '无法读取插件包', { cause: error })
  }
  const manifestBytes = entries.get('manifest.json')
  if (!manifestBytes) throw new PluginSupplyChainError('PLUGIN_PACKAGE_INVALID', '插件包缺少 manifest.json')

  let manifest: PluginManifestV2
  try {
    manifest = validatePluginManifestV2(parseStrictJson(manifestBytes, '插件清单'))
  } catch (error) {
    throw new PluginSupplyChainError('PLUGIN_PACKAGE_MANIFEST_INVALID', '插件清单无效', { cause: error })
  }
  validateEntrySet(entries, manifest)

  const contentDigest = digestPluginEntries(entries)
  const signatureBytes = entries.get('signature.json')
  const signature = signatureBytes ? parseSignature(signatureBytes) : null
  if (options.source === 'catalog' && !signature) {
    throw new PluginSupplyChainError('PLUGIN_PACKAGE_SIGNATURE_INVALID', '目录插件必须包含发布者签名')
  }
  if (signature) {
    const expectedDigest = parseSha256(signature.digest, 'PLUGIN_PACKAGE_INVALID')
    if (!expectedDigest.equals(contentDigest)) {
      throw new PluginSupplyChainError('PLUGIN_PACKAGE_HASH_MISMATCH', '插件包内容摘要不一致')
    }
    if (signature.keyId !== manifest.publisher.keyId ||
        (options.expectedPublisherKeyId && signature.keyId !== options.expectedPublisherKeyId)) {
      throw new PluginSupplyChainError('PLUGIN_PACKAGE_SIGNATURE_INVALID', '插件签名密钥与目录记录不一致')
    }
    if (!options.publisherPublicKey) {
      throw new PluginSupplyChainError('PLUGIN_PACKAGE_SIGNATURE_INVALID', '缺少可信发布者公钥')
    }
    const publicKey = typeof options.publisherPublicKey === 'string'
      ? readEd25519PublicKey(options.publisherPublicKey)
      : ensureEd25519Key(options.publisherPublicKey)
    const signatureValue = decodeSignature(signature.signature, 'PLUGIN_PACKAGE_SIGNATURE_INVALID')
    const payload = Buffer.concat([PACKAGE_SIGNATURE_DOMAIN, contentDigest])
    try {
      if (!verifyEd25519(payload, signatureValue, publicKey)) {
        throw new PluginSupplyChainError('PLUGIN_PACKAGE_SIGNATURE_INVALID', '插件包签名验证失败')
      }
    } finally {
      signatureValue.fill(0)
    }
  } else if (options.publisherPublicKey || options.expectedPublisherKeyId) {
    throw new PluginSupplyChainError('PLUGIN_PACKAGE_SIGNATURE_INVALID', '插件包缺少发布者签名')
  }

  return {
    manifest,
    entries,
    archiveHash: formatSha256(archiveBytes),
    contentHash: `sha256:${contentDigest.toString('hex')}`,
    signature,
    development: options.source === 'local_development' && signature === null
  }
}

/** Deterministic digest independent of ZIP ordering, timestamps, compression and signature bytes. */
export function digestPluginEntries(entries: ReadonlyMap<string, Uint8Array>): Buffer {
  const chunks: Buffer[] = [PACKAGE_SIGNATURE_DOMAIN]
  const names = [...entries.keys()].filter((name) => name !== 'signature.json').sort(compareUtf8)
  for (const name of names) {
    const nameBytes = Buffer.from(name, 'utf8')
    const value = entries.get(name)
    if (!value) throw new PluginSupplyChainError('PLUGIN_PACKAGE_INVALID', '插件包条目无效')
    const header = Buffer.allocUnsafe(12)
    header.writeUInt32BE(nameBytes.length, 0)
    header.writeBigUInt64BE(BigInt(value.byteLength), 4)
    chunks.push(header, nameBytes, Buffer.from(value.buffer, value.byteOffset, value.byteLength))
  }
  return sha256(Buffer.concat(chunks))
}

export function createPluginPackageSignature(
  entries: ReadonlyMap<string, Uint8Array>,
  keyId: string,
  signer: (payload: Uint8Array) => string
): PluginPackageSignature {
  const digest = digestPluginEntries(entries)
  return {
    algorithm: 'ed25519',
    keyId,
    digest: `sha256:${digest.toString('hex')}`,
    signature: signer(Buffer.concat([PACKAGE_SIGNATURE_DOMAIN, digest]))
  }
}

export function validatePluginEntryName(name: string): void {
  if (
    typeof name !== 'string' || name !== name.normalize('NFC') || !ENTRY_NAME.test(name) ||
    name.startsWith('/') || name.includes('\\') || name.includes('//') || name.includes(':') ||
    name.split('/').some((part) => part === '.' || part === '..' || part.length === 0)
  ) {
    throw new PluginSupplyChainError('PLUGIN_PACKAGE_UNSAFE_ENTRY', '插件包包含不安全的文件路径')
  }
  if (!isPotentiallyAllowedEntry(name)) {
    throw new PluginSupplyChainError('PLUGIN_PACKAGE_UNSAFE_ENTRY', '插件包包含不允许的文件')
  }
}

function validateEntrySet(entries: ReadonlyMap<string, Buffer>, manifest: PluginManifestV2): void {
  const declaredEntries = new Set(manifest.contributions.map((item) => item.entry))
  if (manifest.contributions.some((item) => item.runtime !== 'quickjs')) {
    throw new PluginSupplyChainError('PLUGIN_PACKAGE_MANIFEST_INVALID', '外部插件贡献点必须使用 QuickJS')
  }
  for (const entry of declaredEntries) {
    const bytes = entries.get(entry)
    if (!bytes) {
      throw new PluginSupplyChainError('PLUGIN_PACKAGE_INVALID', '插件包缺少贡献点入口')
    }
    if (bytes.byteLength > 2 * 1024 * 1024) {
      throw new PluginSupplyChainError('PLUGIN_PACKAGE_TOO_LARGE', '插件入口超过 2 MiB')
    }
    let source = ''
    try {
      source = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch (error) {
      throw new PluginSupplyChainError('PLUGIN_PACKAGE_INVALID', '插件入口不是有效 UTF-8 JavaScript', { cause: error })
    }
    if (/\bimport\s*(?:\(|['"])/.test(source)) {
      throw new PluginSupplyChainError('PLUGIN_PACKAGE_UNSAFE_ENTRY', '插件入口不允许动态或静态导入')
    }
  }
  for (const name of entries.keys()) {
    if (JAVASCRIPT_ENTRY.test(name) && !declaredEntries.has(name)) {
      throw new PluginSupplyChainError('PLUGIN_PACKAGE_UNSAFE_ENTRY', '插件包包含未声明的 JavaScript')
    }
  }
}

function isPotentiallyAllowedEntry(name: string): boolean {
  return name === 'manifest.json' || name === 'signature.json' || DOCUMENT_ENTRY.test(name) ||
    ICON_ENTRY.test(name) || JAVASCRIPT_ENTRY.test(name)
}

async function readZipEntries(archive: Buffer): Promise<Map<string, Buffer>> {
  const zip = await openZip(archive)
  return new Promise((resolve, reject) => {
    const entries = new Map<string, Buffer>()
    const caseInsensitiveNames = new Set<string>()
    let unpackedBytes = 0
    let settled = false

    const fail = (error: unknown): void => {
      if (settled) return
      settled = true
      zip.close()
      reject(error)
    }
    zip.once('error', fail)
    zip.on('entry', (entry: Entry) => {
      void (async () => {
        if (isDirectory(entry)) {
          validateDirectoryEntry(entry)
          const foldedName = entry.fileName.toLowerCase()
          if (caseInsensitiveNames.has(foldedName)) {
            throw new PluginSupplyChainError('PLUGIN_PACKAGE_UNSAFE_ENTRY', '插件包包含重复目录')
          }
          caseInsensitiveNames.add(foldedName)
          zip.readEntry()
          return
        }
        validatePluginEntryName(entry.fileName)
        if (isSymbolicLink(entry)) {
          throw new PluginSupplyChainError('PLUGIN_PACKAGE_UNSAFE_ENTRY', '插件包不允许符号链接')
        }
        const foldedName = entry.fileName.toLowerCase()
        if (entries.has(entry.fileName) || caseInsensitiveNames.has(foldedName)) {
          throw new PluginSupplyChainError('PLUGIN_PACKAGE_UNSAFE_ENTRY', '插件包包含重复文件')
        }
        if (entries.size >= MAX_PLUGIN_PACKAGE_ENTRIES) {
          throw new PluginSupplyChainError('PLUGIN_PACKAGE_TOO_LARGE', '插件包文件数量过多')
        }
        if (entry.uncompressedSize > MAX_PLUGIN_UNPACKED_BYTES - unpackedBytes) {
          throw new PluginSupplyChainError('PLUGIN_PACKAGE_TOO_LARGE', '插件包解压后超过 10 MiB')
        }
        const value = await readEntry(zip, entry)
        if (value.length !== entry.uncompressedSize || crc32(value) !== entry.crc32) {
          value.fill(0)
          throw new PluginSupplyChainError('PLUGIN_PACKAGE_INVALID', '插件包文件校验失败')
        }
        unpackedBytes += value.length
        entries.set(entry.fileName, value)
        caseInsensitiveNames.add(foldedName)
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

function openZip(archive: Buffer): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(archive, {
      autoClose: true,
      lazyEntries: true,
      decodeStrings: true,
      validateEntrySizes: true,
      strictFileNames: true
    }, (error, zip) => error || !zip ? reject(error ?? new Error('ZIP 无效')) : resolve(zip))
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
          stream.destroy(new PluginSupplyChainError('PLUGIN_PACKAGE_TOO_LARGE', '插件包文件超过大小限制'))
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

function validateDirectoryEntry(entry: Entry): void {
  if (
    entry.uncompressedSize !== 0 || entry.compressedSize !== 0 ||
    (entry.fileName !== 'entries/' && entry.fileName !== 'icons/') ||
    isSymbolicLink(entry)
  ) {
    throw new PluginSupplyChainError('PLUGIN_PACKAGE_UNSAFE_ENTRY', '插件包包含不安全的目录')
  }
}

function isSymbolicLink(entry: Entry): boolean {
  const platform = entry.versionMadeBy >>> 8
  if (platform !== 3) return false
  const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff
  return (unixMode & 0o170000) === 0o120000
}

function parseSignature(bytes: Uint8Array): PluginPackageSignature {
  const value = parseStrictJson(bytes, '插件签名')
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalidSignature()
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  if (keys.length !== SIGNATURE_KEYS.length || SIGNATURE_KEYS.some((key) => !keys.includes(key))) invalidSignature()
  if (record.algorithm !== 'ed25519' || typeof record.keyId !== 'string' ||
      !/^[a-z0-9](?:[a-z0-9._-]{1,126}[a-z0-9])?$/.test(record.keyId) ||
      typeof record.digest !== 'string' || typeof record.signature !== 'string') invalidSignature()
  parseSha256(record.digest, 'PLUGIN_PACKAGE_INVALID')
  decodeSignature(record.signature, 'PLUGIN_PACKAGE_SIGNATURE_INVALID').fill(0)
  return record as unknown as PluginPackageSignature
}

function parseStrictJson(bytes: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch (error) {
    throw new PluginSupplyChainError('PLUGIN_PACKAGE_INVALID', `${label}不是有效 JSON`, { cause: error })
  }
}

function ensureEd25519Key(key: KeyObject): KeyObject {
  try {
    const publicKey = key.type === 'public' ? key : createPublicKey(key)
    if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('not ed25519')
    return publicKey
  } catch (error) {
    throw new PluginSupplyChainError('PLUGIN_PACKAGE_SIGNATURE_INVALID', '发布者公钥无效', { cause: error })
  }
}

function invalidSignature(): never {
  throw new PluginSupplyChainError('PLUGIN_PACKAGE_SIGNATURE_INVALID', '插件签名文件无效')
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ byte) & 0xff]!
  return (crc ^ 0xffffffff) >>> 0
}
