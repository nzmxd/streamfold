<script setup lang="ts">
export type AppSection = 'dashboard' | 'accounts' | 'content' | 'analytics' | 'plugins' | 'settings'

defineProps<{ modelValue: AppSection }>()
const emit = defineEmits<{ 'update:modelValue': [value: AppSection] }>()

const items: Array<{ id: AppSection; label: string; icon: string }> = [
  { id: 'dashboard', label: '工作台', icon: '▦' },
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
        :aria-current="modelValue === item.id ? 'page' : undefined"
        @click="emit('update:modelValue', item.id)"
      >
        <span>{{ item.icon }}</span>{{ item.label }}
      </button>
    </nav>
  </aside>
</template>
