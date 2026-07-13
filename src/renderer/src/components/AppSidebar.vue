<script setup lang="ts">
export type AppSection = 'dashboard' | 'accounts' | 'content' | 'analytics' | 'plugins' | 'settings'

defineProps<{ modelValue: AppSection }>()
const emit = defineEmits<{ 'update:modelValue': [value: AppSection] }>()

const items: Array<{ id: AppSection; label: string; description: string }> = [
  { id: 'dashboard', label: '工作台', description: '今日概览' },
  { id: 'accounts', label: '账号', description: '连接与分组' },
  { id: 'content', label: '内容', description: '作品资料库' },
  { id: 'analytics', label: '数据', description: '趋势与表现' },
  { id: 'plugins', label: '插件', description: '平台能力' },
  { id: 'settings', label: '设置', description: '偏好与存储' }
]
</script>

<template>
  <aside class="main-nav">
    <div class="sidebar-heading">
      <span>工作空间</span>
      <p>账号归位，内容成册</p>
    </div>
    <nav aria-label="主导航">
      <button
        v-for="item in items"
        :key="item.id"
        :class="{ active: modelValue === item.id }"
        :aria-current="modelValue === item.id ? 'page' : undefined"
        @click="emit('update:modelValue', item.id)"
      >
        <span class="nav-icon" aria-hidden="true">
          <svg v-if="item.id === 'dashboard'" viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="2" /><rect x="14" y="3" width="7" height="7" rx="2" /><rect x="3" y="14" width="7" height="7" rx="2" /><rect x="14" y="14" width="7" height="7" rx="2" /></svg>
          <svg v-else-if="item.id === 'accounts'" viewBox="0 0 24 24"><circle cx="9" cy="8" r="3" /><path d="M3.5 19c.4-3.4 2.2-5.3 5.5-5.3s5.1 1.9 5.5 5.3M15.5 6.2a3 3 0 0 1 0 5.7M16.7 14.2c2.3.5 3.5 2.1 3.8 4.8" /></svg>
          <svg v-else-if="item.id === 'content'" viewBox="0 0 24 24"><path d="M6 3h9l4 4v14H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" /><path d="M14 3v5h5M8 12h7M8 16h7" /></svg>
          <svg v-else-if="item.id === 'analytics'" viewBox="0 0 24 24"><path d="M4 20V10m6 10V4m6 16v-7m4 7H2" /></svg>
          <svg v-else-if="item.id === 'plugins'" viewBox="0 0 24 24"><path d="M8 8V5a2 2 0 0 1 4 0v3h3a2 2 0 1 1 0 4h-3v3a2 2 0 1 1-4 0v-3H5a2 2 0 1 1 0-4Z" /></svg>
          <svg v-else viewBox="0 0 24 24"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6 1.7 1.7 0 0 0 10 3v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z" /></svg>
        </span>
        <span class="nav-copy"><strong>{{ item.label }}</strong><small>{{ item.description }}</small></span>
      </button>
    </nav>
    <div class="sidebar-footer">
      <span class="local-indicator"><i /></span>
      <span><strong>本地工作区</strong><small>数据保存在此设备</small></span>
    </div>
  </aside>
</template>
