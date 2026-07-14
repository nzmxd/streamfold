import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as nodeSign,
  timingSafeEqual,
  verify as nodeVerify,
  KeyObject
} from 'node:crypto'
import { PluginSupplyChainError } from './supply-chain-errors'

const HEX_SHA256 = /^[a-f0-9]{64}$/
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

export function sha256(value: Uint8Array): Buffer {
  return createHash('sha256').update(value).digest()
}

export function formatSha256(value: Uint8Array): string {
  return `sha256:${sha256(value).toString('hex')}`
}

export function parseSha256(value: unknown, errorCode: 'PLUGIN_PACKAGE_INVALID' | 'PLUGIN_CATALOG_INVALID'): Buffer {
  if (typeof value !== 'string' || !value.startsWith('sha256:') || !HEX_SHA256.test(value.slice(7))) {
    throw new PluginSupplyChainError(errorCode, 'SHA-256 摘要格式无效')
  }
  return Buffer.from(value.slice(7), 'hex')
}

export function equalSha256(expected: string, bytes: Uint8Array): boolean {
  const expectedBytes = parseSha256(expected, 'PLUGIN_PACKAGE_INVALID')
  const actualBytes = sha256(bytes)
  return timingSafeEqual(expectedBytes, actualBytes)
}

export function decodeSignature(value: unknown, errorCode: 'PLUGIN_PACKAGE_SIGNATURE_INVALID' | 'PLUGIN_CATALOG_SIGNATURE_INVALID'): Buffer {
  if (typeof value !== 'string' || value.length !== 88 || !BASE64.test(value)) {
    throw new PluginSupplyChainError(errorCode, 'Ed25519 签名格式无效')
  }
  const signature = Buffer.from(value, 'base64')
  if (signature.length !== 64 || signature.toString('base64') !== value) {
    signature.fill(0)
    throw new PluginSupplyChainError(errorCode, 'Ed25519 签名格式无效')
  }
  return signature
}

export function readEd25519PublicKey(value: string): KeyObject {
  try {
    const key = value.includes('BEGIN PUBLIC KEY')
      ? createPublicKey(value)
      : createPublicKey({ key: Buffer.from(value, 'base64'), format: 'der', type: 'spki' })
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('not ed25519')
    return key
  } catch (error) {
    throw new PluginSupplyChainError(
      'PLUGIN_PACKAGE_SIGNATURE_INVALID',
      '发布者公钥无效',
      { cause: error }
    )
  }
}

export function verifyEd25519(payload: Uint8Array, signature: Uint8Array, publicKey: KeyObject): boolean {
  return nodeVerify(null, payload, publicKey, signature)
}

/** Used by the catalog publisher and SDK CLI; private keys are never used by the app host. */
export function signEd25519(payload: Uint8Array, privateKey: string | Buffer | KeyObject): string {
  const key = privateKey instanceof KeyObject ? privateKey : createPrivateKey(privateKey)
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('签名密钥必须是 Ed25519')
  return nodeSign(null, payload, key).toString('base64')
}

export function canonicalJson(value: unknown): Buffer {
  return Buffer.from(canonicalize(value), 'utf8')
}

function canonicalize(value: unknown, seen = new Set<object>()): string {
  if (value === null) return 'null'
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('签名数据包含非有限数值')
    return JSON.stringify(value)
  }
  if (!value || typeof value !== 'object') throw new Error('签名数据不是有效 JSON')
  if (seen.has(value)) throw new Error('签名数据包含循环引用')
  seen.add(value)
  try {
    if (Array.isArray(value)) return `[${value.map((item) => canonicalize(item, seen)).join(',')}]`
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      throw new Error('签名数据必须是普通对象')
    }
    const entries = Object.keys(value as Record<string, unknown>)
      .sort(compareUtf8)
      .map((key) => `${JSON.stringify(key)}:${canonicalize((value as Record<string, unknown>)[key], seen)}`)
    return `{${entries.join(',')}}`
  } finally {
    seen.delete(value)
  }
}

export function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
}
