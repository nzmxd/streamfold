import { join } from 'node:path'
import type { VerifiedPluginPackage } from './plugin-package'
import { verifyPluginPackageFile } from './plugin-package'
import { PluginSupplyChainError } from './supply-chain-errors'
import { OFFICIAL_WEBHOOK_PACKAGE_TRUST } from './official-webhook-trust.generated'
import { OFFICIAL_X_PACKAGE_TRUST } from './official-x-trust.generated'

export interface OfficialPluginPackageTrust {
  readonly pluginId: string
  readonly version: string
  readonly packageFile: string
  readonly packageHash: string
  readonly contentHash: string
  readonly publisherKeyId: string
  readonly publisherPublicKey: string
}

export interface OfficialPluginResourceDescriptor {
  readonly label: string
  readonly publisherId: string
  readonly trust: OfficialPluginPackageTrust
  readonly contributionIds: readonly string[]
}

export interface OfficialPluginEntryStager {
  stageAndActivate(pluginPackage: VerifiedPluginPackage): Promise<void>
}

export const OFFICIAL_WEBHOOK_RESOURCE_DESCRIPTOR: OfficialPluginResourceDescriptor = Object.freeze({
  label: 'Webhook',
  publisherId: 'streamfold',
  trust: OFFICIAL_WEBHOOK_PACKAGE_TRUST,
  contributionIds: Object.freeze([
    'streamfold.webhook.test',
    'streamfold.webhook.events',
    'streamfold.webhook.schedule'
  ])
})

export const OFFICIAL_X_RESOURCE_DESCRIPTOR: OfficialPluginResourceDescriptor = Object.freeze({
  label: 'X',
  publisherId: 'streamfold',
  trust: OFFICIAL_X_PACKAGE_TRUST,
  contributionIds: Object.freeze(['streamfold.x.platform'])
})

/** The fixed, main-process trust list for separately packaged builtin plugins. */
export const OFFICIAL_PLUGIN_RESOURCE_DESCRIPTORS: readonly OfficialPluginResourceDescriptor[] = Object.freeze([
  OFFICIAL_WEBHOOK_RESOURCE_DESCRIPTOR,
  OFFICIAL_X_RESOURCE_DESCRIPTOR
])

export async function verifyOfficialPluginResource(
  resourcesRoot: string,
  descriptor: OfficialPluginResourceDescriptor
): Promise<VerifiedPluginPackage> {
  const { trust } = descriptor
  const verified = await verifyPluginPackageFile(officialPluginResourcePath(resourcesRoot, descriptor), {
    source: 'catalog',
    publisherPublicKey: trust.publisherPublicKey,
    expectedArchiveHash: trust.packageHash,
    expectedPublisherKeyId: trust.publisherKeyId
  })
  const manifest = verified.manifest
  const contributionIds = manifest.contributions.map((contribution) => contribution.id).sort()
  const expectedContributionIds = [...descriptor.contributionIds].sort()
  if (
    manifest.id !== trust.pluginId ||
    manifest.version !== trust.version ||
    manifest.publisher.id !== descriptor.publisherId ||
    manifest.publisher.keyId !== trust.publisherKeyId ||
    verified.contentHash !== trust.contentHash ||
    !verified.signature ||
    contributionIds.length !== expectedContributionIds.length ||
    contributionIds.some((id, index) => id !== expectedContributionIds[index]) ||
    manifest.contributions.some((contribution) => contribution.runtime !== 'quickjs')
  ) {
    throw new PluginSupplyChainError(
      'PLUGIN_PACKAGE_MANIFEST_INVALID',
      `官方 ${descriptor.label} 插件与应用内置信任信息不一致`
    )
  }
  return verified
}

/** Verifies every archive before returning any package to the caller. */
export async function verifyOfficialPluginResources(
  resourcesRoot: string
): Promise<readonly VerifiedPluginPackage[]> {
  return Object.freeze(await Promise.all(
    OFFICIAL_PLUGIN_RESOURCE_DESCRIPTORS.map((descriptor) =>
      verifyOfficialPluginResource(resourcesRoot, descriptor)
    )
  ))
}

/** Verifies the complete trust list first, then stages the packages in fixed order. */
export async function verifyAndStageOfficialPluginResources(
  resourcesRoot: string,
  stager: OfficialPluginEntryStager
): Promise<readonly VerifiedPluginPackage[]> {
  const verified = await verifyOfficialPluginResources(resourcesRoot)
  for (const pluginPackage of verified) await stager.stageAndActivate(pluginPackage)
  return verified
}

export function officialPluginResourcePath(
  resourcesRoot: string,
  descriptor: OfficialPluginResourceDescriptor
): string {
  return join(resourcesRoot, 'plugins', descriptor.trust.packageFile)
}

export function officialPluginPackageById(
  packages: readonly VerifiedPluginPackage[],
  pluginId: string
): VerifiedPluginPackage {
  const pluginPackage = packages.find((item) => item.manifest.id === pluginId)
  if (!pluginPackage) throw new Error(`未找到已验证的官方插件：${pluginId}`)
  return pluginPackage
}
