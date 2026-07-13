import type {
  PluginAvailability,
  PluginInstallation,
  PluginManifest
} from '../../shared/plugin-contracts'
import { XIAOHONGSHU_API_PLUGIN_ID } from '../xiaohongshu-api-service'

export interface PluginDefinition {
  manifest: PluginManifest
  availability: PluginAvailability
  defaultEnabled: boolean
}

function manifest(value: PluginManifest): PluginManifest {
  return Object.freeze({
    ...value,
    capabilities: Object.freeze([...value.capabilities]) as unknown as PluginManifest['capabilities'],
    allowedHosts: Object.freeze([...value.allowedHosts]) as unknown as string[]
  })
}

export const xiaohongshuSessionApiManifest = manifest({
  schemaVersion: 1,
  id: XIAOHONGSHU_API_PLUGIN_ID,
  name: '小红书数据同步',
  version: '0.1.0',
  description: '使用当前账号的登录会话，同步本人资料、作品和统计指标。',
  license: 'builtin',
  source: 'builtin',
  commitHash: 'builtin:xiaohongshu-session-api@0.1.0+opencli-b0f84c99',
  mode: 'session_api',
  readOnly: true,
  ownedAccountOnly: true,
  capabilities: ['account.identity', 'account.profile', 'account.metrics', 'content.list', 'content.metrics'],
  allowedHosts: ['creator.xiaohongshu.com'],
  minimumIntervalSeconds: 60,
  recommendedSyncIntervalHours: 24,
  riskLevel: 'high'
})

const plannedAdapters: PluginManifest[] = [
  {
    id: 'weibo-session-api',
    name: '微博数据同步',
    description: '微博账号数据同步功能（计划中）。',
    allowedHosts: ['weibo.com', 'www.weibo.com', 'passport.weibo.com', 'login.sina.com.cn']
  },
  {
    id: 'douyin-session-api',
    name: '抖音数据同步',
    description: '抖音账号数据同步功能（计划中）。',
    allowedHosts: ['creator.douyin.com', 'www.douyin.com']
  },
  {
    id: 'zhihu-session-api',
    name: '知乎数据同步',
    description: '知乎账号数据同步功能（计划中）。',
    allowedHosts: ['www.zhihu.com']
  }
].map((item) => manifest({
  schemaVersion: 1,
  version: '0.0.0-planned',
  license: 'builtin',
  source: 'builtin',
  commitHash: `planned:${item.id}`,
  mode: 'session_api',
  readOnly: true,
  ownedAccountOnly: true,
  capabilities: ['account.identity', 'account.profile', 'account.metrics', 'content.list', 'content.metrics'],
  minimumIntervalSeconds: 300,
  recommendedSyncIntervalHours: 24,
  riskLevel: 'high',
  ...item
}))

const definitions: readonly PluginDefinition[] = Object.freeze([
  Object.freeze({
    manifest: xiaohongshuSessionApiManifest,
    availability: 'available' as const,
    defaultEnabled: false
  }),
  ...plannedAdapters.map((plannedManifest) => Object.freeze({
    manifest: plannedManifest,
    availability: 'planned' as const,
    defaultEnabled: false
  }))
])

/** Immutable catalog: platform adapters only. File import plugins are intentionally unsupported. */
export class PluginRegistry {
  list(): PluginDefinition[] {
    return definitions.map(cloneDefinition)
  }

  get(id: string): PluginDefinition | null {
    const found = definitions.find((definition) => definition.manifest.id === id)
    return found ? cloneDefinition(found) : null
  }

  toInstallations(
    state: ReadonlyMap<string, Partial<Omit<PluginInstallation, 'manifest' | 'availability'>>> = new Map()
  ): PluginInstallation[] {
    return this.list().map((definition) => {
      const stored = state.get(definition.manifest.id)
      const canEnable = definition.availability === 'available'
      return {
        manifest: definition.manifest,
        availability: definition.availability,
        enabled: canEnable && (stored?.enabled ?? definition.defaultEnabled),
        installedAt: stored?.installedAt ?? null,
        lastRunAt: stored?.lastRunAt ?? null,
        successCount: stored?.successCount ?? 0,
        failureCount: stored?.failureCount ?? 0,
        lastError: stored?.lastError ?? ''
      }
    })
  }
}

function cloneDefinition(definition: PluginDefinition): PluginDefinition {
  return {
    manifest: {
      ...definition.manifest,
      capabilities: [...definition.manifest.capabilities],
      allowedHosts: [...definition.manifest.allowedHosts]
    },
    availability: definition.availability,
    defaultEnabled: definition.defaultEnabled
  }
}
