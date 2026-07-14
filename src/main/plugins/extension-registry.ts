import type {
  PlatformAdapterContribution,
  PluginContribution,
  PluginManifestV2
} from '../../shared/plugin-host-contracts'
import { validatePluginManifestV2 } from '../../shared/plugin-host-contracts'
import { builtinPluginManifestsV2 } from './builtin-manifests'

export interface RegisteredContribution {
  pluginId: string
  pluginVersion: string
  contribution: PluginContribution
}

/** Single source of truth for built-in and verified package contributions. */
export class ExtensionRegistry {
  private readonly manifests = new Map<string, PluginManifestV2>()

  constructor(manifests: readonly PluginManifestV2[] = builtinPluginManifestsV2) {
    for (const manifest of manifests) this.register(manifest)
  }

  register(value: unknown): PluginManifestV2 {
    const manifest = validatePluginManifestV2(value)
    const current = this.manifests.get(manifest.id)
    if (current && current.version !== manifest.version) {
      throw new Error(`插件 ${manifest.id} 已注册其他版本`)
    }
    this.assertPlatformProviders(manifest)
    this.manifests.set(manifest.id, manifest)
    return cloneManifest(manifest)
  }

  unregister(pluginId: string): void {
    this.manifests.delete(pluginId)
  }

  listManifests(): PluginManifestV2[] {
    return [...this.manifests.values()].map(cloneManifest)
  }

  getManifest(pluginId: string): PluginManifestV2 | null {
    const manifest = this.manifests.get(pluginId)
    return manifest ? cloneManifest(manifest) : null
  }

  listContributions(kind?: PluginContribution['kind']): RegisteredContribution[] {
    return [...this.manifests.values()].flatMap((manifest) => manifest.contributions
      .filter((contribution) => kind === undefined || contribution.kind === kind)
      .map((contribution) => ({
        pluginId: manifest.id,
        pluginVersion: manifest.version,
        contribution: structuredClone(contribution)
      })))
  }

  getContribution(contributionId: string): RegisteredContribution | null {
    return this.listContributions().find((item) => item.contribution.id === contributionId) ?? null
  }

  platformDefinitions(): PlatformAdapterContribution['platform'][] {
    const seen = new Set<string>()
    return this.listContributions('platform.adapter').flatMap((item) => {
      const contribution = item.contribution as PlatformAdapterContribution
      if (seen.has(contribution.platform.id)) return []
      seen.add(contribution.platform.id)
      return [structuredClone(contribution.platform)]
    })
  }

  private assertPlatformProviders(candidate: PluginManifestV2): void {
    const installed = this.listContributions('platform.adapter')
    for (const contribution of candidate.contributions) {
      if (contribution.kind !== 'platform.adapter') continue
      if (installed.some((item) => item.contribution.id === contribution.id)) {
        throw new Error(`平台适配器贡献点 ${contribution.id} 已存在`)
      }
      if (contribution.platform.contentUrls.some((item) => (
        !contribution.platform.navigationHosts.includes(new URL(item.origin).hostname.toLowerCase())
      ))) throw new Error(`平台适配器 ${contribution.id} 的原帖来源不在导航域名中`)
      const navigationHosts = new Set(contribution.platform.navigationHosts)
      for (const [label, value] of [
        ['登录地址', contribution.platform.loginUrl],
        ['主页', contribution.platform.homeUrl],
        ...contribution.captures.map((capture) => ['捕获页面', capture.route] as const)
      ] as const) {
        if (!navigationHosts.has(new URL(value).hostname.toLowerCase())) {
          throw new Error(`平台适配器 ${contribution.id} 的${label}不在导航域名中`)
        }
      }
      const existingProvider = installed.find((item) => (
        item.contribution.kind === 'platform.adapter' &&
        item.contribution.platform.id === contribution.platform.id
      ))
      if (existingProvider?.contribution.kind === 'platform.adapter' &&
        platformIdentity(existingProvider.contribution.platform) !== platformIdentity(contribution.platform)) {
        throw new Error(`平台 ${contribution.platform.id} 的公共定义与已安装适配器不一致`)
      }
    }
  }
}

function platformIdentity(platform: PlatformAdapterContribution['platform']): string {
  return JSON.stringify({
    id: platform.id,
    name: platform.name,
    shortName: platform.shortName,
    loginUrl: platform.loginUrl,
    homeUrl: platform.homeUrl,
    navigationHosts: [...platform.navigationHosts].sort(),
    imageHosts: [...platform.imageHosts].sort(),
    contentUrls: structuredClone(platform.contentUrls).sort((left, right) => (
      `${left.origin}${left.pathTemplate}${left.remoteIdTemplate}`.localeCompare(
        `${right.origin}${right.pathTemplate}${right.remoteIdTemplate}`
      )
    ))
  })
}

function cloneManifest(manifest: PluginManifestV2): PluginManifestV2 {
  return structuredClone(manifest)
}
