import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { PluginManifestV2 } from '../../shared/plugin-host-contracts'
import {
  createPluginPackageSignature,
  digestPluginEntries,
  MAX_PLUGIN_PACKAGE_BYTES,
  validatePluginEntryName,
  verifyPluginPackage
} from './plugin-package'
import { formatSha256, signEd25519 } from './signing'

const manifest: PluginManifestV2 = {
  schemaVersion: 2,
  id: 'example.plugin',
  name: 'Example',
  version: '1.0.0',
  description: 'Example plugin',
  license: 'MIT',
  publisher: { id: 'example.publisher', name: 'Example Publisher', keyId: 'publisher.key' },
  minimumAppVersion: '0.5.0',
  sdkVersion: '1.0.0',
  contributions: [{
    id: 'example.action',
    kind: 'action',
    name: 'Example action',
    description: 'Runs an example action',
    entry: 'entries/action.js',
    runtime: 'quickjs',
    permissions: [],
    placements: ['plugin-center']
  }]
}

describe('plugin package verification', () => {
  it('verifies a signed package and produces a stable content digest', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const unsigned = new Map<string, Uint8Array>([
      ['entries/action.js', Buffer.from('module.exports = { run() { return true } }')],
      ['manifest.json', Buffer.from(JSON.stringify(manifest))],
      ['README.md', Buffer.from('# Example')]
    ])
    const signature = createPluginPackageSignature(
      unsigned,
      manifest.publisher.keyId,
      (payload) => signEd25519(payload, privateKey)
    )
    const entries = new Map(unsigned)
    entries.set('signature.json', Buffer.from(JSON.stringify(signature)))
    const archive = createStoredZip(entries)

    const verified = await verifyPluginPackage(archive, {
      source: 'catalog',
      expectedArchiveHash: formatSha256(archive),
      expectedPublisherKeyId: manifest.publisher.keyId,
      publisherPublicKey: publicKey.export({ format: 'pem', type: 'spki' }).toString()
    })

    expect(verified.manifest.id).toBe('example.plugin')
    expect(verified.contentHash).toBe(signature.digest)
    expect(verified.development).toBe(false)
    expect(digestPluginEntries(new Map([...unsigned].reverse())))
      .toEqual(digestPluginEntries(unsigned))
  })

  it('allows an unsigned local development package but marks it as development', async () => {
    const archive = createStoredZip(new Map([
      ['manifest.json', Buffer.from(JSON.stringify(manifest))],
      ['entries/action.js', Buffer.from('module.exports = { run() { return null } }')]
    ]))
    const verified = await verifyPluginPackage(archive, { source: 'local_development' })
    expect(verified.signature).toBeNull()
    expect(verified.development).toBe(true)
  })

  it('rejects tampering, traversal, symlinks and native executables', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const unsigned = new Map<string, Uint8Array>([
      ['manifest.json', Buffer.from(JSON.stringify(manifest))],
      ['entries/action.js', Buffer.from('module.exports = { run() { return 1 } }')]
    ])
    const signature = createPluginPackageSignature(
      unsigned,
      manifest.publisher.keyId,
      (payload) => signEd25519(payload, privateKey)
    )
    const tampered = new Map(unsigned)
    tampered.set('entries/action.js', Buffer.from('module.exports = { run() { return 2 } }'))
    tampered.set('signature.json', Buffer.from(JSON.stringify(signature)))
    await expect(verifyPluginPackage(createStoredZip(tampered), {
      source: 'catalog',
      publisherPublicKey: publicKey.export({ format: 'pem', type: 'spki' }).toString()
    })).rejects.toMatchObject({ code: 'PLUGIN_PACKAGE_HASH_MISMATCH' })

    await expect(verifyPluginPackage(createStoredZip(new Map([
      ['../manifest.json', Buffer.from('{}')]
    ])), { source: 'local_development' })).rejects.toMatchObject({
      code: 'PLUGIN_PACKAGE_UNSAFE_ENTRY'
    })

    const symlinkArchive = createStoredZip(new Map([
      ['manifest.json', Buffer.from(JSON.stringify(manifest))],
      ['entries/action.js', Buffer.from('target')]
    ]), { symlink: 'entries/action.js' })
    await expect(verifyPluginPackage(symlinkArchive, { source: 'local_development' }))
      .rejects.toMatchObject({ code: 'PLUGIN_PACKAGE_UNSAFE_ENTRY' })

    expect(() => validatePluginEntryName('entries/native.node')).toThrowError(
      expect.objectContaining({ code: 'PLUGIN_PACKAGE_UNSAFE_ENTRY' })
    )
  })

  it('enforces the archive size limit before ZIP parsing', async () => {
    await expect(verifyPluginPackage(Buffer.alloc(MAX_PLUGIN_PACKAGE_BYTES + 1), {
      source: 'local_development'
    })).rejects.toMatchObject({ code: 'PLUGIN_PACKAGE_TOO_LARGE' })
  })
})

function createStoredZip(
  values: ReadonlyMap<string, Uint8Array>,
  options: { symlink?: string } = {}
): Buffer {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let offset = 0
  for (const [name, rawValue] of values) {
    const nameBytes = Buffer.from(name)
    const value = Buffer.from(rawValue)
    const crc = crc32(value)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x800, 6)
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
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(value.length, 20)
    central.writeUInt32LE(value.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    const mode = options.symlink === name ? 0o120777 : 0o100644
    central.writeUInt32LE((mode << 16) >>> 0, 38)
    central.writeUInt32LE(offset, 42)
    centralParts.push(central, nameBytes)
    offset += local.length + nameBytes.length + value.length
  }
  const centralDirectory = Buffer.concat(centralParts)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(values.size, 8)
  end.writeUInt16LE(values.size, 10)
  end.writeUInt32LE(centralDirectory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...localParts, centralDirectory, end])
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}
