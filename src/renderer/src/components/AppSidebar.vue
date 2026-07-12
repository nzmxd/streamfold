<script setup lang="ts">
export type AppSection = 'accounts' | 'content' | 'analytics' | 'plugins' | 'settings'

defineProps<{ modelValue: AppSection }>()
const emit = defineEmits<{ 'update:modelValue': [value: AppSection] }>()

const items: Array<{ id: AppSection; label: string; icon: string }> = [
  { id: 'accounts', label: '账号', icon: '◎' },
  { id: 'content', label: '内容', icon: '▤' },
  { id: 'analytics', label: '数据', icon: '⌁' },
  { id: 'plugins', label: '插件', icon: '◇' },
  { id: 'settings', label: '设置', icon: '⚙' }
]
</script>

<template>
  <aside class="main-nav">
    <div class="brand"><span class="brand-mark">S</span><span>Social Vault</span></div>
    <nav aria-label="主导航">
      <button
        v-for="item in items"
        :key="item.id"
        :class="{ active: modelValue === item.id }"
        @click="emit('update:modelValue', item.id)"
      >
        <span>{{ item.icon }}</span>{{ item.label }}
      </button>
    </nav>
    <div class="security-note">
      <strong>账号安全优先</strong>
      <span>官方入口 · 独立会话 · 本地存储</span>
    </div>
  </aside>
</template>
