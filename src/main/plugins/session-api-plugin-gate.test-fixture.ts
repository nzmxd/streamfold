import type { SocialDatabase } from '../database'
import { MANUAL_COLLECTION_INTERVAL_MINUTES_CONFIG_KEY } from './builtin-manifests'
import { PluginHostService } from './plugin-host-service'
import type { PluginSecretStore } from './plugin-secret-store'
import type { SessionApiPluginGate } from './session-api-plugin-gate'

/** Test-only gate that exercises the Manifest v2 package, grant and contribution checks. */
export class TestSessionApiPluginGate implements SessionApiPluginGate {
  readonly host: PluginHostService
  private enabled = false

  constructor(
    private readonly database: SocialDatabase,
    private readonly pluginId: string
  ) {
    const secrets = {
      available: () => true,
      encrypt: (value: string) => value,
      decrypt: (value: string) => value
    } as PluginSecretStore
    this.host = new PluginHostService(database, secrets)
    this.host.initialize()
  }

  enable(): void {
    this.host.setPackageEnabled(this.pluginId, true)
    this.enabled = true
  }

  configureManualCollectionInterval(minutes: number): void {
    const installed = this.database.getInstalledPluginPackage(this.pluginId)
    const contribution = installed?.manifest.contributions.find((item) => item.kind === 'platform.adapter')
    if (!contribution) throw new Error('测试平台适配器不存在')
    this.host.saveConfig({
      pluginId: this.pluginId,
      contributionId: contribution.id,
      values: { [MANUAL_COLLECTION_INTERVAL_MINUTES_CONFIG_KEY]: minutes }
    })
  }

  requireEnabledSessionApi(id: string, accountId?: string): {
    manualCollectionIntervalSeconds: number
  } {
    if (id !== this.pluginId || !this.enabled) {
      throw new Error('请先在插件中心启用该平台的数据同步')
    }
    if (accountId) this.authorize(accountId)
    return this.host.requireEnabledSessionApi(id, accountId)
  }

  recordSessionApiRun(id: string, succeeded: boolean, error = ''): void {
    this.host.recordSessionApiRun(id, succeeded, error)
  }

  private authorize(accountId: string): void {
    const installed = this.database.getInstalledPluginPackage(this.pluginId)
    const contribution = installed?.manifest.contributions.find((item) => item.kind === 'platform.adapter')
    if (!contribution) throw new Error('测试平台适配器不存在')
    this.host.grant({
      pluginId: this.pluginId,
      contributionId: contribution.id,
      permissions: [...contribution.permissions],
      accountIds: [accountId],
      groupIds: [],
      dataScopes: [],
      networkOrigins: []
    })
    this.host.setContributionEnabled(this.pluginId, contribution.id, true)
  }
}
