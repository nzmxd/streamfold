<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
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

onMounted(() => {
  removeNavigationListener = window.socialVault.navigation.onRequested((target) => {
    section.value = target
  })
  void initializeUpdater()
})
onBeforeUnmount(() => {
  removeNavigationListener?.()
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
