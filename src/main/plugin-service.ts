import type { PluginInstallation, PluginManifest } from '../shared/contracts'
import { PluginRegistry } from './plugins/registry'

interface PluginDatabase {
  getPluginState(id: string): PluginInstallation | null
  upsertPluginState(
    manifest: PluginManifest,
    patch?: Partial<Omit<PluginInstallation, 'manifest'>>
  ): PluginInstallation
  setPluginEnabled(id: string, enabled: boolean): PluginInstallation
}

export class PluginService {
  constructor(
    private readonly database: PluginDatabase,
    private readonly registry = new PluginRegistry()
  ) {}

  initialize(): void {
    for (const definition of this.registry.list()) {
      const current = this.database.getPluginState(definition.manifest.id)
      this.database.upsertPluginState(definition.manifest, {
        availability: definition.availability,
        ...(definition.availability !== 'available' ? {
          enabled: false,
          installedAt: null
        } : current ? {} : {
          enabled: definition.availability === 'available' && definition.defaultEnabled,
          installedAt: new Date().toISOString()
        })
      })
    }
  }

  list(): PluginInstallation[] {
    return this.registry.list().map((definition) => {
      const state = this.database.getPluginState(definition.manifest.id)
      if (!state) throw new Error('插件注册状态尚未初始化')
      return state
    })
  }

  setEnabled(id: string, enabled: boolean): PluginInstallation {
    const definition = this.registry.get(id)
    if (!definition) throw new Error('插件不存在')
    if (definition.availability !== 'available') throw new Error('计划中的插件不能启用')
    return this.database.setPluginEnabled(id, enabled)
  }

  requireEnabledManagedBrowser(id: string): PluginInstallation {
    const definition = this.registry.get(id)
    if (!definition || definition.availability !== 'available' || definition.manifest.mode !== 'managed_browser') {
      throw new Error('该平台身份核验插件尚不可用')
    }
    const state = this.database.getPluginState(id)
    if (!state?.enabled) throw new Error('请先在插件中心启用该平台的身份核验插件')
    return state
  }

  recordManagedRun(id: string, succeeded: boolean, error = ''): PluginInstallation {
    const definition = this.registry.get(id)
    const current = this.database.getPluginState(id)
    if (!definition || !current || definition.manifest.mode !== 'managed_browser') {
      throw new Error('平台身份核验插件不存在')
    }
    return this.database.upsertPluginState(definition.manifest, {
      lastRunAt: new Date().toISOString(),
      successCount: current.successCount + (succeeded ? 1 : 0),
      failureCount: current.failureCount + (succeeded ? 0 : 1),
      lastError: succeeded ? '' : error.slice(0, 300)
    })
  }
}
