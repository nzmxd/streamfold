import { createPublicKey, type KeyObject } from 'node:crypto'
import type {
  PluginCatalogDocument,
  PluginCatalogEntry
} from '../../shared/plugin-host-contracts'
import {
  canonicalJson,
  decodeSignature,
  parseSha256,
  signEd25519,
  verifyEd25519
} from './signing'
import { PluginSupplyChainError } from './supply-chain-errors'

const CATALOG_SIGNATURE_DOMAIN = Buffer.from('Streamfold Plugin Catalog v1\0', 'utf8')
const MAX_CATALOG_BYTES = 2 * 1024 * 1024
const MAX_CATALOG_ENTRIES = 5_000
const MAX_CATALOG_VALIDITY_MS = 31 * 24 * 60 * 60 * 1_000
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1_000
const ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{1,126}[a-z0-9])?$/
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/
const DOCUMENT_KEYS = ['schemaVersion', 'generatedAt', 'expiresAt', 'entries', 'signature'] as const
const ENTRY_KEYS = [
  'pluginId', 'version', 'downloadUrl', 'packageHash', 'publisherKeyId',
  'publisherPublicKey', 'minimumAppVersion', 'maximumAppVersion', 'revoked', 'revokedReason'
] as const

export interface VerifyPluginCatalogOptions {
  rootPublicKey: string | KeyObject
  now?: Date
}

export interface CatalogResolution {
  entry: PluginCatalogEntry | null
  reason: 'available' | 'not_found' | 'revoked' | 'incompatible'
}

export function parseAndVerifyPluginCatalog(
  bytes: Uint8Array,
  options: VerifyPluginCatalogOptions
): PluginCatalogDocument {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > MAX_CATALOG_BYTES) {
    throw new PluginSupplyChainError('PLUGIN_CATALOG_INVALID', '插件目录文件无效或超过 2 MiB')
  }
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch (error) {
    throw new PluginSupplyChainError('PLUGIN_CATALOG_INVALID', '插件目录不是有效 JSON', { cause: error })
  }
  return verifyPluginCatalog(value, options)
}

export function verifyPluginCatalog(
  value: unknown,
  options: VerifyPluginCatalogOptions
): PluginCatalogDocument {
  const catalog = validateCatalogDocument(value)
  const now = options.now ?? new Date()
  const generatedAt = new Date(catalog.generatedAt)
  const expiresAt = new Date(catalog.expiresAt)
  if (generatedAt.getTime() > now.getTime() + MAX_CLOCK_SKEW_MS) {
    throw new PluginSupplyChainError('PLUGIN_CATALOG_INVALID', '插件目录生成时间无效')
  }
  if (expiresAt.getTime() <= now.getTime()) {
    throw new PluginSupplyChainError('PLUGIN_CATALOG_EXPIRED', '插件目录已过期')
  }
  if (expiresAt.getTime() - generatedAt.getTime() > MAX_CATALOG_VALIDITY_MS) {
    throw new PluginSupplyChainError('PLUGIN_CATALOG_INVALID', '插件目录有效期过长')
  }

  const unsigned = { ...catalog, signature: undefined }
  delete unsigned.signature
  let payload: Buffer
  try {
    payload = Buffer.concat([CATALOG_SIGNATURE_DOMAIN, canonicalJson(unsigned)])
  } catch (error) {
    throw new PluginSupplyChainError('PLUGIN_CATALOG_INVALID', '插件目录规范化失败', { cause: error })
  }
  const signature = decodeSignature(catalog.signature, 'PLUGIN_CATALOG_SIGNATURE_INVALID')
  try {
    if (!verifyEd25519(payload, signature, readRootPublicKey(options.rootPublicKey))) {
      throw new PluginSupplyChainError('PLUGIN_CATALOG_SIGNATURE_INVALID', '插件目录签名验证失败')
    }
  } finally {
    signature.fill(0)
  }
  return catalog
}

/** Intended for the separately maintained static catalog publisher. */
export function signPluginCatalog(
  catalog: Omit<PluginCatalogDocument, 'signature'>,
  privateKey: string | Buffer | KeyObject
): PluginCatalogDocument {
  const validated = validateCatalogDocument({ ...catalog, signature: Buffer.alloc(64).toString('base64') })
  const unsigned: Omit<PluginCatalogDocument, 'signature'> = {
    schemaVersion: validated.schemaVersion,
    generatedAt: validated.generatedAt,
    expiresAt: validated.expiresAt,
    entries: validated.entries
  }
  const payload = Buffer.concat([CATALOG_SIGNATURE_DOMAIN, canonicalJson(unsigned)])
  return { ...unsigned, signature: signEd25519(payload, privateKey) }
}

export function findCatalogEntry(
  catalog: PluginCatalogDocument,
  pluginId: string,
  version: string
): PluginCatalogEntry | null {
  return catalog.entries.find((entry) => entry.pluginId === pluginId && entry.version === version) ?? null
}

export function assertCatalogEntryInstallable(entry: PluginCatalogEntry): void {
  if (entry.revoked) {
    throw new PluginSupplyChainError('PLUGIN_REVOKED', entry.revokedReason || '此插件版本已被撤销')
  }
}

export function resolveLatestCompatiblePlugin(
  catalog: PluginCatalogDocument,
  pluginId: string,
  appVersion: string
): CatalogResolution {
  assertVersion(appVersion, '应用版本')
  const candidates = catalog.entries.filter((entry) => entry.pluginId === pluginId)
  if (candidates.length === 0) return { entry: null, reason: 'not_found' }
  const active = candidates.filter((entry) => !entry.revoked)
  if (active.length === 0) return { entry: null, reason: 'revoked' }
  const compatible = active.filter((entry) => isAppVersionCompatible(entry, appVersion))
  if (compatible.length === 0) return { entry: null, reason: 'incompatible' }
  compatible.sort((left, right) => compareSemver(right.version, left.version))
  return { entry: compatible[0] ?? null, reason: 'available' }
}

export function isAppVersionCompatible(
  entry: Pick<PluginCatalogEntry, 'minimumAppVersion' | 'maximumAppVersion'>,
  appVersion: string
): boolean {
  return compareSemver(appVersion, entry.minimumAppVersion) >= 0 &&
    (!entry.maximumAppVersion || compareSemver(appVersion, entry.maximumAppVersion) <= 0)
}

export function catalogContainsRevocation(
  catalog: PluginCatalogDocument,
  pluginId: string,
  version: string,
  packageHash?: string
): boolean {
  return catalog.entries.some((entry) => entry.pluginId === pluginId && entry.version === version &&
    (!packageHash || entry.packageHash === packageHash) && entry.revoked)
}

function validateCatalogDocument(value: unknown): PluginCatalogDocument {
  const record = objectValue(value, '插件目录')
  exactKeys(record, DOCUMENT_KEYS, '插件目录')
  if (record.schemaVersion !== 1) invalidCatalog('插件目录版本不受支持')
  const entries = arrayValue(record.entries, '目录条目')
  if (entries.length > MAX_CATALOG_ENTRIES) invalidCatalog('插件目录条目过多')
  const seen = new Set<string>()
  const normalizedEntries = entries.map((entry) => {
    const normalized = validateCatalogEntry(entry)
    const identity = `${normalized.pluginId}\0${normalized.version}`
    if (seen.has(identity)) invalidCatalog('插件目录包含重复版本')
    seen.add(identity)
    return normalized
  })
  return {
    schemaVersion: 1,
    generatedAt: isoDate(record.generatedAt, '目录生成时间'),
    expiresAt: isoDate(record.expiresAt, '目录过期时间'),
    entries: normalizedEntries,
    signature: signatureValue(record.signature)
  }
}

function validateCatalogEntry(value: unknown): PluginCatalogEntry {
  const record = objectValue(value, '目录条目')
  exactKeys(record, ENTRY_KEYS, '目录条目')
  const pluginId = identifier(record.pluginId, '插件 ID')
  const version = assertVersion(record.version, '插件版本')
  const packageHash = stringValue(record.packageHash, '插件包摘要', 71)
  parseSha256(packageHash, 'PLUGIN_CATALOG_INVALID')
  const publisherPublicKey = stringValue(record.publisherPublicKey, '发布者公钥', 4_096)
  try {
    readRootPublicKey(publisherPublicKey)
  } catch (error) {
    throw new PluginSupplyChainError('PLUGIN_CATALOG_INVALID', '目录中的发布者公钥无效', { cause: error })
  }
  if (typeof record.revoked !== 'boolean') invalidCatalog('撤销状态无效')
  const revokedReason = record.revokedReason === undefined
    ? undefined
    : stringValue(record.revokedReason, '撤销原因', 300)
  if (record.revoked && !revokedReason) invalidCatalog('已撤销版本必须说明原因')
  if (!record.revoked && revokedReason) invalidCatalog('未撤销版本不能包含撤销原因')
  const minimumAppVersion = assertVersion(record.minimumAppVersion, '最低应用版本')
  const maximumAppVersion = record.maximumAppVersion === undefined
    ? undefined
    : assertVersion(record.maximumAppVersion, '最高应用版本')
  if (maximumAppVersion && compareSemver(maximumAppVersion, minimumAppVersion) < 0) {
    invalidCatalog('应用兼容版本范围无效')
  }
  return {
    pluginId,
    version,
    downloadUrl: httpsUrl(record.downloadUrl),
    packageHash,
    publisherKeyId: identifier(record.publisherKeyId, '发布者密钥 ID'),
    publisherPublicKey,
    minimumAppVersion,
    ...(maximumAppVersion ? { maximumAppVersion } : {}),
    revoked: record.revoked,
    ...(revokedReason ? { revokedReason } : {})
  }
}

function readRootPublicKey(value: string | KeyObject): KeyObject {
  try {
    const key = typeof value === 'string'
      ? (value.includes('BEGIN PUBLIC KEY')
          ? createPublicKey(value)
          : createPublicKey({ key: Buffer.from(value, 'base64'), format: 'der', type: 'spki' }))
      : (value.type === 'public' ? value : createPublicKey(value))
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('not ed25519')
    return key
  } catch (error) {
    throw new PluginSupplyChainError('PLUGIN_CATALOG_SIGNATURE_INVALID', '目录根公钥无效', { cause: error })
  }
}

function compareSemver(left: string, right: string): number {
  const leftParts = versionParts(left)
  const rightParts = versionParts(right)
  for (let index = 0; index < 3; index += 1) {
    const leftCore = leftParts.core[index] ?? 0n
    const rightCore = rightParts.core[index] ?? 0n
    if (leftCore !== rightCore) return leftCore < rightCore ? -1 : 1
  }
  if (!leftParts.prerelease && !rightParts.prerelease) return 0
  if (!leftParts.prerelease) return 1
  if (!rightParts.prerelease) return -1
  const length = Math.max(leftParts.prerelease.length, rightParts.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = leftParts.prerelease[index]
    const rightIdentifier = rightParts.prerelease[index]
    if (leftIdentifier === undefined) return -1
    if (rightIdentifier === undefined) return 1
    if (leftIdentifier === rightIdentifier) continue
    const leftNumber = /^\d+$/.test(leftIdentifier) ? Number(leftIdentifier) : null
    const rightNumber = /^\d+$/.test(rightIdentifier) ? Number(rightIdentifier) : null
    if (leftNumber !== null && rightNumber !== null) return Math.sign(leftNumber - rightNumber)
    if (leftNumber !== null) return -1
    if (rightNumber !== null) return 1
    return leftIdentifier < rightIdentifier ? -1 : 1
  }
  return 0
}

function versionParts(value: string): { core: bigint[]; prerelease: string[] | null } {
  const match = VERSION_PATTERN.exec(value)
  if (!match) invalidCatalog('版本号无效')
  return {
    core: [BigInt(match[1]!), BigInt(match[2]!), BigInt(match[3]!)],
    prerelease: match[4] ? match[4].split('.') : null
  }
}

function assertVersion(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length > 80 || !VERSION_PATTERN.test(value)) invalidCatalog(`${label}无效`)
  return value
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalidCatalog(`${label}必须是对象`)
  return value as Record<string, unknown>
}

function arrayValue(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) invalidCatalog(`${label}必须是数组`)
  return value
}

function exactKeys(record: Record<string, unknown>, allowed: readonly string[], label: string): void {
  if (Object.keys(record).some((key) => !allowed.includes(key))) invalidCatalog(`${label}包含未知字段`)
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) invalidCatalog(`${label}无效`)
  return value
}

function stringValue(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    invalidCatalog(`${label}无效`)
  }
  return value
}

function isoDate(value: unknown, label: string): string {
  const text = stringValue(value, label, 40)
  const date = new Date(text)
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== text) invalidCatalog(`${label}无效`)
  return text
}

function httpsUrl(value: unknown): string {
  const text = stringValue(value, '插件下载地址', 2_048)
  let url: URL
  try {
    url = new URL(text)
  } catch {
    invalidCatalog('插件下载地址无效')
  }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.hash) {
    invalidCatalog('插件下载地址必须是无凭证的 HTTPS 地址')
  }
  return url.href
}

function signatureValue(value: unknown): string {
  if (typeof value !== 'string') invalidCatalog('目录签名无效')
  decodeSignature(value, 'PLUGIN_CATALOG_SIGNATURE_INVALID').fill(0)
  return value
}

function invalidCatalog(message: string): never {
  throw new PluginSupplyChainError('PLUGIN_CATALOG_INVALID', message)
}
