<script setup lang="ts">
import { ref } from 'vue'
import AppDialogHost from './components/AppDialogHost.vue'
import AppSidebar, { type AppSection } from './components/AppSidebar.vue'
import AppTitlebar from './components/AppTitlebar.vue'
import AccountCenter from './features/accounts/AccountCenter.vue'
import AnalyticsCenter from './features/analytics/AnalyticsCenter.vue'
import ContentCenter from './features/content/ContentCenter.vue'
import DashboardCenter from './features/dashboard/DashboardCenter.vue'
import PluginCenter from './features/plugins/PluginCenter.vue'
import SettingsCenter from './features/settings/SettingsCenter.vue'
import { createSidebarState } from './ui/sidebar-state'

const section = ref<AppSection>('dashboard')
const sidebar = createSidebarState()
const sidebarCollapsed = sidebar.collapsed
const toggleSidebar = sidebar.toggle
</script>

<template>
  <div class="app-frame" :class="{ 'sidebar-collapsed': sidebarCollapsed }">
    <AppTitlebar
      :section="section"
      :sidebar-collapsed="sidebarCollapsed"
      @toggle-sidebar="toggleSidebar"
    />
    <div class="app-shell">
      <AppSidebar v-model="section" :collapsed="sidebarCollapsed" />
      <main class="main-content">
        <DashboardCenter v-if="section === 'dashboard'" @navigate="section = $event" />
        <AccountCenter v-else-if="section === 'accounts'" />
        <ContentCenter v-else-if="section === 'content'" />
        <AnalyticsCenter v-else-if="section === 'analytics'" />
        <PluginCenter v-else-if="section === 'plugins'" />
        <SettingsCenter v-else />
      </main>
    </div>
    <AppDialogHost />
  </div>
</template>
