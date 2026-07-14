import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SocialDatabase } from '../database'
import { webhookEntrySource, webhookPluginManifest } from './builtin-webhook.test-fixture'
import { PluginEntryResolver, PluginEntryStore } from './plugin-entry-store'
import { PluginHostService } from './plugin-host-service'
import { verifyOfficialWebhookResource } from './official-webhook-resource'
import { OFFICIAL_WEBHOOK_PACKAGE_TRUST } from './official-webhook-trust.generated'

describe('official webhook package resource', () => {
  it('verifies the pinned archive, Ed25519 signature and Manifest v2', async () => {
    const verified = await verifyOfficialWebhookResource(resolve(process.cwd(), 'resources'))

    expect(verified.manifest).toEqual(webhookPluginManifest)
    expect(verified.archiveHash).toBe(OFFICIAL_WEBHOOK_PACKAGE_TRUST.packageHash)
    expect(verified.contentHash).toBe(OFFICIAL_WEBHOOK_PACKAGE_TRUST.contentHash)
    expect(verified.signature?.keyId).toBe('streamfold-official')
    expect(verified.development).toBe(false)
  })

  it('contains the same QuickJS entry as the implementation being migrated', async () => {
    const verified = await verifyOfficialWebhookResource(resolve(process.cwd(), 'resources'))
    const packaged = verified.entries.get('entries/webhook.js')
    expect(packaged).toBeDefined()
    expect(packaged?.toString('utf8').trim()).toBe(webhookEntrySource.trim())
    expect(packaged).toEqual(
      await readFile(resolve(process.cwd(), 'tooling/builtin-plugins/streamfold.webhook/entries/webhook.js'))
    )
  })

  it('rejects a replaced resource before its Manifest can be registered', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'streamfold-official-webhook-'))
    try {
      const plugins = resolve(root, 'plugins')
      await mkdir(plugins)
      const archive = await readFile(resolve(
        process.cwd(),
        'resources/plugins',
        OFFICIAL_WEBHOOK_PACKAGE_TRUST.packageFile
      ))
      const changedByte = Math.floor(archive.length / 2)
      archive[changedByte] = archive[changedByte]! ^ 1
      await writeFile(resolve(plugins, OFFICIAL_WEBHOOK_PACKAGE_TRUST.packageFile), archive)

      await expect(verifyOfficialWebhookResource(root)).rejects.toMatchObject({
        code: 'PLUGIN_PACKAGE_HASH_MISMATCH'
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('stages verified code before the host registers the packaged manifest', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'streamfold-official-webhook-store-'))
    const database = new SocialDatabase(':memory:')
    try {
      const verified = await verifyOfficialWebhookResource(resolve(process.cwd(), 'resources'))
      const entries = new PluginEntryStore(root)
      await entries.stageAndActivate(verified)
      database.upsertPluginPackage(verified.manifest, {
        source: 'builtin',
        status: 'active',
        packageHash: verified.archiveHash,
        publisherKeyId: verified.manifest.publisher.keyId,
        development: false
      })
      const host = new PluginHostService(database, {
        available: () => true,
        encrypt: (value) => value,
        decrypt: (value) => value
      })
      host.initialize()

      expect(host.listPackages()).toContainEqual(expect.objectContaining({
        manifest: expect.objectContaining({ id: 'streamfold.webhook' }),
        source: 'builtin',
        packageHash: verified.archiveHash
      }))
      await expect(new PluginEntryResolver(entries).readEntry(
        verified.manifest.id,
        verified.manifest.version,
        'entries/webhook.js'
      )).resolves.toBe(webhookEntrySource)

      await writeFile(resolve(
        root,
        verified.manifest.id,
        verified.manifest.version,
        'entries/webhook.js'
      ), 'module.exports = { run() { return { tampered: true } } }')
      await expect(entries.stageAndActivate(verified)).rejects.toThrow(
        '已安装插件文件与验证包不一致'
      )
    } finally {
      database.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})
