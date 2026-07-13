<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import type { BrowserState } from '../../shared/contracts'

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
  message: '正在连接安全浏览器会话…'
})
const error = ref('')
const verificationMessage = ref('')
const verifying = ref(false)
let removeListener: (() => void) | null = null

onMounted(async () => {
  removeListener = window.browserWorkspace.onState((value) => {
    verificationMessage.value = ''
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
const closeWindow = (): void => run(() => window.browserWorkspace.close())

async function verifyIdentity(): Promise<void> {
  if (verifying.value) return
  verifying.value = true
  error.value = ''
  verificationMessage.value = ''
  try {
    let result = await window.browserWorkspace.verifyIdentity()
    if (result.status === 'confirmation_required' && result.confirmationToken && state.value.accountId) {
      const confirmed = window.confirm(
        `确认绑定当前可见的小红书身份？\n\n昵称：${result.remoteName}\n远端 ID：${result.remoteId}\n\n确认后会再次核验当前页面，身份一致才会保存。`
      )
      if (confirmed) {
        result = await window.browserWorkspace.confirmIdentity({
          accountId: state.value.accountId,
          token: result.confirmationToken,
          confirmIdentity: true
        })
      } else {
        verificationMessage.value = '已取消首次身份绑定，未写入任何账号身份。'
        return
      }
    }
    verificationMessage.value = result.remoteName
      ? `${result.message} 当前身份：${result.remoteName}`
      : result.message
  } catch (cause) {
    error.value = messageOf(cause)
  } finally {
    verifying.value = false
  }
}

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
      <button v-if="state.platformId === 'xiaohongshu'" class="verify-identity" :disabled="verifying || state.loading || !state.official" @click="verifyIdentity">{{ verifying ? '核验中…' : '核验身份' }}</button>
      <button class="close-browser" aria-label="关闭浏览器窗口" title="关闭窗口（保留登录态）" @click="closeWindow">关闭</button>
    </div>

    <div class="status-row" :class="{ error: error }">
      <span>{{ error || verificationMessage || state.message }}</span>
      <span>登录阶段不运行采集插件 · 不读取密码和验证码</span>
    </div>
  </header>
</template>
