import type {
  PluginAvailability,
  PluginInstallation,
  PluginManifest
} from '../../shared/plugin-contracts'
import { xiaohongshuManagedBrowserAdapter } from '../adapters'
import { SafeImportError } from './errors'

export const GENERIC_FILE_IMPORT_PLUGIN_ID = 'generic-file-import'

export interface PluginDefinition {
  manifest: PluginManifest
  availability: PluginAvailability
  defaultEnabled: boolean
}

function manifest(
  value: PluginManifest
): PluginManifest {
  return Object.freeze({
    ...value,
    capabilities: Object.freeze([...value.capabilities]) as unknown as PluginManifest['capabilities'],
    allowedHosts: Object.freeze([...value.allowedHosts]) as unknown as string[]
  })
}

export const genericFileImportManifest = manifest({
  schemaVersion: 1,
  id: GENERIC_FILE_IMPORT_PLUGIN_ID,
  name: '通用文件导入',
  version: '1.0.0',
  description: '导入用户主动选择的 JSON/CSV 文件，不访问任何远程站点。',
  license: 'builtin',
  source: 'builtin',
  commitHash: 'builtin:generic-file-import@1.0.0',
  mode: 'file_import',
  readOnly: true,
  ownedAccountOnly: true,
  capabilities: ['file.import', 'account.profile', 'content.list', 'content.metrics'],
  allowedHosts: [],
  minimumIntervalSeconds: 0,
  recommendedSyncIntervalHours: 0,
  riskLevel: 'low'
})

const plannedAdapters: PluginManifest[] = [
  {
    id: 'weibo-managed-browser',
    name: '微博管理浏览器适配器',
    description: '微博本人账号的只读管理浏览器适配器（计划中）。',
    allowedHosts: ['weibo.com', 'www.weibo.com', 'passport.weibo.com', 'login.sina.com.cn']
  },
  {
    id: 'douyin-managed-browser',
    name: '抖音管理浏览器适配器',
    description: '抖音本人账号的只读管理浏览器适配器（计划中）。',
    allowedHosts: ['creator.douyin.com', 'www.douyin.com']
  },
  {
    id: 'zhihu-managed-browser',
    name: '知乎管理浏览器适配器',
    description: '知乎本人账号的只读管理浏览器适配器（计划中）。',
    allowedHosts: ['www.zhihu.com']
  }
].map((item) => manifest({
  schemaVersion: 1,
  version: '0.0.0-planned',
  license: 'builtin',
  source: 'builtin',
  commitHash: `planned:${item.id}`,
  mode: 'managed_browser',
  readOnly: true,
  ownedAccountOnly: true,
  capabilities: ['account.profile', 'account.metrics', 'content.list', 'content.metrics'],
  minimumIntervalSeconds: 300,
  recommendedSyncIntervalHours: 24,
  riskLevel: 'medium',
  ...item
}))

const xiaohongshuManagedBrowserManifest = manifest({
  schemaVersion: 1,
  id: xiaohongshuManagedBrowserAdapter.metadata.id,
  name: '小红书登录身份核验',
  version: xiaohongshuManagedBrowserAdapter.metadata.version,
  description: '在已登录的小红书创作中心中只读核验本人身份；当前不读取文章或指标。',
  license: 'builtin',
  source: 'builtin',
  commitHash: `sha256:${xiaohongshuManagedBrowserAdapter.scripts.probe.metadata.sha256}:${xiaohongshuManagedBrowserAdapter.scripts.whoami.metadata.sha256}`,
  mode: 'managed_browser',
  readOnly: true,
  ownedAccountOnly: true,
  capabilities: ['account.identity'],
  allowedHosts: [...xiaohongshuManagedBrowserAdapter.metadata.allowedHosts],
  minimumIntervalSeconds: 60,
  recommendedSyncIntervalHours: 24,
  riskLevel: 'medium'
})

const definitions: readonly PluginDefinition[] = Object.freeze([
  Object.freeze({
    manifest: genericFileImportManifest,
    availability: 'available' as const,
    defaultEnabled: true
  }),
  Object.freeze({
    manifest: xiaohongshuManagedBrowserManifest,
    availability: 'available' as const,
    defaultEnabled: false
  }),
  ...plannedAdapters.map((plannedManifest) => Object.freeze({
    manifest: plannedManifest,
    availability: 'planned' as const,
    defaultEnabled: false
  }))
])

/** Immutable catalog of plugins shipped with the application. */
export class PluginRegistry {
  list(): PluginDefinition[] {
    return definitions.map(cloneDefinition)
  }

  get(id: string): PluginDefinition | null {
    const found = definitions.find((definition) => definition.manifest.id === id)
    return found ? cloneDefinition(found) : null
  }

  isExecutable(id: string): boolean {
    const definition = definitions.find((item) => item.manifest.id === id)
    return definition?.availability === 'available' && definition.manifest.mode === 'file_import'
  }

  requireExecutable(id: string): PluginDefinition {
    const definition = this.get(id)
    if (!definition) {
      throw new SafeImportError('PLUGIN_NOT_FOUND', '插件不存在')
    }
    if (definition.availability !== 'available') {
      throw new SafeImportError('PLUGIN_NOT_AVAILABLE', '该插件尚未开放')
    }
    if (definition.manifest.mode !== 'file_import') {
      throw new SafeImportError('PLUGIN_MODE_NOT_EXECUTABLE', '该插件不支持文件导入')
    }
    return definition
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
