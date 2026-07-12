<script setup lang="ts">
import { ref } from 'vue'
import AppSidebar, { type AppSection } from './components/AppSidebar.vue'
import AccountCenter from './features/accounts/AccountCenter.vue'
import AnalyticsCenter from './features/analytics/AnalyticsCenter.vue'
import ContentCenter from './features/content/ContentCenter.vue'
import DashboardCenter from './features/dashboard/DashboardCenter.vue'
import PluginCenter from './features/plugins/PluginCenter.vue'
import SettingsCenter from './features/settings/SettingsCenter.vue'

const section = ref<AppSection>('accounts')
</script>

<template>
  <div class="app-shell">
    <AppSidebar v-model="section" />
    <main class="main-content">
      <DashboardCenter v-if="section === 'dashboard'" @navigate="section = $event" />
      <AccountCenter v-else-if="section === 'accounts'" />
      <ContentCenter v-else-if="section === 'content'" />
      <AnalyticsCenter v-else-if="section === 'analytics'" />
      <PluginCenter v-else-if="section === 'plugins'" />
      <SettingsCenter v-else />
    </main>
  </div>
</template>
