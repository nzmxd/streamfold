<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type {
  Account,
  Group,
  InstalledPluginPackage,
  PluginCatalogState,
  PluginContributionState,
  PluginRunRecord,
  PluginSchedule
} from '../../../../shared/contracts'
import { confirmDialog } from '../../ui/dialog'
import { formatDate, messageOf } from '../shared/format'
import PluginContributionManager from './PluginContributionManager.vue'
import PluginRunHistory from './PluginRunHistory.vue'
import {
  accountsForContribution,
  type PluginManagerSection
} from './plugin-manager-state'
import {
  contributionKindLabel,
  packageCanBeEnabled,
  packageSourceLabel,
  packageStatusLabel,
  packageStatusTone,
  permissionLabel
} from './plugin-presentation'

type PluginView = 'installed' | 'discover' | 'runs' | 'development'

const packages = ref<InstalledPluginPackage[]>([])
const contributions = ref<PluginContributionState[]>([])
const schedules = ref<PluginSchedule[]>([])
const runs = ref<PluginRunRecord[]>([])
const accounts = ref<Account[]>([])
const groups = ref<Group[]>([])
const loading = ref(true)
const refreshing = ref(false)
const error = ref('')
const toast = ref('')
const activeView = ref<PluginView>('installed')
const busyKey = ref('')
const expandedPackageIds = ref<string[]>([])
const selectedContribution = ref<PluginContributionState | null>(null)
const managerSection = ref<PluginManagerSection>('permissions')
const catalog = ref<PluginCatalogState>({ configured: false, refreshedAt: null, expiresAt: null, entries: [], error: '' })
const developerMode = ref(false)

const views: Array<{ id: PluginView; label: string; description: string }> = [
  { id: 'installed', label: '已安装', description: '插件包与贡献点' },
  { id: 'discover', label: '发现', description: '签名插件目录' },
  { id: 'runs', label: '运行记录', description: '执行与错误' },
  { id: 'development', label: '开发插件', description: '本地测试包' }
]

const enabledContributionCount = computed(() => contributions.value.filter((item) => item.enabled).length)
const enabledScheduleCount = computed(() => schedules.value.filter((item) => item.enabled).length)
const failedRunCount = computed(() => runs.value.filter((item) => item.status === 'failed' || item.status === 'interrupted').length)
const updatePackages = computed(() => packages.value.filter((item) => item.updateAvailable))
const catalogPackages = computed(() => packages.value.filter((item) => item.source === 'catalog'))
const developmentPackages = computed(() => packages.value.filter((item) => item.development || item.source === 'local_development'))
const discoverEntries = computed(() => catalog.value.entries
  .filter((entry) => !entry.revoked)
  .filter((entry, index, values) => values.findIndex((candidate) => candidate.pluginId === entry.pluginId) === index))

async function load(showRefreshing = false): Promise<void> {
  if (showRefreshing) refreshing.value = true
  else loading.value = true
  error.value = ''
  try {
    const [nextPackages, nextContributions, nextSchedules, nextRuns, nextAccounts, nextGroups, nextCatalog, nextDeveloper] = await Promise.all([
      window.socialVault.plugins.listPackages(),
      window.socialVault.plugins.listContributions(),
      window.socialVault.plugins.listSchedules(),
      window.socialVault.plugins.listRuns(),
      window.socialVault.accounts.list(),
      window.socialVault.groups.list(),
      window.socialVault.plugins.getCatalog(),
      window.socialVault.plugins.getDeveloperMode()
    ])
    packages.value = nextPackages
    contributions.value = nextContributions
    schedules.value = nextSchedules
    runs.value = nextRuns
    accounts.value = nextAccounts
    groups.value = nextGroups
    catalog.value = nextCatalog
    developerMode.value = nextDeveloper.enabled
    if (expandedPackageIds.value.length === 0) expandedPackageIds.value = nextPackages.map((item) => item.manifest.id)
  } catch (cause) {
    error.value = messageOf(cause)
  } finally {
    loading.value = false
    refreshing.value = false
  }
}

function packageContributions(pluginId: string): PluginContributionState[] {
  return contributions.value.filter((item) => item.pluginId === pluginId)
}

function contributionSchedules(item: PluginContributionState): PluginSchedule[] {
  return schedules.value.filter((schedule) => schedule.pluginId === item.pluginId && schedule.contributionId === item.contribution.id)
}

function isExpanded(pluginId: string): boolean {
  return expandedPackageIds.value.includes(pluginId)
}

function toggleExpanded(pluginId: string): void {
  expandedPackageIds.value = isExpanded(pluginId)
    ? expandedPackageIds.value.filter((id) => id !== pluginId)
    : [...expandedPackageIds.value, pluginId]
}

function replacePackage(updated: InstalledPluginPackage): void {
  const index = packages.value.findIndex((item) => item.manifest.id === updated.manifest.id)
  if (index >= 0) packages.value.splice(index, 1, updated)
}

function replaceContribution(updated: PluginContributionState): void {
  const index = contributions.value.findIndex((item) => (
    item.pluginId === updated.pluginId && item.contribution.id === updated.contribution.id
  ))
  if (index >= 0) contributions.value.splice(index, 1, updated)
  if (selectedContribution.value?.pluginId === updated.pluginId && selectedContribution.value.contribution.id === updated.contribution.id) {
    selectedContribution.value = updated
  }
}

async function togglePackage(plugin: InstalledPluginPackage): Promise<void> {
  if (busyKey.value || !packageCanBeEnabled(plugin)) return
  busyKey.value = `package:${plugin.manifest.id}`
  error.value = ''
  try {
    replacePackage(await window.socialVault.plugins.setPackageEnabled(plugin.manifest.id, !plugin.enabled))
    const [nextContributions, nextSchedules] = await Promise.all([
      window.socialVault.plugins.listContributions(),
      window.socialVault.plugins.listSchedules()
    ])
    contributions.value = nextContributions
    schedules.value = nextSchedules
    showToast(`${plugin.manifest.name}已${plugin.enabled ? '停用' : '启用'}。`)
  } catch (cause) {
    error.value = messageOf(cause)
  } finally {
    busyKey.value = ''
  }
}

async function toggleContribution(item: PluginContributionState): Promise<void> {
  if (busyKey.value) return
  if (!item.enabled && !item.granted) {
    await openManager(item, 'permissions')
    return
  }
  busyKey.value = `contribution:${item.pluginId}:${item.contribution.id}`
  error.value = ''
  try {
    replaceContribution(await window.socialVault.plugins.setContributionEnabled(
      item.pluginId,
      item.contribution.id,
      !item.enabled
    ))
    showToast(`${item.contribution.name}已${item.enabled ? '停用' : '启用'}。`)
  } catch (cause) {
    error.value = messageOf(cause)
  } finally {
    busyKey.value = ''
  }
}

function openManager(item: PluginContributionState, section: PluginManagerSection): void {
  selectedContribution.value = item
  managerSection.value = section
}

function closeManager(): void {
  selectedContribution.value = null
}

function showToast(value: string): void {
  toast.value = value
  window.setTimeout(() => {
    if (toast.value === value) toast.value = ''
  }, 2800)
}

async function refreshCatalog(): Promise<void> {
  if (busyKey.value) return
  busyKey.value = 'catalog'
  error.value = ''
  try {
    catalog.value = await window.socialVault.plugins.refreshCatalog()
    await load(true)
    showToast('插件目录已刷新。')
  } catch (cause) {
    error.value = messageOf(cause)
  } finally {
    busyKey.value = ''
  }
}

async function installCatalog(pluginId: string): Promise<void> {
  if (busyKey.value) return
  busyKey.value = `install:${pluginId}`
  try {
    await window.socialVault.plugins.installFromCatalog(pluginId)
    await load(true)
    showToast('插件已验证并安装。')
  } catch (cause) { error.value = messageOf(cause) } finally { busyKey.value = '' }
}

async function updatePackage(pluginId: string): Promise<void> {
  if (busyKey.value) return
  busyKey.value = `update:${pluginId}`
  try {
    try {
      await window.socialVault.plugins.update(pluginId, false)
    } catch (cause) {
      const message = messageOf(cause)
      if (!message.includes('需要确认后重新授权')) throw cause
      const confirmed = await confirmDialog({
        title: '确认安装权限范围变化的更新？',
        description: '更新完成后，受影响的贡献点和计划会保持暂停；请检查新增权限并重新授权后再启用。',
        confirmLabel: '安装并暂停审核',
        tone: 'warning'
      })
      if (!confirmed) return
      await window.socialVault.plugins.update(pluginId, true)
    }
    await load(true)
    showToast('插件已更新。')
  } catch (cause) { error.value = messageOf(cause) } finally { busyKey.value = '' }
}

async function uninstallPackage(plugin: InstalledPluginPackage): Promise<void> {
  if (plugin.source === 'builtin' || busyKey.value) return
  const confirmed = await confirmDialog({
    title: `卸载“${plugin.manifest.name}”？`,
    description: '插件包、授权、配置和密钥会删除；已同步的账号与内容数据会保留。',
    confirmLabel: '卸载插件', tone: 'warning'
  })
  if (!confirmed) return
  busyKey.value = `uninstall:${plugin.manifest.id}`
  try {
    await window.socialVault.plugins.uninstall(plugin.manifest.id)
    await load(true)
    showToast('插件已卸载。')
  } catch (cause) { error.value = messageOf(cause) } finally { busyKey.value = '' }
}

async function setDevelopmentMode(): Promise<void> {
  if (busyKey.value) return
  busyKey.value = 'developer-mode'
  try {
    developerMode.value = (await window.socialVault.plugins.setDeveloperMode(!developerMode.value)).enabled
  } catch (cause) { error.value = messageOf(cause) } finally { busyKey.value = '' }
}

async function installDevelopment(): Promise<void> {
  if (!developerMode.value || busyKey.value) return
  busyKey.value = 'development-install'
  try {
    const installed = await window.socialVault.plugins.installDevelopment()
    if (installed) { await load(true); showToast('开发插件已安装。') }
  } catch (cause) { error.value = messageOf(cause) } finally { busyKey.value = '' }
}

async function runContribution(item: PluginContributionState): Promise<void> {
  if (busyKey.value) return
  const accountId = item.contribution.kind === 'platform.adapter'
    ? accountsForContribution(item.contribution, accounts.value)[0]?.id
    : undefined
  busyKey.value = `run:${item.pluginId}:${item.contribution.id}`
  try {
    await window.socialVault.plugins.run(item.pluginId, item.contribution.id, accountId)
    runs.value = await window.socialVault.plugins.listRuns()
    showToast('插件试运行已完成。')
  } catch (cause) { error.value = messageOf(cause) } finally { busyKey.value = '' }
}

async function retryRun(run: PluginRunRecord): Promise<void> {
  if (busyKey.value) return
  busyKey.value = `retry:${run.id}`
  try {
    await window.socialVault.plugins.retryRun(run.id)
    runs.value = await window.socialVault.plugins.listRuns()
  } catch (cause) { error.value = messageOf(cause) } finally { busyKey.value = '' }
}

onMounted(() => void load())
</script>

<template>
  <div class="feature-page plugin-page plugin-center-v2">
    <header class="page-header feature-header plugin-header">
      <div>
        <span class="page-eyebrow">扩展与自动化</span>
        <h1>插件中心</h1>
        <p>管理数据适配器、权限范围、自动运行与插件状态</p>
      </div>
      <button class="button plugin-refresh" :disabled="loading || refreshing" @click="load(true)">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5" /><path d="M18.5 9A7 7 0 0 0 6.2 6.2L4 9m16 6-2.2 2.8A7 7 0 0 1 5.5 15" /></svg>
        {{ refreshing ? '正在刷新' : '刷新状态' }}
      </button>
    </header>

    <div v-if="error" class="alert error plugin-alert">
      <span>{{ error }}</span>
      <button type="button" @click="error = ''">关闭</button>
    </div>

    <section class="plugin-overview" aria-label="插件概览">
      <article><span>插件包</span><strong>{{ packages.length }}</strong><small>{{ packages.filter((item) => item.enabled).length }} 个已启用</small></article>
      <article><span>贡献点</span><strong>{{ contributions.length }}</strong><small>{{ enabledContributionCount }} 个正在工作</small></article>
      <article><span>自动计划</span><strong>{{ enabledScheduleCount }}</strong><small>{{ schedules.length }} 个已创建</small></article>
      <article :class="{ attention: failedRunCount > 0 }"><span>异常运行</span><strong>{{ failedRunCount }}</strong><small>当前保存的运行记录</small></article>
    </section>

    <nav class="plugin-view-tabs" role="tablist" aria-label="插件中心视图">
      <button
        v-for="view in views"
        :key="view.id"
        type="button"
        role="tab"
        :aria-selected="activeView === view.id"
        :class="{ active: activeView === view.id }"
        @click="activeView = view.id"
      >
        <strong>{{ view.label }}</strong>
        <small>{{ view.description }}</small>
        <span v-if="view.id === 'installed'">{{ packages.length }}</span>
        <span v-else-if="view.id === 'runs'">{{ runs.length }}</span>
        <span v-else-if="view.id === 'development'">{{ developmentPackages.length }}</span>
        <span v-else>{{ catalogPackages.length }}</span>
      </button>
    </nav>

    <div v-if="loading" class="feature-loading plugin-loading">正在读取插件状态…</div>

    <main v-else class="plugin-view">
      <section v-if="activeView === 'installed'" class="installed-list" aria-label="已安装插件">
        <div v-if="packages.length === 0" class="feature-card feature-empty">
          <span>◇</span><strong>还没有已安装插件</strong><p>内置适配器或经过验证的插件会显示在这里。</p>
        </div>

        <article
          v-for="plugin in packages"
          :key="plugin.manifest.id"
          class="plugin-package-card"
          :class="[`status-${plugin.status}`, { disabled: !plugin.enabled }]"
        >
          <header class="package-header">
            <div class="package-icon" :class="{ development: plugin.development }" aria-hidden="true">
              <svg viewBox="0 0 24 24"><path d="M8.5 4.5 12 2l3.5 2.5 4.2.5.3 4.3 2 3.7-2 3.7-.3 4.3-4.2.5L12 22l-3.5-2.5-4.2-.5-.3-4.3L2 12l2-3.7.3-4.3 4.2-.5Z" /><path d="m9 12 2 2 4-4" /></svg>
            </div>
            <div class="package-heading">
              <div class="package-title-line">
                <h2>{{ plugin.manifest.name }}</h2>
                <span>v{{ plugin.manifest.version }}</span>
              </div>
              <p>{{ plugin.manifest.description }}</p>
              <div class="status-chips">
                <span class="status-chip" :class="`tone-${packageStatusTone(plugin.status)}`">{{ packageStatusLabel(plugin.status) }}</span>
                <span class="status-chip">{{ packageSourceLabel(plugin.source) }}</span>
                <span v-if="plugin.development" class="status-chip tone-warning">开发插件</span>
                <span v-if="plugin.updateAvailable" class="status-chip tone-brand">可更新至 {{ plugin.updateAvailable }}</span>
              </div>
            </div>
            <div class="package-controls">
              <button
                class="switch-control update-switch"
                role="switch"
                :aria-checked="plugin.enabled"
                :aria-label="`${plugin.enabled ? '停用' : '启用'} ${plugin.manifest.name}`"
                :disabled="Boolean(busyKey) || !packageCanBeEnabled(plugin)"
                :class="{ active: plugin.enabled }"
                @click="togglePackage(plugin)"
              ><i></i></button>
              <button class="package-expand" type="button" :aria-expanded="isExpanded(plugin.manifest.id)" @click="toggleExpanded(plugin.manifest.id)">
                <svg viewBox="0 0 24 24" :class="{ open: isExpanded(plugin.manifest.id) }"><path d="m8 10 4 4 4-4" /></svg>
              </button>
            </div>
          </header>

          <div v-if="plugin.status === 'revoked'" class="package-notice danger">
            <strong>此版本已被安全撤销</strong><span>{{ plugin.lastError || '插件进程与自动触发已停止，现有数据和配置仍会保留。' }}</span>
          </div>
          <div v-else-if="plugin.status === 'incompatible'" class="package-notice warning">
            <strong>当前应用版本不兼容</strong><span>{{ plugin.lastError || `需要归页 ${plugin.manifest.minimumAppVersion} 或更高版本。` }}</span>
          </div>
          <div v-else-if="plugin.lastError" class="package-notice danger">
            <strong>插件状态异常</strong><span>{{ plugin.lastError }}</span>
          </div>

          <div v-if="isExpanded(plugin.manifest.id)" class="package-body">
            <div class="package-meta">
              <span>发布者 <strong>{{ plugin.manifest.publisher.name }}</strong></span>
              <span>许可证 <strong>{{ plugin.manifest.license }}</strong></span>
              <span>SDK <strong>{{ plugin.manifest.sdkVersion }}</strong></span>
              <span>更新于 <strong>{{ formatDate(plugin.updatedAt, true) }}</strong></span>
              <button v-if="plugin.updateAvailable" class="button" type="button" :disabled="Boolean(busyKey)" @click="updatePackage(plugin.manifest.id)">安装更新</button>
              <button v-if="plugin.source !== 'builtin'" class="button" type="button" :disabled="Boolean(busyKey)" @click="uninstallPackage(plugin)">卸载</button>
            </div>

            <div class="contribution-list">
              <article v-for="item in packageContributions(plugin.manifest.id)" :key="item.contribution.id" class="contribution-card">
                <div class="contribution-main">
                  <span class="contribution-kind-icon" :data-kind="item.contribution.kind" aria-hidden="true">
                    <svg v-if="item.contribution.kind === 'platform.adapter'" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" /><path d="M4 12h16M12 4a13 13 0 0 1 0 16M12 4a13 13 0 0 0 0 16" /></svg>
                    <svg v-else-if="item.contribution.kind === 'event.handler'" viewBox="0 0 24 24"><path d="M7 8h10M7 12h6M5 3h14a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-6l-4 3v-3H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" /></svg>
                    <svg v-else-if="item.contribution.kind === 'scheduled.task'" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" /><path d="M12 8v4l3 2" /></svg>
                    <svg v-else viewBox="0 0 24 24"><path d="m8 5 8 7-8 7V5Z" /></svg>
                  </span>
                  <div>
                    <div class="contribution-title">
                      <h3>{{ item.contribution.name }}</h3>
                      <span>{{ contributionKindLabel(item.contribution.kind) }}</span>
                      <span v-if="item.contribution.runtime === 'builtin'">可信内置</span>
                      <span v-else>QuickJS 沙箱</span>
                    </div>
                    <p>{{ item.contribution.description }}</p>
                  </div>
                </div>

                <button
                  class="switch-control update-switch contribution-switch"
                  role="switch"
                  :aria-checked="item.enabled"
                  :aria-label="`${item.enabled ? '停用' : '启用'} ${item.contribution.name}`"
                  :disabled="Boolean(busyKey) || !plugin.enabled || plugin.status !== 'active'"
                  :class="{ active: item.enabled }"
                  @click="toggleContribution(item)"
                ><i></i></button>

                <div class="contribution-permissions">
                  <span v-for="permission in item.contribution.permissions" :key="permission">{{ permissionLabel(permission) }}</span>
                </div>

                <div v-if="item.suspendedReason" class="contribution-warning">{{ item.suspendedReason }}</div>

                <footer class="contribution-footer">
                  <div class="contribution-state">
                    <span :class="{ ready: item.granted }"><i></i>{{ item.granted ? '权限已确认' : '等待授权' }}</span>
                    <span v-if="item.contribution.permissions.includes('scheduler.run')">{{ contributionSchedules(item).length }} 个计划</span>
                  </div>
                  <div class="contribution-actions">
                    <button type="button" @click="openManager(item, 'permissions')">权限与范围</button>
                    <button v-if="item.contribution.configSchema" type="button" @click="openManager(item, 'config')">配置</button>
                    <button v-if="item.contribution.permissions.includes('scheduler.run')" type="button" @click="openManager(item, 'schedules')">运行计划</button>
                    <button v-if="item.enabled && item.granted && item.contribution.kind !== 'event.handler'" type="button" :disabled="Boolean(busyKey)" @click="runContribution(item)">试运行</button>
                  </div>
                </footer>
              </article>
            </div>
          </div>
        </article>
      </section>

      <section v-else-if="activeView === 'discover'" class="discover-view">
        <article class="catalog-hero feature-card">
          <div class="catalog-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4 6.5 12 3l8 3.5v11L12 21l-8-3.5v-11Z" /><path d="m4 6.5 8 3.5 8-3.5M12 10v11" /></svg></div>
          <div><span class="page-eyebrow">STREAMFOLD PLUGINS</span><h2>签名插件目录</h2><p>目录索引与插件包通过签名和哈希校验，只展示与当前应用兼容且未被撤销的版本。</p></div>
          <button class="button" type="button" :disabled="Boolean(busyKey) || !catalog.configured" @click="refreshCatalog">{{ busyKey === 'catalog' ? '正在验证…' : '刷新目录' }}</button>
        </article>

        <section v-if="updatePackages.length" class="discover-section">
          <div class="section-title"><div><h2>可用更新</h2><p>更新版本已经由插件目录报告。</p></div><span>{{ updatePackages.length }}</span></div>
          <div class="discovery-grid">
            <article v-for="plugin in updatePackages" :key="plugin.manifest.id" class="discovery-card feature-card">
              <div class="discovery-heading"><span>{{ plugin.manifest.name.slice(0, 1) }}</span><div><h3>{{ plugin.manifest.name }}</h3><p>{{ plugin.manifest.version }} → {{ plugin.updateAvailable }}</p></div></div>
              <div class="status-chips"><span class="status-chip tone-brand">已验证更新</span><span class="status-chip">{{ packageSourceLabel(plugin.source) }}</span></div>
              <p>{{ plugin.manifest.description }}</p>
              <button class="button primary" type="button" :disabled="Boolean(busyKey)" @click="updatePackage(plugin.manifest.id)">安装已验证更新</button>
            </article>
          </div>
        </section>

        <section class="discover-section">
          <div class="section-title"><div><h2>来自目录</h2><p>根签名验证通过且与当前版本兼容的插件。</p></div><span>{{ discoverEntries.length }}</span></div>
          <div v-if="discoverEntries.length" class="discovery-grid">
            <article v-for="entry in discoverEntries" :key="entry.pluginId" class="discovery-card feature-card">
              <div class="discovery-heading"><span>{{ entry.pluginId.slice(0, 1).toUpperCase() }}</span><div><h3>{{ entry.pluginId }}</h3><p>v{{ entry.version }} · {{ entry.publisherKeyId }}</p></div></div>
              <div class="status-chips"><span class="status-chip tone-success">目录签名有效</span><span class="status-chip">兼容 {{ entry.minimumAppVersion }}+</span></div>
              <button v-if="!packages.some((item) => item.manifest.id === entry.pluginId)" class="button primary" type="button" :disabled="Boolean(busyKey)" @click="installCatalog(entry.pluginId)">验证并安装</button>
              <span v-else class="catalog-state">已安装</span>
            </article>
          </div>
          <div v-else class="feature-card feature-empty catalog-empty">
            <span>⌁</span><strong>{{ catalog.configured ? '目录中暂无兼容插件' : '此构建未配置远程目录' }}</strong><p>{{ catalog.error || '仍可使用可信内置插件；开发者模式仅用于本地测试。' }}</p>
          </div>
        </section>
      </section>

      <PluginRunHistory
        v-else-if="activeView === 'runs'"
        :runs="runs"
        :packages="packages"
        :contributions="contributions"
        :accounts="accounts"
        :busy="Boolean(busyKey)"
        @retry="retryRun"
      />

      <section v-else class="development-view">
        <div class="developer-banner feature-card">
          <div class="developer-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m8 9-3 3 3 3m8-6 3 3-3 3M14 5l-4 14" /></svg></div>
          <div><h2>开发插件隔离区</h2><p>本地未签名包会持续标记为开发插件，仅用于调试。其贡献点仍需逐项授权，并在独立沙箱中运行。</p></div>
          <div class="contribution-actions"><button class="button" type="button" :disabled="Boolean(busyKey)" @click="setDevelopmentMode">{{ developerMode ? '关闭开发者模式' : '启用开发者模式' }}</button><button class="button primary" type="button" :disabled="Boolean(busyKey) || !developerMode" @click="installDevelopment">选择本地包</button></div>
        </div>

        <div v-if="developmentPackages.length" class="development-grid">
          <article v-for="plugin in developmentPackages" :key="plugin.manifest.id" class="development-card feature-card">
            <header><div><span class="status-chip tone-warning">开发插件</span><h2>{{ plugin.manifest.name }}</h2><p>{{ plugin.manifest.id }} · v{{ plugin.manifest.version }}</p></div><span class="status-chip" :class="`tone-${packageStatusTone(plugin.status)}`">{{ packageStatusLabel(plugin.status) }}</span></header>
            <dl>
              <div><dt>包哈希</dt><dd :title="plugin.packageHash">{{ plugin.packageHash || '—' }}</dd></div>
              <div><dt>发布密钥</dt><dd>{{ plugin.publisherKeyId || '未签名' }}</dd></div>
              <div><dt>安装时间</dt><dd>{{ formatDate(plugin.installedAt, true) }}</dd></div>
              <div><dt>贡献点</dt><dd>{{ plugin.manifest.contributions.length }} 个</dd></div>
            </dl>
            <div v-if="plugin.lastError" class="package-notice danger"><strong>加载错误</strong><span>{{ plugin.lastError }}</span></div>
            <footer><span>本地开发包的安装与重新加载由开发者模式管理。</span></footer>
          </article>
        </div>
        <div v-else class="feature-card feature-empty"><span>{ }</span><strong>没有本地开发插件</strong><p>启用开发者模式并选择本地插件包后，包来源、哈希和错误状态会显示在这里。</p></div>
      </section>
    </main>

    <PluginContributionManager
      v-if="selectedContribution"
      :key="`${selectedContribution.pluginId}:${selectedContribution.contribution.id}`"
      :contribution="selectedContribution"
      :initial-section="managerSection"
      :accounts="accounts"
      :groups="groups"
      :schedules="schedules"
      @close="closeManager"
      @contribution-updated="replaceContribution"
      @schedules-updated="schedules = $event"
      @toast="showToast"
    />

    <Transition name="plugin-toast"><div v-if="toast" class="toast">{{ toast }}</div></Transition>
  </div>
</template>

<style scoped>
.plugin-center-v2 { gap: 0; }
.plugin-header { min-height: 82px; }
.plugin-refresh { display: inline-flex; align-items: center; gap: 8px; }
.plugin-refresh svg { width: 17px; height: 17px; fill: none; stroke: currentColor; stroke-linecap: round; stroke-linejoin: round; stroke-width: 1.7; }
.plugin-alert { margin-bottom: 12px; }
.plugin-overview { display: grid; flex: 0 0 auto; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
.plugin-overview article { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 2px 12px; padding: 13px 15px; color: var(--text); background: var(--surface); border: 1px solid var(--border); border-radius: 11px; box-shadow: var(--shadow-sm); }
.plugin-overview span { color: var(--text-secondary); font-size: var(--font-secondary); line-height: var(--line-secondary); }
.plugin-overview strong { grid-row: 1 / span 2; grid-column: 2; align-self: center; font-size: var(--font-title); line-height: var(--line-title); }
.plugin-overview small { color: var(--text-tertiary); font-size: var(--font-caption); line-height: var(--line-caption); }
.plugin-overview article.attention strong { color: var(--danger); }
.plugin-view-tabs { display: grid; flex: 0 0 auto; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 6px; margin-top: 13px; padding: 5px; background: var(--surface-subtle); border: 1px solid var(--border); border-radius: 13px; }
.plugin-view-tabs button { position: relative; display: grid; min-width: 0; min-height: 55px; grid-template-columns: minmax(0, 1fr) auto; align-content: center; gap: 1px 10px; padding: 7px 12px; color: var(--text-secondary); background: transparent; border: 1px solid transparent; border-radius: 9px; text-align: left; cursor: pointer; }
.plugin-view-tabs button:hover { color: var(--text); background: color-mix(in srgb, var(--surface) 55%, transparent); }
.plugin-view-tabs button.active { color: var(--text); background: var(--surface); border-color: var(--border); box-shadow: var(--shadow-sm); }
.plugin-view-tabs strong { font-size: var(--font-body); line-height: var(--line-body); }
.plugin-view-tabs small { overflow: hidden; color: var(--text-tertiary); font-size: var(--font-caption); line-height: var(--line-caption); text-overflow: ellipsis; white-space: nowrap; }
.plugin-view-tabs button > span { display: grid; min-width: 24px; height: 24px; grid-row: 1 / span 2; grid-column: 2; place-items: center; padding-inline: 6px; color: var(--text-tertiary); background: var(--surface-subtle); border-radius: 99px; font-size: var(--font-caption); line-height: 24px; }
.plugin-view-tabs button.active > span { color: var(--brand); background: var(--brand-soft); }
.plugin-view { min-height: 0; padding: 12px 1px 24px; }
.installed-list { display: grid; gap: 11px; }
.plugin-package-card { overflow: hidden; color: var(--text); background: var(--surface); border: 1px solid var(--border); border-radius: 14px; box-shadow: var(--shadow-sm); }
.plugin-package-card.status-revoked { border-color: color-mix(in srgb, var(--danger) 34%, var(--border)); }
.plugin-package-card.disabled .package-icon { filter: saturate(.35); opacity: .72; }
.package-header { display: grid; grid-template-columns: 46px minmax(0, 1fr) auto; align-items: start; gap: 13px; padding: 17px 18px; }
.package-icon { display: grid; width: 46px; height: 46px; place-items: center; color: var(--brand); background: var(--brand-soft); border-radius: 13px; }
.package-icon.development { color: var(--warning); background: var(--warning-soft); }
.package-icon svg, .catalog-icon svg, .developer-icon svg { width: 23px; height: 23px; fill: none; stroke: currentColor; stroke-linecap: round; stroke-linejoin: round; stroke-width: 1.6; }
.package-heading { min-width: 0; }
.package-title-line { display: flex; min-width: 0; align-items: baseline; gap: 8px; }
.package-title-line h2 { overflow: hidden; font-size: var(--font-section); line-height: var(--line-section); text-overflow: ellipsis; white-space: nowrap; }
.package-title-line > span { color: var(--text-tertiary); font-size: var(--font-caption); line-height: var(--line-caption); }
.package-heading > p { margin-top: 3px; color: var(--text-secondary); font-size: var(--font-secondary); line-height: var(--line-secondary); }
.status-chips { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 8px; }
.status-chip { display: inline-flex; min-height: 24px; align-items: center; padding: 3px 8px; color: var(--text-secondary); background: var(--surface-subtle); border: 1px solid var(--border); border-radius: 99px; font-size: var(--font-caption); line-height: var(--line-caption); }
.status-chip.tone-success { color: var(--success); background: var(--success-soft); border-color: color-mix(in srgb, var(--success) 25%, var(--border)); }
.status-chip.tone-warning { color: var(--warning); background: var(--warning-soft); border-color: color-mix(in srgb, var(--warning) 25%, var(--border)); }
.status-chip.tone-danger { color: var(--danger); background: var(--danger-soft); border-color: color-mix(in srgb, var(--danger) 25%, var(--border)); }
.status-chip.tone-brand { color: var(--brand); background: var(--brand-soft); border-color: color-mix(in srgb, var(--brand) 25%, var(--border)); }
.package-controls { display: flex; align-items: center; gap: 8px; }
.package-expand { display: grid; width: 34px; height: 34px; place-items: center; padding: 0; color: var(--text-tertiary); background: transparent; border: 0; border-radius: 8px; cursor: pointer; }
.package-expand:hover { color: var(--text); background: var(--surface-hover); }
.package-expand svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-linecap: round; stroke-linejoin: round; stroke-width: 1.8; transition: transform .16s ease; }
.package-expand svg.open { transform: rotate(180deg); }
.package-notice { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 5px 10px; margin: 0 18px 14px 77px; padding: 9px 11px; border: 1px solid; border-radius: 9px; font-size: var(--font-secondary); line-height: var(--line-secondary); }
.package-notice strong { white-space: nowrap; }
.package-notice.warning { color: var(--warning); background: var(--warning-soft); border-color: color-mix(in srgb, var(--warning) 28%, var(--border)); }
.package-notice.danger { color: var(--danger); background: var(--danger-soft); border-color: color-mix(in srgb, var(--danger) 28%, var(--border)); }
.package-body { padding: 0 18px 18px; }
.package-meta { display: flex; flex-wrap: wrap; gap: 6px 20px; padding: 10px 12px; color: var(--text-tertiary); background: var(--surface-subtle); border: 1px solid var(--border); border-radius: 9px; font-size: var(--font-caption); line-height: var(--line-caption); }
.package-meta strong { color: var(--text-secondary); font-weight: 600; }
.contribution-list { display: grid; gap: 8px; margin-top: 9px; }
.contribution-card { position: relative; display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px 16px; padding: 14px; background: color-mix(in srgb, var(--surface-subtle) 48%, var(--surface)); border: 1px solid var(--border); border-radius: 11px; }
.contribution-main { display: grid; min-width: 0; grid-template-columns: 35px minmax(0, 1fr); align-items: start; gap: 10px; }
.contribution-kind-icon { display: grid; width: 35px; height: 35px; place-items: center; color: var(--brand); background: var(--brand-soft); border-radius: 9px; }
.contribution-kind-icon svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-linecap: round; stroke-linejoin: round; stroke-width: 1.6; }
.contribution-title { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; }
.contribution-title h3 { margin-right: 3px; font-size: var(--font-body); line-height: var(--line-body); }
.contribution-title span { padding: 2px 6px; color: var(--text-tertiary); background: var(--surface); border: 1px solid var(--border); border-radius: 5px; font-size: var(--font-caption); line-height: var(--line-caption); }
.contribution-main p { margin-top: 3px; color: var(--text-secondary); font-size: var(--font-secondary); line-height: var(--line-secondary); }
.contribution-switch { align-self: center; }
.contribution-permissions { display: flex; grid-column: 1 / -1; flex-wrap: wrap; gap: 5px; padding-left: 45px; }
.contribution-permissions span { padding: 3px 7px; color: var(--text-secondary); background: var(--surface); border: 1px solid var(--border); border-radius: 6px; font-size: var(--font-caption); line-height: var(--line-caption); }
.contribution-warning { grid-column: 1 / -1; margin-left: 45px; padding: 7px 9px; color: var(--warning); background: var(--warning-soft); border-radius: 7px; font-size: var(--font-caption); line-height: var(--line-caption); }
.contribution-footer { display: flex; grid-column: 1 / -1; align-items: center; justify-content: space-between; gap: 12px; padding-top: 10px; border-top: 1px solid var(--border); }
.contribution-state, .contribution-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.contribution-state span { display: inline-flex; align-items: center; gap: 5px; color: var(--text-tertiary); font-size: var(--font-caption); line-height: var(--line-caption); }
.contribution-state i { width: 7px; height: 7px; background: var(--warning); border-radius: 50%; }
.contribution-state span.ready i { background: var(--success); }
.contribution-actions button { padding: 5px 8px; color: var(--brand); background: transparent; border: 0; border-radius: 6px; cursor: pointer; font-size: var(--font-secondary); line-height: var(--line-secondary); }
.contribution-actions button:hover { background: var(--brand-soft); }
.discover-view, .development-view { display: grid; gap: 13px; }
.catalog-hero { display: grid; grid-template-columns: 54px minmax(0, 1fr) auto; align-items: center; gap: 15px; padding: 19px; }
.catalog-icon, .developer-icon { display: grid; width: 54px; height: 54px; place-items: center; color: var(--brand); background: var(--brand-soft); border-radius: 15px; }
.catalog-hero h2, .developer-banner h2 { margin-top: 3px; font-size: var(--font-title); line-height: var(--line-title); }
.catalog-hero p, .developer-banner p { margin-top: 4px; color: var(--text-secondary); font-size: var(--font-secondary); line-height: var(--line-secondary); }
.catalog-state, .developer-banner > span { padding: 7px 10px; color: var(--text-secondary); background: var(--surface-subtle); border: 1px solid var(--border); border-radius: 99px; font-size: var(--font-caption); line-height: var(--line-caption); white-space: nowrap; }
.discover-section { display: grid; gap: 9px; }
.section-title { display: flex; align-items: end; justify-content: space-between; gap: 10px; padding: 0 3px; }
.section-title h2 { font-size: var(--font-section); line-height: var(--line-section); }
.section-title p { margin-top: 2px; color: var(--text-tertiary); font-size: var(--font-caption); line-height: var(--line-caption); }
.section-title > span { color: var(--text-tertiary); font-size: var(--font-caption); line-height: var(--line-caption); }
.discovery-grid, .development-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.discovery-card { display: grid; gap: 9px; padding: 15px; }
.discovery-heading { display: grid; grid-template-columns: 38px minmax(0, 1fr); align-items: center; gap: 10px; }
.discovery-heading > span { display: grid; width: 38px; height: 38px; place-items: center; color: var(--brand); background: var(--brand-soft); border-radius: 10px; font-weight: 700; }
.discovery-heading h3 { font-size: var(--font-body); line-height: var(--line-body); }
.discovery-heading p, .discovery-card > p { color: var(--text-secondary); font-size: var(--font-secondary); line-height: var(--line-secondary); }
.discovery-card > small { color: var(--text-tertiary); font-size: var(--font-caption); line-height: var(--line-caption); }
.catalog-empty { min-height: 190px; }
.developer-banner { display: grid; grid-template-columns: 54px minmax(0, 1fr) auto; align-items: center; gap: 15px; padding: 18px; }
.developer-icon { color: var(--warning); background: var(--warning-soft); }
.development-card { display: grid; gap: 12px; padding: 16px; }
.development-card > header { display: flex; align-items: start; justify-content: space-between; gap: 12px; }
.development-card h2 { margin-top: 7px; font-size: var(--font-section); line-height: var(--line-section); }
.development-card header p { margin-top: 2px; color: var(--text-tertiary); font-size: var(--font-caption); line-height: var(--line-caption); }
.development-card dl { display: grid; gap: 6px; margin: 0; }
.development-card dl div { display: grid; grid-template-columns: 86px minmax(0, 1fr); gap: 8px; font-size: var(--font-secondary); line-height: var(--line-secondary); }
.development-card dt { color: var(--text-tertiary); }
.development-card dd { margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.development-card .package-notice { margin: 0; }
.development-card footer { color: var(--text-tertiary); font-size: var(--font-caption); line-height: var(--line-caption); }
.plugin-loading { flex: 1; }
.plugin-toast-enter-active, .plugin-toast-leave-active { transition: opacity .16s ease, transform .16s ease; }
.plugin-toast-enter-from, .plugin-toast-leave-to { opacity: 0; transform: translateY(6px); }
@media (max-width: 1120px) {
  .plugin-overview { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .discovery-grid, .development-grid { grid-template-columns: 1fr; }
}
@media (max-width: 960px) {
  .plugin-view-tabs button { grid-template-columns: minmax(0, 1fr) auto; }
  .plugin-view-tabs small { display: none; }
  .plugin-view-tabs button > span { grid-row: 1; }
}
</style>
