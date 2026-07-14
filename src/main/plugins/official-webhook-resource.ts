import { join } from 'node:path'
import type { VerifiedPluginPackage } from './plugin-package'
import { verifyPluginPackageFile } from './plugin-package'
import { PluginSupplyChainError } from './supply-chain-errors'
import { OFFICIAL_WEBHOOK_PACKAGE_TRUST } from './official-webhook-trust.generated'

/**
 * Verifies the separately packaged official Webhook resource before it is
 * staged or registered. The trust values are bundled into the main-process
 * ASAR; the plugin archive itself lives under process.resourcesPath/plugins.
 */
export async function verifyOfficialWebhookResource(resourcesRoot: string): Promise<VerifiedPluginPackage> {
  const verified = await verifyPluginPackageFile(
    join(resourcesRoot, 'plugins', OFFICIAL_WEBHOOK_PACKAGE_TRUST.packageFile),
    {
      source: 'catalog',
      publisherPublicKey: OFFICIAL_WEBHOOK_PACKAGE_TRUST.publisherPublicKey,
      expectedArchiveHash: OFFICIAL_WEBHOOK_PACKAGE_TRUST.packageHash,
      expectedPublisherKeyId: OFFICIAL_WEBHOOK_PACKAGE_TRUST.publisherKeyId
    }
  )
  const manifest = verified.manifest
  if (
    manifest.id !== OFFICIAL_WEBHOOK_PACKAGE_TRUST.pluginId ||
    manifest.version !== OFFICIAL_WEBHOOK_PACKAGE_TRUST.version ||
    manifest.publisher.id !== 'streamfold' ||
    manifest.publisher.keyId !== OFFICIAL_WEBHOOK_PACKAGE_TRUST.publisherKeyId ||
    verified.contentHash !== OFFICIAL_WEBHOOK_PACKAGE_TRUST.contentHash ||
    !verified.signature ||
    manifest.contributions.length !== 3 ||
    manifest.contributions.some((contribution) => contribution.runtime !== 'quickjs')
  ) {
    throw new PluginSupplyChainError(
      'PLUGIN_PACKAGE_MANIFEST_INVALID',
      '官方 Webhook 插件与应用内置信任信息不一致'
    )
  }
  return verified
}

export function officialWebhookResourcePath(resourcesRoot: string): string {
  return join(resourcesRoot, 'plugins', OFFICIAL_WEBHOOK_PACKAGE_TRUST.packageFile)
}
