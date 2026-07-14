import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { PluginCatalogDocument } from '../../shared/plugin-host-contracts'
import {
  assertCatalogEntryInstallable,
  catalogContainsRevocation,
  resolveLatestCompatiblePlugin,
  signPluginCatalog,
  verifyPluginCatalog
} from './plugin-catalog'

const now = new Date('2026-07-14T08:00:00.000Z')

describe('signed plugin catalog', () => {
  it('authenticates the canonical catalog and resolves the newest compatible version', () => {
    const root = generateKeyPairSync('ed25519')
    const publisher = generateKeyPairSync('ed25519')
    const unsigned: Omit<PluginCatalogDocument, 'signature'> = {
      schemaVersion: 1,
      generatedAt: now.toISOString(),
      expiresAt: '2026-07-21T08:00:00.000Z',
      entries: [
        entry(publisher.publicKey, '1.0.0'),
        entry(publisher.publicKey, '1.1.0'),
        { ...entry(publisher.publicKey, '2.0.0'), minimumAppVersion: '0.6.0' }
      ]
    }
    const signed = signPluginCatalog(unsigned, root.privateKey)
    const verified = verifyPluginCatalog(signed, { rootPublicKey: root.publicKey, now })

    expect(resolveLatestCompatiblePlugin(verified, 'example.plugin', '0.5.0'))
      .toMatchObject({ reason: 'available', entry: { version: '1.1.0' } })

    const tampered = structuredClone(signed)
    tampered.entries[0]!.downloadUrl = 'https://attacker.example/plugin.streamfold-plugin'
    expect(() => verifyPluginCatalog(tampered, { rootPublicKey: root.publicKey, now }))
      .toThrowError(expect.objectContaining({ code: 'PLUGIN_CATALOG_SIGNATURE_INVALID' }))
  })

  it('rejects expired catalogs and exposes signed revocation state', () => {
    const root = generateKeyPairSync('ed25519')
    const publisher = generateKeyPairSync('ed25519')
    const revoked = {
      ...entry(publisher.publicKey, '1.0.0'),
      revoked: true,
      revokedReason: '密钥泄露'
    }
    const signed = signPluginCatalog({
      schemaVersion: 1,
      generatedAt: '2026-07-01T00:00:00.000Z',
      expiresAt: '2026-07-10T00:00:00.000Z',
      entries: [revoked]
    }, root.privateKey)

    expect(() => verifyPluginCatalog(signed, { rootPublicKey: root.publicKey, now }))
      .toThrowError(expect.objectContaining({ code: 'PLUGIN_CATALOG_EXPIRED' }))
    expect(catalogContainsRevocation(signed, 'example.plugin', '1.0.0', revoked.packageHash)).toBe(true)
    expect(() => assertCatalogEntryInstallable(revoked))
      .toThrowError(expect.objectContaining({ code: 'PLUGIN_REVOKED' }))
  })

  it('does not silently fall back to a revoked version', () => {
    const publisher = generateKeyPairSync('ed25519')
    const catalog: PluginCatalogDocument = {
      schemaVersion: 1,
      generatedAt: now.toISOString(),
      expiresAt: '2026-07-21T08:00:00.000Z',
      entries: [{
        ...entry(publisher.publicKey, '1.0.0'),
        revoked: true,
        revokedReason: '撤销测试'
      }],
      signature: Buffer.alloc(64).toString('base64')
    }
    expect(resolveLatestCompatiblePlugin(catalog, 'example.plugin', '0.5.0'))
      .toEqual({ entry: null, reason: 'revoked' })
  })
})

function entry(publicKey: ReturnType<typeof generateKeyPairSync>['publicKey'], version: string) {
  return {
    pluginId: 'example.plugin',
    version,
    downloadUrl: `https://plugins.example/${version}.streamfold-plugin`,
    packageHash: `sha256:${'11'.repeat(32)}`,
    publisherKeyId: 'publisher.key',
    publisherPublicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    minimumAppVersion: '0.5.0',
    revoked: false
  }
}
