<script setup lang="ts">
import { computed, ref } from 'vue'
import AppSidebar, { type AppSection } from './components/AppSidebar.vue'
import AccountCenter from './features/accounts/AccountCenter.vue'

const section = ref<AppSection>('accounts')
const sectionCopy = computed(() => ({
  content: ['内容中心', '跨平台内容管理将在只读插件审计完成后开放。'],
  analytics: ['数据分析', '指标快照与趋势分析将在数据模型落地后开放。'],
  plugins: ['插件中心', '只允许固定版本、固定哈希和只读能力的审核插件。'],
  settings: ['应用设置', '后续提供备份、诊断、版本和安全更新管理。']
}[section.value as Exclude<AppSection, 'accounts'>]))
</script>

<template>
  <div class="app-shell">
    <AppSidebar v-model="section" />
    <main class="main-content">
      <AccountCenter v-if="section === 'accounts'" />
      <section v-else class="placeholder-page">
        <div class="placeholder-icon">◇</div>
        <span class="page-eyebrow">COMING NEXT</span>
        <h1>{{ sectionCopy?.[0] }}</h1>
        <p>{{ sectionCopy?.[1] }}</p>
      </section>
    </main>
  </div>
</template>
