import { generateKeyPairSync, sign as nodeSign } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  InstalledPluginPackage,
  PluginCatalogDocument,
  PluginCatalogEntry,
  PluginManifestV2
} from '../../shared/plugin-host-contracts'
import { signPluginCatalog } from './plugin-catalog'
import type { PluginEntryStore } from './plugin-entry-store'
import type { PluginHostService } from './plugin-host-service'
import { PluginLifecycleService } from './plugin-lifecycle-service'
import { createPluginPackageSignature } from './plugin-package'
import { PublicHttpsBroker } from './public-https-broker'
import { formatSha256 } from './signing'

const now = new Date('2026-07-14T08:00:00.000Z')
const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('PluginLifecycleService', () => {
  it('stops a catalog package when its exact version and hash are signed as revoked', async () => {
    const root = generateKeyPairSync('ed25519')
    const publisher = generateKeyPairSync('ed25519')
    const current = installedPackage(manifest('1.0.0'), 'catalog')
    const repository = new FakeLifecycleRepository([current])
    const catalog = signedCatalog(root.privateKey, [{
      ...catalogEntry(publisher.publicKey, '1.0.0', current.packageHash),
      revoked: true,
      revokedReason: '发布密钥泄露'
    }])
    const cachePath = temporaryFile('catalog.json', Buffer.from(JSON.stringify(catalog)))
    const fixture = lifecycleFixture({ repository, cachePath, rootPublicKey: publicKey(root.publicKey) })

    await fixture.service.initialize()

    expect(repository.getInstalledPluginPackage(current.manifest.id)).toMatchObject({
      status: 'revoked',
      lastError: '此插件版本已被签名目录撤销'
    })
    expect(fixture.terminatePlugin).toHaveBeenCalledWith(current.manifest.id)
    expect(fixture.service.getCatalog()).toMatchObject({ configured: true, expiresAt: catalog.expiresAt })
  })

  it('keeps the previous verified version active when a staged update fails verification', async () => {
    const root = generateKeyPairSync('ed25519')
    const publisher = generateKeyPairSync('ed25519')
    const current = installedPackage(manifest('1.0.0'), 'catalog')
    const repository = new FakeLifecycleRepository([current])
    const entry = catalogEntry(publisher.publicKey, '1.1.0', `sha256:${'22'.repeat(32)}`)
    const catalog = signedCatalog(root.privateKey, [entry])
    const cachePath = temporaryFile('catalog.json', Buffer.from(JSON.stringify(catalog)))
    const body = Buffer.from('not a plugin package')
    const network = {
      download: vi.fn(async () => ({ status: 200, body, contentType: 'application/octet-stream' }))
    } as unknown as PublicHttpsBroker
    const fixture = lifecycleFixture({
      repository,
      cachePath,
      rootPublicKey: publicKey(root.publicKey),
      network
    })
    await fixture.service.initialize()

    await expect(fixture.service.update('example.plugin')).rejects.toBeInstanceOf(Error)

    expect(repository.getInstalledPluginPackage('example.plugin')).toMatchObject({
      manifest: { version: '1.0.0' },
      status: 'active',
      packageHash: current.packageHash
    })
    expect(fixture.entries.stageAndActivate).not.toHaveBeenCalled()
    expect(fixture.host.registerVerifiedPackage).not.toHaveBeenCalled()
    expect(body.every((byte) => byte === 0)).toBe(true)
  })

  it('requires explicit developer mode, installs an unsigned local package, and removes its code on uninstall', async () => {
    const repository = new FakeLifecycleRepository()
    const archive = createStoredZip(new Map([
      ['manifest.json', Buffer.from(JSON.stringify(manifest('1.0.0')))],
      ['entries/action.js', Buffer.from('module.exports = { run() { return null } }')]
    ]))
    const packagePath = temporaryFile('example.streamfold-plugin', archive)
    const fixture = lifecycleFixture({ repository, chooseDevelopmentPackage: async () => packagePath })

    await expect(fixture.service.installDevelopment()).rejects.toThrow('开发者模式')
    fixture.service.setDeveloperMode(true)
    await expect(fixture.service.installDevelopment()).resolves.toMatchObject({
      source: 'local_development',
      development: true,
      manifest: { id: 'example.plugin', version: '1.0.0' }
    })

    expect(fixture.entries.stageAndActivate).toHaveBeenCalledOnce()
    expect(fixture.entries.readEntry).toHaveBeenCalledWith('example.plugin', '1.0.0', 'entries/action.js')
    expect(fixture.host.registerVerifiedPackage).toHaveBeenCalledOnce()

    await fixture.service.uninstall('example.plugin')
    expect(repository.getInstalledPluginPackage('example.plugin')).toBeNull()
    expect(fixture.host.unregisterPackage).toHaveBeenCalledWith('example.plugin')
    expect(fixture.entries.removePlugin).toHaveBeenCalledWith('example.plugin')
  })

  it('never allows a development package or catalog package to replace a builtin plugin', async () => {
    const builtin = installedPackage(manifest('1.0.0'), 'builtin')
    const repository = new FakeLifecycleRepository([builtin])
    const archive = createStoredZip(new Map([
      ['manifest.json', Buffer.from(JSON.stringify(manifest('2.0.0')))],
      ['entries/action.js', Buffer.from('module.exports = { run() { return null } }')]
    ]))
    const packagePath = temporaryFile('override.streamfold-plugin', archive)
    const fixture = lifecycleFixture({ repository, chooseDevelopmentPackage: async () => packagePath })
    fixture.service.setDeveloperMode(true)

    await expect(fixture.service.installDevelopment()).rejects.toThrow('不能覆盖内置插件')
    await expect(fixture.service.uninstall('example.plugin')).rejects.toThrow('内置插件不能卸载')
    expect(fixture.entries.stageAndActivate).not.toHaveBeenCalled()
  })

  it('requires confirmation and suspends the contribution when an update expands permissions', async () => {
    const root = generateKeyPairSync('ed25519')
    const publisher = generateKeyPairSync('ed25519')
    const current = installedPackage(manifest('1.0.0'), 'catalog')
    const next = manifest('1.1.0')
    next.contributions[0]!.permissions = ['network.https']
    const signed = signedPluginArchive(next, publisher.privateKey)
    const repository = new FakeLifecycleRepository([current])
    const catalog = signedCatalog(root.privateKey, [
      catalogEntry(publisher.publicKey, next.version, formatSha256(signed))
    ])
    const network = {
      download: vi.fn(async () => ({
        status: 200,
        body: Buffer.from(signed),
        contentType: 'application/octet-stream'
      }))
    } as unknown as PublicHttpsBroker
    const fixture = lifecycleFixture({
      repository,
      cachePath: temporaryFile('catalog.json', Buffer.from(JSON.stringify(catalog))),
      rootPublicKey: publicKey(root.publicKey),
      network
    })
    await fixture.service.initialize()

    await expect(fixture.service.update(next.id)).rejects.toThrow('需要确认后重新授权')
    expect(fixture.entries.stageAndActivate).not.toHaveBeenCalled()

    await expect(fixture.service.update(next.id, true)).resolves.toMatchObject({
      manifest: { version: '1.1.0' },
      status: 'active'
    })
    expect(repository.suspendPluginContributions).toHaveBeenCalledWith(
      next.id,
      ['example.action'],
      '插件更新扩大了权限或安全边界，请重新确认授权'
    )
  })
})

class FakeLifecycleRepository {
  private readonly packages = new Map<string, InstalledPluginPackage>()
  private readonly settings = new Map<string, unknown>()

  constructor(packages: InstalledPluginPackage[] = []) {
    for (const item of packages) this.packages.set(item.manifest.id, structuredClone(item))
  }

  listInstalledPluginPackages(): InstalledPluginPackage[] {
    return structuredClone([...this.packages.values()])
  }

  getInstalledPluginPackage(pluginId: string): InstalledPluginPackage | null {
    const value = this.packages.get(pluginId)
    return value ? structuredClone(value) : null
  }

  upsertPluginPackage(
    value: PluginManifestV2,
    options: {
      source: 'catalog' | 'local_development'
      status: 'active'
      packageHash: string
      publisherKeyId: string
      enabled?: boolean
      development?: boolean
    }
  ): InstalledPluginPackage {
    const previous = this.packages.get(value.id)
    const installed: InstalledPluginPackage = {
      manifest: structuredClone(value),
      source: options.source,
      status: options.status,
      enabled: options.enabled ?? false,
      packageHash: options.packageHash,
      publisherKeyId: options.publisherKeyId,
      installedAt: previous?.installedAt ?? now.toISOString(),
      updatedAt: now.toISOString(),
      lastError: '',
      updateAvailable: null,
      development: options.development ?? false
    }
    this.packages.set(value.id, installed)
    return structuredClone(installed)
  }

  setPluginPackageStatus(pluginId: string, status: 'active' | 'revoked' | 'failed', error = ''): InstalledPluginPackage {
    const value = this.packages.get(pluginId)!
    Object.assign(value, { status, lastError: error, updatedAt: now.toISOString() })
    return structuredClone(value)
  }

  setPluginUpdateAvailable(pluginId: string, version: string | null): void {
    const value = this.packages.get(pluginId)
    if (value) value.updateAvailable = version
  }

  readonly suspendPluginContributions = vi.fn()
  removePluginPackage(pluginId: string): void { this.packages.delete(pluginId) }
  getSetting<T>(key: string): T | null { return (this.settings.get(key) as T | undefined) ?? null }
  setSetting(key: string, value: unknown): void { this.settings.set(key, structuredClone(value)) }
}

function lifecycleFixture(options: {
  repository: FakeLifecycleRepository
  cachePath?: string
  rootPublicKey?: string
  network?: PublicHttpsBroker
  chooseDevelopmentPackage?: () => Promise<string | null>
}) {
  const entries = {
    stageAndActivate: vi.fn(async () => undefined),
    readEntry: vi.fn(async () => 'module.exports = {}'),
    removePlugin: vi.fn(async () => undefined)
  }
  const host = {
    registerVerifiedPackage: vi.fn(),
    unregisterPackage: vi.fn()
  }
  const terminatePlugin = vi.fn()
  const service = new PluginLifecycleService({
    repository: options.repository,
    host: host as unknown as PluginHostService,
    entries: entries as unknown as PluginEntryStore,
    catalogUrl: 'https://plugins.example/catalog.json',
    catalogRootPublicKey: options.rootPublicKey ?? '',
    catalogCachePath: options.cachePath ?? temporaryPath('catalog.json'),
    appVersion: '0.5.0',
    terminatePlugin,
    chooseDevelopmentPackage: options.chooseDevelopmentPackage ?? (async () => null),
    ...(options.network ? { network: options.network } : {}),
    clock: () => now
  })
  return { service, entries, host, terminatePlugin }
}

function installedPackage(
  value: PluginManifestV2,
  source: InstalledPluginPackage['source']
): InstalledPluginPackage {
  return {
    manifest: value,
    source,
    status: 'active',
    enabled: true,
    packageHash: `sha256:${'11'.repeat(32)}`,
    publisherKeyId: value.publisher.keyId,
    installedAt: now.toISOString(),
    updatedAt: now.toISOString(),
    lastError: '',
    updateAvailable: null,
    development: source === 'local_development'
  }
}

function manifest(version: string): PluginManifestV2 {
  return {
    schemaVersion: 2,
    id: 'example.plugin',
    name: 'Example',
    version,
    description: 'Example plugin',
    license: 'MIT',
    publisher: { id: 'example.publisher', name: 'Example', keyId: 'publisher.key' },
    minimumAppVersion: '0.5.0',
    sdkVersion: '1.0.0',
    contributions: [{
      id: 'example.action',
      kind: 'action',
      name: 'Example action',
      description: 'Runs an action',
      entry: 'entries/action.js',
      runtime: 'quickjs',
      permissions: [],
      placements: ['plugin-center']
    }]
  }
}

function signedCatalog(
  privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'],
  entries: PluginCatalogEntry[]
): PluginCatalogDocument {
  return signPluginCatalog({
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    expiresAt: '2026-07-21T08:00:00.000Z',
    entries
  }, privateKey)
}

function catalogEntry(
  publisherKey: ReturnType<typeof generateKeyPairSync>['publicKey'],
  version: string,
  packageHash: string
): PluginCatalogEntry {
  return {
    pluginId: 'example.plugin',
    version,
    downloadUrl: `https://plugins.example/${version}.streamfold-plugin`,
    packageHash,
    publisherKeyId: 'publisher.key',
    publisherPublicKey: publicKey(publisherKey),
    minimumAppVersion: '0.5.0',
    revoked: false
  }
}

function publicKey(key: ReturnType<typeof generateKeyPairSync>['publicKey']): string {
  return key.export({ format: 'der', type: 'spki' }).toString('base64')
}

function temporaryPath(name: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'streamfold-lifecycle-'))
  directories.push(directory)
  return join(directory, name)
}

function temporaryFile(name: string, bytes: Uint8Array): string {
  const path = temporaryPath(name)
  writeFileSync(path, bytes)
  return path
}

function createStoredZip(values: ReadonlyMap<string, Uint8Array>): Buffer {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let offset = 0
  for (const [name, rawValue] of values) {
    const nameBytes = Buffer.from(name)
    const value = Buffer.from(rawValue)
    const checksum = crc32(value)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x800, 6)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(value.length, 18)
    local.writeUInt32LE(value.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    localParts.push(local, nameBytes, value)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE((3 << 8) | 20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x800, 8)
    central.writeUInt32LE(checksum, 16)
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
  end.writeUInt16LE(values.size, 8)
  end.writeUInt16LE(values.size, 10)
  end.writeUInt32LE(centralDirectory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...localParts, centralDirectory, end])
}

function signedPluginArchive(
  value: PluginManifestV2,
  privateKey: ReturnType<typeof generateKeyPairSync>['privateKey']
): Buffer {
  const entries = new Map<string, Uint8Array>([
    ['manifest.json', Buffer.from(JSON.stringify(value))],
    ['entries/action.js', Buffer.from('module.exports = { run() { return null } }')]
  ])
  const signature = createPluginPackageSignature(
    entries,
    value.publisher.keyId,
    (payload) => nodeSign(null, payload, privateKey).toString('base64')
  )
  entries.set('signature.json', Buffer.from(JSON.stringify(signature)))
  return createStoredZip(entries)
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}
