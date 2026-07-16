import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  OFFICIAL_PLUGIN_RESOURCE_DESCRIPTORS,
  officialPluginPackageById,
  verifyAndStageOfficialPluginResources,
  verifyOfficialPluginResources
} from './official-plugin-resources'

describe('official plugin package resources', () => {
  it('verifies every package in the fixed trust list', async () => {
    const verified = await verifyOfficialPluginResources(resolve(process.cwd(), 'resources'))

    expect(OFFICIAL_PLUGIN_RESOURCE_DESCRIPTORS.map((item) => item.trust.pluginId)).toEqual([
      'streamfold.webhook',
      'streamfold.x'
    ])
    expect(verified.map((item) => item.manifest.id)).toEqual(
      OFFICIAL_PLUGIN_RESOURCE_DESCRIPTORS.map((item) => item.trust.pluginId)
    )
    for (const descriptor of OFFICIAL_PLUGIN_RESOURCE_DESCRIPTORS) {
      const pluginPackage = officialPluginPackageById(verified, descriptor.trust.pluginId)
      expect(pluginPackage.archiveHash).toBe(descriptor.trust.packageHash)
      expect(pluginPackage.contentHash).toBe(descriptor.trust.contentHash)
      expect(pluginPackage.signature?.keyId).toBe(descriptor.trust.publisherKeyId)
      expect(pluginPackage.development).toBe(false)
    }
  })

  it('verifies the complete list before staging any package', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'streamfold-official-plugins-'))
    try {
      const plugins = resolve(root, 'plugins')
      await mkdir(plugins)
      for (const descriptor of OFFICIAL_PLUGIN_RESOURCE_DESCRIPTORS) {
        const archive = await readFile(resolve(
          process.cwd(),
          'resources/plugins',
          descriptor.trust.packageFile
        ))
        await writeFile(resolve(plugins, descriptor.trust.packageFile), archive)
      }
      const replaced = OFFICIAL_PLUGIN_RESOURCE_DESCRIPTORS.at(-1)!
      const archive = await readFile(resolve(plugins, replaced.trust.packageFile))
      archive[Math.floor(archive.length / 2)]! ^= 1
      await writeFile(resolve(plugins, replaced.trust.packageFile), archive)
      const staged: string[] = []

      await expect(verifyAndStageOfficialPluginResources(root, {
        async stageAndActivate(pluginPackage) {
          staged.push(pluginPackage.manifest.id)
        }
      })).rejects.toMatchObject({ code: 'PLUGIN_PACKAGE_HASH_MISMATCH' })
      expect(staged).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('stages verified packages in descriptor order', async () => {
    const staged: string[] = []
    const verified = await verifyAndStageOfficialPluginResources(resolve(process.cwd(), 'resources'), {
      async stageAndActivate(pluginPackage) {
        staged.push(pluginPackage.manifest.id)
      }
    })

    expect(staged).toEqual(OFFICIAL_PLUGIN_RESOURCE_DESCRIPTORS.map((item) => item.trust.pluginId))
    expect(verified.map((item) => item.manifest.id)).toEqual(staged)
  })
})
