<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { BrowserState } from '../../shared/contracts'
import BrandGlyph from './components/BrandGlyph.vue'
import { useTheme } from './ui/theme'

const state = ref<BrowserState>({
  accountId: null,
  platformId: null,
  accountAlias: '',
  platformName: '',
  url: '',
  title: '',
  loading: false,
  canGoBack: false,
  canGoForward: false,
  official: false,
  windowOpen: true,
  message: '正在打开账号浏览器…'
})
const error = ref('')
const theme = useTheme()
let removeListener: (() => void) | null = null

const address = computed(() => {
  const rawUrl = state.value.url.trim()
  if (!rawUrl) {
    return {
      hostname: '正在打开平台页面',
      rest: ''
    }
  }

  try {
    const url = new URL(rawUrl)
    return {
      hostname: url.hostname,
      rest: `${url.pathname === '/' ? '' : url.pathname}${url.search}${url.hash}`
    }
  } catch {
    return {
      hostname: rawUrl,
      rest: ''
    }
  }
})

onMounted(async () => {
  removeListener = window.browserWorkspace.onState((value) => {
    state.value = value
  })
  try {
    state.value = await window.browserWorkspace.getState()
  } catch (cause) {
    error.value = messageOf(cause)
  }
})

onBeforeUnmount(() => removeListener?.())

function run(action: () => Promise<void>): void {
  error.value = ''
  void action().catch((cause) => {
    error.value = messageOf(cause)
  })
}

const goBack = (): void => run(() => window.browserWorkspace.back())
const goForward = (): void => run(() => window.browserWorkspace.forward())
const reload = (): void => run(() => window.browserWorkspace.reload())
const goHome = (): void => run(() => window.browserWorkspace.home())
const toggleTheme = (): void => {
  void theme.setTheme(theme.resolved.value === 'dark' ? 'light' : 'dark')
}

function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}
</script>

<template>
  <header class="browser-chrome" aria-label="账号浏览器工具栏">
    <div class="toolbar-row">
      <div class="account-context">
        <BrandGlyph :size="34" />
        <div class="account-copy">
          <strong>{{ state.accountAlias || '账号会话' }}</strong>
          <small>{{ state.platformName || '平台浏览器' }} · 独立会话</small>
        </div>
      </div>

      <nav class="navigation-actions" aria-label="网页导航">
        <button class="icon-button" aria-label="后退" title="后退" :disabled="!state.canGoBack" @click="goBack">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14.5 6-6 6 6 6" /></svg>
        </button>
        <button class="icon-button" aria-label="前进" title="前进" :disabled="!state.canGoForward" @click="goForward">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9.5 6 6 6-6 6" /></svg>
        </button>
        <button class="icon-button" aria-label="刷新" title="刷新" @click="reload">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 8V4m0 0h-4m4 0-3.1 3.1a7 7 0 1 0 1.15 8.25" /></svg>
        </button>
        <button class="icon-button" aria-label="平台主页" title="返回平台主页" @click="goHome">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 10 8-6 8 6v9a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1Z" /></svg>
        </button>
      </nav>

      <div class="address" :class="{ official: state.official }" :title="state.url">
        <span class="site-indicator" aria-hidden="true">
          <svg v-if="state.official" viewBox="0 0 24 24"><path d="m8.5 12 2.35 2.35L16 9.2" /><path d="M12 3.5 19 6v5.2c0 4.1-2.8 7.75-7 9.3-4.2-1.55-7-5.2-7-9.3V6Z" /></svg>
          <svg v-else viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5" /><path d="M12 8.2v4.5m0 3.1h.01" /></svg>
        </span>
        <span class="address-value">
          <span class="hostname">{{ address.hostname }}</span>
          <span v-if="address.rest" class="address-rest">{{ address.rest }}</span>
        </span>
        <span class="domain-status">{{ state.official ? '官方域名' : '检查域名' }}</span>
        <span v-if="state.loading" class="spinner" aria-label="页面加载中" />
      </div>

      <button
        class="browser-theme"
        type="button"
        :aria-label="theme.resolved.value === 'dark' ? '切换到浅色外观' : '切换到深色外观'"
        title="切换外观"
        @click="toggleTheme"
      >
        <svg v-if="theme.resolved.value === 'dark'" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 15.3A8.5 8.5 0 0 1 8.7 4a8.5 8.5 0 1 0 11.3 11.3Z" /></svg>
        <svg v-else viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3.5" /><path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>
      </button>
    </div>

    <div class="status-row" :class="{ error: Boolean(error), loading: state.loading }" aria-live="polite">
      <span class="status-message">
        <span class="status-dot" aria-hidden="true" />
        {{ error || state.message }}
      </span>
      <span v-if="state.title" class="page-title">{{ state.title }}</span>
    </div>
  </header>
</template>
