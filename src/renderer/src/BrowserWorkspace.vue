<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import type { BrowserState } from '../../shared/contracts'

const state = ref<BrowserState>({
  accountId: null,
  accountAlias: '',
  platformName: '',
  url: '',
  title: '',
  loading: false,
  canGoBack: false,
  canGoForward: false,
  official: false,
  windowOpen: true,
  message: '正在连接安全浏览器会话…'
})
const error = ref('')
let removeListener: (() => void) | null = null

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

function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}
</script>

<template>
  <header class="browser-chrome">
    <div class="toolbar-row">
      <div class="account-context">
        <span class="product-mark">S</span>
        <div>
          <strong>{{ state.platformName || '内置 Chromium' }} · {{ state.accountAlias || '账号会话' }}</strong>
          <small>独立登录会话</small>
        </div>
      </div>

      <div class="navigation-actions">
        <button aria-label="后退" :disabled="!state.canGoBack" @click="goBack">←</button>
        <button aria-label="前进" :disabled="!state.canGoForward" @click="goForward">→</button>
        <button aria-label="刷新" @click="reload">↻</button>
        <button aria-label="平台主页" @click="goHome">⌂</button>
      </div>

      <div class="address" :class="{ verified: state.official }">
        <span class="lock">{{ state.official ? '✓' : '○' }}</span>
        <span class="address-value">{{ state.url || '等待打开官方登录入口…' }}</span>
        <span v-if="state.loading" class="loading-dot">加载中</span>
      </div>

      <span class="official-badge" :class="{ verified: state.official }">
        {{ state.official ? '官方域名' : '域名校验中' }}
      </span>
    </div>

    <div class="status-row" :class="{ error: error }">
      <span>{{ error || state.message }}</span>
      <span>登录阶段不运行采集插件 · 不读取密码和验证码</span>
    </div>
  </header>
</template>
