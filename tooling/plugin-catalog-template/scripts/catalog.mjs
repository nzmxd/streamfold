import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

const DOMAIN = Buffer.from('Streamfold Plugin Catalog v1\0', 'utf8')
const ID = /^[a-z0-9](?:[a-z0-9._-]{1,126}[a-z0-9])?$/
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/
const SHA256 = /^sha256:[a-f0-9]{64}$/
const ENTRY_KEYS = [
  'pluginId', 'version', 'downloadUrl', 'packageHash', 'publisherKeyId',
  'publisherPublicKey', 'minimumAppVersion', 'maximumAppVersion', 'revoked', 'revokedReason'
]
const DAY = 24 * 60 * 60 * 1_000

const [command, input = 'catalog.source.json', output = 'public/catalog.json'] = process.argv.slice(2)

try {
  if (command === 'validate-source') {
    const source = validateSource(await readJson(input))
    process.stdout.write(`catalog source ok (${source.entries.length} entries)\n`)
  } else if (command === 'sign') {
    const source = validateSource(await readJson(input))
    const validityDays = integer(process.env.CATALOG_VALIDITY_DAYS ?? '7', 1, 31, 'CATALOG_VALIDITY_DAYS')
    const generated = new Date()
    const unsigned = {
      schemaVersion: 1,
      generatedAt: generated.toISOString(),
      expiresAt: new Date(generated.getTime() + validityDays * DAY).toISOString(),
      entries: source.entries
    }
    const privateKey = privateEd25519(requiredKey('CATALOG_ROOT_PRIVATE_KEY'))
    const signature = sign(null, Buffer.concat([DOMAIN, canonicalJson(unsigned)]), privateKey).toString('base64')
    const catalog = validateDocument({ ...unsigned, signature }, generated)
    await mkdir(dirname(output), { recursive: true })
    await writeFile(output, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8')
    process.stdout.write(`signed ${output} (${catalog.entries.length} entries; expires ${catalog.expiresAt})\n`)
  } else if (command === 'verify') {
    const catalog = validateDocument(await readJson(input), new Date())
    const unsigned = {
      schemaVersion: catalog.schemaVersion,
      generatedAt: catalog.generatedAt,
      expiresAt: catalog.expiresAt,
      entries: catalog.entries
    }
    const signature = signatureBytes(catalog.signature)
    const publicKey = publicEd25519(requiredKey('CATALOG_ROOT_PUBLIC_KEY'))
    if (!verify(null, Buffer.concat([DOMAIN, canonicalJson(unsigned)]), publicKey, signature)) {
      throw new Error('catalog signature verification failed')
    }
    process.stdout.write(`catalog signature ok (${catalog.entries.length} entries)\n`)
  } else {
    throw new Error('usage: catalog.mjs <validate-source|sign|verify> [input] [output]')
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}

async function readJson(path) {
  const bytes = await readFile(path)
  if (bytes.byteLength === 0 || bytes.byteLength > 2 * 1024 * 1024) throw new Error(`${path}: invalid file size`)
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
}

function validateSource(value) {
  const source = record(value, 'catalog source')
  exactKeys(source, ['schemaVersion', 'entries'], 'catalog source')
  if (source.schemaVersion !== 1) throw new Error('catalog source: unsupported schemaVersion')
  return { schemaVersion: 1, entries: validateEntries(source.entries) }
}

function validateDocument(value, now) {
  const document = record(value, 'catalog')
  exactKeys(document, ['schemaVersion', 'generatedAt', 'expiresAt', 'entries', 'signature'], 'catalog')
  if (document.schemaVersion !== 1) throw new Error('catalog: unsupported schemaVersion')
  const generatedAt = isoDate(document.generatedAt, 'generatedAt')
  const expiresAt = isoDate(document.expiresAt, 'expiresAt')
  const generatedTime = Date.parse(generatedAt)
  const expiresTime = Date.parse(expiresAt)
  if (generatedTime > now.getTime() + 5 * 60_000) throw new Error('catalog: generatedAt is in the future')
  if (expiresTime <= now.getTime()) throw new Error('catalog: expired')
  if (expiresTime <= generatedTime || expiresTime - generatedTime > 31 * DAY) {
    throw new Error('catalog: validity must be greater than zero and no longer than 31 days')
  }
  signatureBytes(document.signature).fill(0)
  return {
    schemaVersion: 1,
    generatedAt,
    expiresAt,
    entries: validateEntries(document.entries),
    signature: document.signature
  }
}

function validateEntries(value) {
  if (!Array.isArray(value) || value.length > 5_000) throw new Error('catalog entries: expected at most 5000 items')
  const seen = new Set()
  return value.map((raw, index) => {
    const entry = record(raw, `entry[${index}]`)
    exactKeys(entry, ENTRY_KEYS, `entry[${index}]`)
    const pluginId = identifier(entry.pluginId, `entry[${index}].pluginId`)
    const version = semver(entry.version, `entry[${index}].version`)
    const identity = `${pluginId}\0${version}`
    if (seen.has(identity)) throw new Error(`entry[${index}]: duplicate plugin version`)
    seen.add(identity)
    if (typeof entry.packageHash !== 'string' || !SHA256.test(entry.packageHash)) {
      throw new Error(`entry[${index}].packageHash: invalid SHA-256`)
    }
    const publisherPublicKey = text(entry.publisherPublicKey, 4_096, `entry[${index}].publisherPublicKey`)
    publicEd25519(publisherPublicKey)
    if (typeof entry.revoked !== 'boolean') throw new Error(`entry[${index}].revoked: expected boolean`)
    const revokedReason = entry.revokedReason === undefined
      ? undefined
      : text(entry.revokedReason, 300, `entry[${index}].revokedReason`)
    if (entry.revoked !== Boolean(revokedReason)) throw new Error(`entry[${index}]: revokedReason must exist only for revoked entries`)
    const minimumAppVersion = semver(entry.minimumAppVersion, `entry[${index}].minimumAppVersion`)
    const maximumAppVersion = entry.maximumAppVersion === undefined
      ? undefined
      : semver(entry.maximumAppVersion, `entry[${index}].maximumAppVersion`)
    if (maximumAppVersion && compareVersions(maximumAppVersion, minimumAppVersion) < 0) {
      throw new Error(`entry[${index}]: invalid app compatibility range`)
    }
    return {
      pluginId,
      version,
      downloadUrl: httpsUrl(entry.downloadUrl, `entry[${index}].downloadUrl`),
      packageHash: entry.packageHash,
      publisherKeyId: identifier(entry.publisherKeyId, `entry[${index}].publisherKeyId`),
      publisherPublicKey,
      minimumAppVersion,
      ...(maximumAppVersion ? { maximumAppVersion } : {}),
      revoked: entry.revoked,
      ...(revokedReason ? { revokedReason } : {})
    }
  })
}

function canonicalJson(value) {
  const visit = (item, seen = new Set()) => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return JSON.stringify(item)
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new Error('canonical JSON contains a non-finite number')
      return JSON.stringify(item)
    }
    if (!item || typeof item !== 'object' || seen.has(item)) throw new Error('canonical JSON contains an invalid value')
    seen.add(item)
    try {
      if (Array.isArray(item)) return `[${item.map((value) => visit(value, seen)).join(',')}]`
      const keys = Object.keys(item).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
      return `{${keys.map((key) => `${JSON.stringify(key)}:${visit(item[key], seen)}`).join(',')}}`
    } finally {
      seen.delete(item)
    }
  }
  return Buffer.from(visit(value), 'utf8')
}

function requiredKey(name) {
  const plain = process.env[name]
  const encoded = process.env[`${name}_BASE64`]
  if (plain && encoded) throw new Error(`set only one of ${name} or ${name}_BASE64`)
  if (plain) return plain.replace(/\\n/g, '\n')
  if (encoded) return Buffer.from(encoded, 'base64').toString('utf8')
  throw new Error(`missing ${name} (or ${name}_BASE64)`)
}

function privateEd25519(value) {
  const key = createPrivateKey(value)
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('catalog root private key must be Ed25519')
  return key
}

function publicEd25519(value) {
  let key
  try {
    key = value.includes('BEGIN PUBLIC KEY')
      ? createPublicKey(value)
      : createPublicKey({ key: Buffer.from(value, 'base64'), format: 'der', type: 'spki' })
  } catch {
    throw new Error('catalog/publisher public key must be Ed25519 PEM or base64 SPKI DER')
  }
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('catalog/publisher public key must be Ed25519')
  return key
}

function signatureBytes(value) {
  if (typeof value !== 'string' || value.length !== 88) throw new Error('catalog signature: invalid base64')
  const bytes = Buffer.from(value, 'base64')
  if (bytes.byteLength !== 64 || bytes.toString('base64') !== value) throw new Error('catalog signature: invalid Ed25519 signature')
  return bytes
}

function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}: expected object`)
  return value
}

function exactKeys(value, allowed, label) {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key))
  if (unknown) throw new Error(`${label}: unknown field ${unknown}`)
}

function identifier(value, label) {
  if (typeof value !== 'string' || !ID.test(value)) throw new Error(`${label}: invalid identifier`)
  return value
}

function semver(value, label) {
  if (typeof value !== 'string' || value.length > 80 || !VERSION.test(value)) throw new Error(`${label}: invalid version`)
  return value
}

function text(value, maximum, label) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${label}: invalid string`)
  }
  return value
}

function isoDate(value, label) {
  const result = text(value, 40, label)
  const date = new Date(result)
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== result) throw new Error(`${label}: expected canonical ISO timestamp`)
  return result
}

function httpsUrl(value, label) {
  const url = new URL(text(value, 2_048, label))
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.hash) {
    throw new Error(`${label}: expected credential-free HTTPS URL without fragment`)
  }
  return url.href
}

function integer(value, minimum, maximum, label) {
  const result = Number(value)
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) throw new Error(`${label}: out of range`)
  return result
}

function compareVersions(left, right) {
  const parse = (value) => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(value)
    return { core: [BigInt(match[1]), BigInt(match[2]), BigInt(match[3])], prerelease: match[4]?.split('.') ?? null }
  }
  const a = parse(left)
  const b = parse(right)
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return a.core[index] < b.core[index] ? -1 : 1
  }
  if (!a.prerelease && !b.prerelease) return 0
  if (!a.prerelease) return 1
  if (!b.prerelease) return -1
  const length = Math.max(a.prerelease.length, b.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const x = a.prerelease[index]
    const y = b.prerelease[index]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    const xn = /^\d+$/.test(x) ? Number(x) : null
    const yn = /^\d+$/.test(y) ? Number(y) : null
    if (xn !== null && yn !== null) return Math.sign(xn - yn)
    if (xn !== null) return -1
    if (yn !== null) return 1
    return x < y ? -1 : 1
  }
  return 0
}
