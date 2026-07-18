<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { SessionApiIdentityCheckResult } from '../../shared/session-api-contracts'
import AppDialogHost from './components/AppDialogHost.vue'
import AppSidebar, { type AppSection } from './components/AppSidebar.vue'
import AppTitlebar from './components/AppTitlebar.vue'
import AccountCenter from './features/accounts/AccountCenter.vue'
import AnalyticsCenter from './features/analytics/AnalyticsCenter.vue'
import ContentCenter from './features/content/ContentCenter.vue'
import DashboardCenter from './features/dashboard/DashboardCenter.vue'
import LogCenter from './features/logs/LogCenter.vue'
import PluginCenter from './features/plugins/PluginCenter.vue'
import SettingsCenter from './features/settings/SettingsCenter.vue'
import TaskCenter from './features/tasks/TaskCenter.vue'
import { messageOf } from './features/shared/format'
import { disposeUpdater, initializeUpdater, useUpdater } from './features/updater/useUpdater'
import { confirmDialog } from './ui/dialog'
import { createSidebarState } from './ui/sidebar-state'

const section = ref<AppSection>('dashboard')
const sidebar = createSidebarState()
const sidebarCollapsed = sidebar.collapsed
const toggleSidebar = sidebar.toggle
const updater = useUpdater()
const updateState = updater.state
const updaterReady = updater.ready
const promptedUpdateStorageKey = 'streamfold:update-prompted-version'
let promptedUpdateVersion = readPromptedUpdateVersion()
let removeNavigationListener: (() => void) | null = null
let removeIdentityPreviewListener: (() => void) | null = null
const activeIdentityCandidates = new Set<string>()

watch(updateState, (state) => {
  const version = state.availableVersion
  if (state.phase !== 'downloaded' || !version || promptedUpdateVersion === version) return
  promptedUpdateVersion = version
  rememberPromptedUpdateVersion(version)
  void promptDownloadedUpdate(version)
})

function readPromptedUpdateVersion(): string | null {
  try {
    return window.localStorage.getItem(promptedUpdateStorageKey)
  } catch {
    return null
  }
}

function rememberPromptedUpdateVersion(version: string): void {
  try {
    window.localStorage.setItem(promptedUpdateStorageKey, version)
  } catch {
    // The in-memory guard still prevents duplicate prompts for this window.
  }
}

async function promptDownloadedUpdate(version: string): Promise<void> {
  const confirmed = await confirmDialog({
    title: `归页 v${version} 已准备好`,
    description: '更新包已经下载完成，可以立即重启应用并完成安装。',
    details: ['应用会关闭，并在安装完成后重新打开'],
    confirmLabel: '立即重启并安装',
    cancelLabel: '稍后'
  })
  if (!confirmed) return
  try {
    await updater.restartAndInstall()
  } catch {
    section.value = 'settings'
  }
}

async function promptIdentityBinding(candidate: SessionApiIdentityCheckResult): Promise<void> {
  if (candidate.status !== 'confirmation_required' || !candidate.confirmationToken ||
      !candidate.remoteId || !candidate.remoteName) return
  const candidateKey = `${candidate.accountId}:${candidate.remoteId}`
  if (activeIdentityCandidates.has(candidateKey)) return
  activeIdentityCandidates.add(candidateKey)
  try {
    const confirmed = await confirmDialog({
      title: '绑定当前登录账号？',
      description: '后台监听已读取到当前登录身份。确认后会重新读取一次最新资料，再完成本地账号绑定。',
      details: [`昵称：${candidate.remoteName}`, `账号 ID：${candidate.remoteId}`],
      confirmLabel: '确认绑定',
      cancelLabel: '暂不绑定'
    })
    if (!confirmed) return
    if (candidate.confirmationExpiresAt && Date.parse(candidate.confirmationExpiresAt) <= Date.now()) {
      await confirmDialog({
        title: '绑定信息已过期',
        description: '后台会继续监听当前登录身份，读取到最新资料后会再次提示。',
        confirmLabel: '知道了',
        cancelLabel: '关闭'
      })
      section.value = 'accounts'
      return
    }
    const result = await window.socialVault.accounts.confirmIdentity({
      accountId: candidate.accountId,
      token: candidate.confirmationToken,
      confirmIdentity: true
    })
    section.value = 'accounts'
    if (result.status !== 'verified') {
      await confirmDialog({
        title: '暂未完成绑定',
        description: result.message,
        confirmLabel: '知道了',
        cancelLabel: '关闭',
        tone: result.status === 'identity_mismatch' ? 'warning' : 'default'
      })
    }
  } catch (cause) {
    section.value = 'accounts'
    await confirmDialog({
      title: '绑定失败',
      description: messageOf(cause),
      details: ['详细原因已写入日志中心，后台监听会继续等待下一次身份响应。'],
      confirmLabel: '查看账号',
      cancelLabel: '关闭',
      tone: 'warning'
    })
  } finally {
    activeIdentityCandidates.delete(candidateKey)
  }
}

onMounted(() => {
  removeNavigationListener = window.socialVault.navigation.onRequested((target) => {
    section.value = target
  })
  removeIdentityPreviewListener = window.socialVault.accounts.onIdentityPreview((candidate) => {
    void promptIdentityBinding(candidate)
  })
  void initializeUpdater()
})
onBeforeUnmount(() => {
  removeNavigationListener?.()
  removeIdentityPreviewListener?.()
  disposeUpdater()
})
</script>

<template>
  <div class="app-frame" :class="{ 'sidebar-collapsed': sidebarCollapsed }">
    <AppTitlebar
      :section="section"
      :sidebar-collapsed="sidebarCollapsed"
      :update-state="updateState"
      :update-ready="updaterReady"
      @toggle-sidebar="toggleSidebar"
      @open-updates="section = 'settings'"
    />
    <div class="app-shell">
      <AppSidebar v-model="section" :collapsed="sidebarCollapsed" />
      <main class="main-content">
        <DashboardCenter v-if="section === 'dashboard'" @navigate="section = $event" />
        <AccountCenter v-else-if="section === 'accounts'" />
        <ContentCenter v-else-if="section === 'content'" />
        <AnalyticsCenter v-else-if="section === 'analytics'" />
        <TaskCenter v-else-if="section === 'tasks'" @navigate="section = $event" />
        <PluginCenter v-else-if="section === 'plugins'" />
        <LogCenter v-else-if="section === 'logs'" />
        <SettingsCenter v-else />
      </main>
    </div>
    <AppDialogHost />
  </div>
</template>
