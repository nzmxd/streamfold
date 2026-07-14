import type { Account } from '../../shared/contracts'
import type { AccountAdapterOption, PluginContributionState } from '../../shared/plugin-host-contracts'
import type { PlatformSyncService } from '../platform-sync-service'
import type { JobService } from '../services/job-service'
import type { PluginHostService } from './plugin-host-service'
import type { PluginRuntimeExecutor } from './plugin-runtime-executor'
import { SandboxPlatformAdapter } from './sandbox-platform-adapter'

interface AdapterRepository {
  getAccount(id: string): Account | null
  setAccountAdapterContribution(accountId: string, contributionId: string, expectedContributionId: string | null): Account
  applyManagedIdentity: ConstructorParameters<typeof SandboxPlatformAdapter>[3]['applyManagedIdentity']
  markManagedIdentityMismatch: ConstructorParameters<typeof SandboxPlatformAdapter>[3]['markManagedIdentityMismatch']
  markManagedSyncStarted: ConstructorParameters<typeof SandboxPlatformAdapter>[3]['markManagedSyncStarted']
  markManagedSyncFailed: ConstructorParameters<typeof SandboxPlatformAdapter>[3]['markManagedSyncFailed']
  applyManagedProbeStatus: ConstructorParameters<typeof SandboxPlatformAdapter>[3]['applyManagedProbeStatus']
  commitManagedSync: ConstructorParameters<typeof SandboxPlatformAdapter>[3]['commitManagedSync']
}

interface RegisteredAdapter {
  pluginId: string
  platformId: string
  adapter: SandboxPlatformAdapter
  unregister: () => void
}

interface PlatformAvatarProxy {
  cacheAvatar(input: {
    accountId: string
    contribution: Extract<PluginContributionState['contribution'], { kind: 'platform.adapter' }>
    sourceUrl: string
  }): Promise<{ cacheKey: string; mime: string } | null>
}

/** Reconciles verified QuickJS platform contributions without changing main startup code. */
export class PlatformAdapterRegistryService {
  private readonly adapters = new Map<string, RegisteredAdapter>()

  constructor(
    private readonly repository: AdapterRepository,
    private readonly host: PluginHostService,
    private readonly runtime: PluginRuntimeExecutor,
    private readonly jobs: JobService,
    private readonly router: PlatformSyncService,
    private readonly avatars?: PlatformAvatarProxy
  ) {}

  reconcile(): void {
    const contributions = this.host.listContributions().filter((item) => (
      item.contribution.kind === 'platform.adapter' && item.contribution.runtime === 'quickjs'
    ))
    const expected = new Set(contributions.map((item) => item.contribution.id))
    for (const [id, registered] of this.adapters) {
      if (expected.has(id)) continue
      registered.unregister()
      this.adapters.delete(id)
    }
    for (const state of contributions) {
      const contribution = state.contribution
      if (contribution.kind !== 'platform.adapter' || this.adapters.has(contribution.id)) continue
      const adapter = new SandboxPlatformAdapter(
        state.pluginId,
        contribution.id,
        contribution.platform.id,
        this.repository,
        this.host,
        this.runtime,
        this.jobs,
        undefined,
        this.avatars ? {
          cacheAvatar: (accountId, sourceUrl) => this.avatars!.cacheAvatar({
            accountId,
            contribution,
            sourceUrl
          })
        } : undefined
      )
      this.adapters.set(contribution.id, {
        pluginId: state.pluginId,
        platformId: contribution.platform.id,
        adapter,
        unregister: this.router.registerAdapter(contribution.id, adapter)
      })
    }
  }

  listForAccount(accountId: string): AccountAdapterOption[] {
    const account = this.requireAccount(accountId)
    return this.host.listContributions().flatMap((state) => {
      const contribution = state.contribution
      if (contribution.kind !== 'platform.adapter' || contribution.platform.id !== account.platformId) return []
      return [{
        pluginId: state.pluginId,
        contributionId: contribution.id,
        name: contribution.name,
        description: contribution.description,
        platformId: contribution.platform.id,
        selected: account.adapterContributionId === contribution.id,
        enabled: state.enabled,
        available: state.enabled && state.granted && !state.suspendedReason
      }]
    })
  }

  async switchAdapter(accountId: string, contributionId: string): Promise<Account> {
    const account = this.requireAccount(accountId)
    if (this.router.isAccountActive(accountId)) throw new Error('账号正在同步或核验，请稍候')
    if (!account.remoteId || account.ownershipStatus !== 'plugin_verified') throw new Error('请先核验当前账号身份')
    if (account.adapterContributionId === contributionId) return account
    const target = this.adapters.get(contributionId)
    if (!target || target.platformId !== account.platformId) throw new Error('候选平台适配器不可用')
    const identity = await target.adapter.probeIdentity(accountId)
    if (identity.remoteId !== account.remoteId) {
      throw new Error('候选适配器返回的账号身份与当前绑定身份不一致')
    }
    return this.repository.setAccountAdapterContribution(account.id, contributionId, account.adapterContributionId)
  }

  private requireAccount(id: string): Account {
    const account = this.repository.getAccount(id)
    if (!account) throw new Error('账号不存在')
    return account
  }
}
