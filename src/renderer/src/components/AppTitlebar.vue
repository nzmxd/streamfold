<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { ThemePreference } from '../../../shared/contracts'
import { useTheme } from '../ui/theme'
import type { AppSection } from './AppSidebar.vue'
import BrandGlyph from './BrandGlyph.vue'

const props = defineProps<{ section: AppSection }>()
const theme = useTheme()
const menuOpen = ref(false)

const sectionLabels: Record<AppSection, string> = {
  dashboard: '工作台',
  accounts: '账号',
  content: '内容',
  analytics: '数据分析',
  plugins: '插件',
  settings: '设置'
}

const sectionLabel = computed(() => sectionLabels[props.section])
const themeLabel = computed(() => theme.resolved.value === 'dark' ? '深色外观' : '浅色外观')

const options: Array<{ value: ThemePreference; label: string; icon: string }> = [
  { value: 'light', label: '浅色', icon: 'sun' },
  { value: 'dark', label: '深色', icon: 'moon' },
  { value: 'system', label: '跟随系统', icon: 'system' }
]

function chooseTheme(value: ThemePreference): void {
  menuOpen.value = false
  void theme.setTheme(value)
}

function closeMenu(event: MouseEvent): void {
  const target = event.target
  if (!(target instanceof Element) || !target.closest('.theme-picker')) menuOpen.value = false
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') menuOpen.value = false
}

onMounted(() => {
  document.addEventListener('pointerdown', closeMenu)
  document.addEventListener('keydown', onKeydown)
})
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', closeMenu)
  document.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <header class="app-titlebar">
    <div class="titlebar-brand">
      <BrandGlyph :size="25" />
      <strong>归页</strong>
      <span>Streamfold</span>
    </div>
    <div class="titlebar-location" aria-label="当前位置">
      <span>个人社媒工作台</span>
      <i>/</i>
      <strong>{{ sectionLabel }}</strong>
    </div>
    <div class="titlebar-actions">
      <div class="theme-picker">
        <button
          class="titlebar-button theme-trigger"
          type="button"
          :aria-label="`切换主题，当前为${themeLabel}`"
          :aria-expanded="menuOpen"
          title="切换外观"
          @click.stop="menuOpen = !menuOpen"
        >
          <svg v-if="theme.resolved.value === 'dark'" viewBox="0 0 24 24"><path d="M20 15.3A8.5 8.5 0 0 1 8.7 4a8.5 8.5 0 1 0 11.3 11.3Z" /></svg>
          <svg v-else viewBox="0 0 24 24"><circle cx="12" cy="12" r="3.5" /><path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>
        </button>
        <div v-if="menuOpen" class="theme-menu" role="menu" aria-label="外观主题">
          <span class="theme-menu-label">外观</span>
          <button
            v-for="option in options"
            :key="option.value"
            type="button"
            role="menuitemradio"
            :aria-checked="theme.preference.value === option.value"
            :class="{ active: theme.preference.value === option.value }"
            @click="chooseTheme(option.value)"
          >
            <span class="theme-option-icon" :data-icon="option.icon" />
            {{ option.label }}
            <svg class="theme-check" viewBox="0 0 20 20"><path d="m5 10 3 3 7-7" /></svg>
          </button>
        </div>
      </div>
    </div>
  </header>
</template>
