<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { ThemePreference, UpdateState } from '../../../shared/contracts'
import { presentUpdate } from '../features/updater/update-presentation'
import {
  themeColorPresets,
  useTheme,
  type DensityPreference,
  type FontSizePreference
} from '../ui/theme'
import type { AppSection } from './AppSidebar.vue'
import BrandGlyph from './BrandGlyph.vue'

const props = defineProps<{
  section: AppSection
  sidebarCollapsed: boolean
  updateState: UpdateState
  updateReady: boolean
}>()
const emit = defineEmits<{ 'toggle-sidebar': []; 'open-updates': [] }>()
const theme = useTheme()
const menuOpen = ref(false)

const sectionLabels: Record<AppSection, string> = {
  dashboard: '工作台',
  accounts: '账号',
  content: '内容',
  analytics: '数据分析',
  tasks: '任务中心',
  plugins: '插件',
  logs: '日志中心',
  settings: '设置'
}

const sectionLabel = computed(() => sectionLabels[props.section])
const themeLabel = computed(() => theme.resolved.value === 'dark' ? '深色外观' : '浅色外观')
const customThemeColorActive = computed(() => !themeColorPresets.some((option) => (
  option.value === theme.themeColor.value
)))
const updatePresentation = computed(() => presentUpdate(props.updateState))
const updateTitlebarLabel = computed(() => props.updateReady
  ? updatePresentation.value.titlebarLabel
  : '正在读取软件更新状态')
const showUpdateButton = computed(() => props.updateReady && (
  props.updateState.phase === 'available' ||
  props.updateState.phase === 'downloading' ||
  props.updateState.phase === 'downloaded'
))

const options: Array<{ value: ThemePreference; label: string; icon: string }> = [
  { value: 'light', label: '浅色', icon: 'sun' },
  { value: 'dark', label: '深色', icon: 'moon' },
  { value: 'system', label: '跟随系统', icon: 'system' }
]
const fontSizeOptions: Array<{ value: FontSizePreference; label: string }> = [
  { value: 'small', label: '小' },
  { value: 'standard', label: '标准' },
  { value: 'large', label: '大' }
]
const densityOptions: Array<{ value: DensityPreference; label: string }> = [
  { value: 'compact', label: '紧凑' },
  { value: 'comfortable', label: '舒适' }
]

function chooseTheme(value: ThemePreference): void {
  menuOpen.value = false
  void theme.setTheme(value)
}

function chooseThemeColor(value: string): void {
  void theme.setThemeColor(value)
}

function chooseCustomThemeColor(event: Event): void {
  const input = event.target
  if (input instanceof HTMLInputElement) chooseThemeColor(input.value)
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
      <button
        class="titlebar-button sidebar-collapse-toggle"
        type="button"
        aria-controls="app-sidebar"
        :aria-expanded="!sidebarCollapsed"
        :aria-label="sidebarCollapsed ? '展开左侧导航' : '折叠左侧导航'"
        :data-tooltip="sidebarCollapsed ? '展开导航' : '折叠导航'"
        @click="emit('toggle-sidebar')"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <rect x="3" y="4" width="18" height="16" rx="3" />
          <path d="M8 4v16" />
          <path :d="sidebarCollapsed ? 'm12.5 9 3 3-3 3' : 'm16 9-3 3 3 3'" />
        </svg>
      </button>
      <span>个人社媒工作台</span>
      <i>/</i>
      <strong>{{ sectionLabel }}</strong>
    </div>
    <div class="titlebar-actions">
      <button
        v-if="showUpdateButton"
        class="titlebar-button update-titlebar-button"
        :class="[`phase-${updateState.phase}`, { attention: updatePresentation.titlebarAttention }]"
        type="button"
        :aria-label="updateTitlebarLabel"
        :title="updateTitlebarLabel"
        @click="emit('open-updates')"
      >
        <svg class="update-titlebar-icon" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M20 11a8 8 0 0 0-14.7-4.3L4 9" />
          <path d="M4 4v5h5" />
          <path d="M4 13a8 8 0 0 0 14.7 4.3L20 15" />
          <path d="M20 20v-5h-5" />
        </svg>
        <span v-if="updatePresentation.titlebarAttention" class="update-titlebar-indicator" aria-hidden="true" />
      </button>
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
          <div class="appearance-menu-group">
            <span class="theme-menu-label">主题色</span>
            <div class="theme-color-grid" role="group" aria-label="主题色">
              <button
                v-for="option in themeColorPresets"
                :key="option.value"
                class="theme-color-swatch"
                type="button"
                :aria-label="`${option.label}主题色`"
                :aria-pressed="theme.themeColor.value === option.value"
                :title="option.label"
                :style="{ '--swatch-color': option.value }"
                @click="chooseThemeColor(option.value)"
              ><span aria-hidden="true" /></button>
              <label
                class="theme-color-custom"
                :class="{ active: customThemeColorActive }"
                title="自定义主题色"
              >
                <input
                  type="color"
                  :value="theme.themeColor.value"
                  aria-label="自定义主题色"
                  @input="chooseCustomThemeColor"
                />
              </label>
            </div>
          </div>
          <div class="appearance-menu-group">
            <span class="theme-menu-label">字号</span>
            <div class="appearance-segmented" role="group" aria-label="界面字号">
              <button
                v-for="option in fontSizeOptions"
                :key="option.value"
                type="button"
                :aria-pressed="theme.fontSize.value === option.value"
                :class="{ active: theme.fontSize.value === option.value }"
                @click="theme.setFontSize(option.value)"
              >{{ option.label }}</button>
            </div>
          </div>
          <div class="appearance-menu-group">
            <span class="theme-menu-label">布局密度</span>
            <div class="appearance-segmented" role="group" aria-label="界面密度">
              <button
                v-for="option in densityOptions"
                :key="option.value"
                type="button"
                :aria-pressed="theme.density.value === option.value"
                :class="{ active: theme.density.value === option.value }"
                @click="theme.setDensity(option.value)"
              >{{ option.label }}</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </header>
</template>
