<script setup lang="ts">
import { reactive, ref, watch } from 'vue'
import type {
  Account,
  BrowserState,
  Group,
  PlatformDefinition,
  SyncMode,
  UpdateAccountInput
} from '../../../../shared/contracts'
import AccountContentWidget from '../content/AccountContentWidget.vue'
import {
  connectionStatusLabel,
  ownershipStatusLabel,
  syncModeLabel,
  syncStatusLabel
} from './presentation'

type DetailTab = 'overview' | 'browser' | 'content' | 'settings'

const props = defineProps<{
  account: Account | null
  platform?: PlatformDefinition
  groups: Group[]
  browserState?: BrowserState
  save: (input: UpdateAccountInput) => Promise<Account>
  openBrowser: (id: string) => Promise<BrowserState>
  disconnect: (id: string) => Promise<void>
  purge: (id: string) => Promise<void>
}>()

const activeTab = ref<DetailTab>('overview')
const busy = ref(false)
const localMessage = ref('')
const form = reactive({
  alias: '',
  note: '',
  tags: '',
  groupIds: [] as string[],
  syncMode: 'profile_only' as SyncMode,
  isDefault: false
})

watch(
  () => props.account,
  (account, previous) => {
    if (!account) return
    if (previous?.id !== account.id) {
      activeTab.value = 'overview'
      localMessage.value = ''
    }
    form.alias = account.alias
    form.note = account.note
    form.tags = account.tags.join(', ')
    form.groupIds = [...account.groupIds]
    form.syncMode = account.syncMode
    form.isDefault = account.isDefault
  },
  { immediate: true }
)

async function saveSettings(): Promise<void> {
  if (!props.account || busy.value) return
  busy.value = true
  localMessage.value = ''
  try {
    await props.save({
      id: props.account.id,
      alias: form.alias,
      note: form.note,
      tags: form.tags.split(/[,，]/).map((item) => item.trim()).filter(Boolean),
      groupIds: [...form.groupIds],
      syncMode: form.syncMode,
      isDefault: form.isDefault
    })
    localMessage.value = '本地设置已保存，不会上传到社媒平台。'
  } catch {
    // The account store renders the sanitized error at page level.
  } finally {
    busy.value = false
  }
}

async function toggleSync(): Promise<void> {
  if (!props.account || busy.value || props.account.connectionStatus === 'disconnected') return
  busy.value = true
  try {
    await props.save({
      id: props.account.id,
      syncEnabled: !props.account.syncEnabled
    })
  } catch {
    // The account store renders the sanitized error at page level.
  } finally {
    busy.value = false
  }
}

async function openBrowserWindow(): Promise<void> {
  if (!props.account || busy.value) return
  busy.value = true
  try {
    await props.openBrowser(props.account.id)
  } catch {
    // The account store renders the sanitized error at page level.
  } finally {
    busy.value = false
  }
}

async function disconnectAccount(): Promise<void> {
  if (!props.account || busy.value) return
  const confirmed = window.confirm(
    `断开“${props.account.alias}”的登录会话？\n\n这会关闭浏览器窗口并清除该账号的 Cookie、缓存和站点存储；账号备注、分组、内容与历史指标都会保留。不会修改平台账号。`
  )
  if (!confirmed) return
  busy.value = true
  try {
    await props.disconnect(props.account.id)
  } catch {
    // The account store renders the sanitized error at page level.
  } finally {
    busy.value = false
  }
}

async function purgeAccount(): Promise<void> {
  if (!props.account || busy.value) return
  const accountId = props.account.id
  const alias = props.account.alias
  const confirmed = window.confirm(
    `永久删除本地账号“${alias}”？\n\n该账号的登录会话、备注、内容、指标快照和导入记录都会从本机删除，且无法撤销。平台上的账号和内容不受影响。`
  )
  if (!confirmed) return
  busy.value = true
  try {
    await props.purge(accountId)
  } catch {
    // The account store renders the sanitized error at page level.
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <section class="account-detail">
    <div v-if="!account" class="empty-detail">
      <span>◎</span>
      <h2>选择或添加账号</h2>
      <p>账号管理和浏览器已经分离，浏览器会在独立大窗口中打开。</p>
    </div>

    <template v-else>
      <header class="account-head">
        <div class="account-identity">
          <span class="avatar large">{{ platform?.shortName }}</span>
          <div>
            <div class="title-line">
              <h2>{{ account.alias }}</h2>
              <span v-if="account.isDefault" class="default-badge">默认</span>
            </div>
            <p>{{ platform?.name }} · {{ connectionStatusLabel(account.connectionStatus) }} · {{ ownershipStatusLabel(account.ownershipStatus) }}</p>
          </div>
        </div>
        <button class="button browser-primary" :disabled="busy" @click="openBrowserWindow">
          <span>↗</span>{{ browserState?.windowOpen ? '切换到浏览器窗口' : account.connectionStatus === 'disconnected' ? '重新连接官方页面' : '打开独立浏览器' }}
        </button>
      </header>

      <nav class="tabs" role="tablist" aria-label="账号详情">
        <button role="tab" :aria-selected="activeTab === 'overview'" :class="{ active: activeTab === 'overview' }" @click="activeTab = 'overview'">总览</button>
        <button role="tab" :aria-selected="activeTab === 'browser'" :class="{ active: activeTab === 'browser' }" @click="activeTab = 'browser'">浏览器</button>
        <button role="tab" :aria-selected="activeTab === 'content'" :class="{ active: activeTab === 'content' }" @click="activeTab = 'content'">内容数据</button>
        <button role="tab" :aria-selected="activeTab === 'settings'" :class="{ active: activeTab === 'settings' }" @click="activeTab = 'settings'">设置与备注</button>
      </nav>

      <div v-if="activeTab === 'overview'" class="detail-scroll">
        <div class="metric-grid account-status-grid">
          <article>
            <span>连接状态</span><strong>{{ connectionStatusLabel(account.connectionStatus) }}</strong><small>只表示本机登录会话是否可用</small>
          </article>
          <article>
            <span>身份归属</span><strong>{{ ownershipStatusLabel(account.ownershipStatus) }}</strong><small>{{ account.remoteName || '尚未绑定平台身份' }}</small>
          </article>
          <article>
            <span>平台同步策略</span><strong>{{ account.syncEnabled ? syncStatusLabel(account.syncStatus) : '不允许同步' }}</strong><small>{{ syncModeLabel(account.syncMode) }} · 当前仅保存策略，无自动调度</small>
          </article>
          <article>
            <span>浏览器窗口</span><strong>{{ browserState?.windowOpen ? '已打开' : '已关闭' }}</strong><small>关闭窗口不会清除登录态</small>
          </article>
        </div>

        <section class="workflow-card">
          <div class="section-heading"><div><h3>安全接入流程</h3><p>连接、身份归属和数据导入分别记录，避免状态混淆。</p></div><span class="read-only-badge">只读设计</span></div>
          <ol class="steps">
            <li class="done"><b>1</b><div><strong>账号空间已创建</strong><span>Session Partition 与其他账号完全隔离</span></div></li>
            <li :class="{ done: browserState?.official }"><b>2</b><div><strong>打开平台官方页面</strong><span>这里只校验当前域名属于平台，不代表已经登录</span></div></li>
            <li :class="{ done: account.ownershipStatus !== 'unconfirmed' }"><b>3</b><div><strong>确认数据归属</strong><span>由用户核对文件身份并确认本人归属；通用导入插件不验证平台登录身份</span></div></li>
            <li :class="{ done: Boolean(account.lastSyncedAt) }"><b>4</b><div><strong>导入本人数据</strong><span>文件插件只读用户确认归属的数据并写入本机</span></div></li>
          </ol>
        </section>
      </div>

      <div v-else-if="activeTab === 'browser'" class="detail-scroll">
        <section class="browser-launch-card">
          <div class="browser-illustration">
            <div class="mini-window"><span></span><span></span><span></span><i></i></div>
          </div>
          <div class="browser-launch-copy">
            <span class="eyebrow">独立浏览器工作窗口</span>
            <h3>完整页面空间，不再挤在账号详情里</h3>
            <p>浏览器会打开为独立窗口，拥有固定工具栏、完整官方地址、前进后退和账号专属登录会话。关闭窗口不会清除登录态。</p>
            <ul>
              <li>账号之间 Cookie、缓存和 LocalStorage 隔离</li>
              <li>未知域名、弹窗、下载和权限默认阻止</li>
              <li>登录阶段不运行采集插件，不读取密码和验证码</li>
            </ul>
            <button class="button primary large-action" :disabled="busy" @click="openBrowserWindow">
              {{ browserState?.windowOpen ? '切换到已打开的窗口' : account.connectionStatus === 'disconnected' ? `重新连接 ${platform?.name} 官方入口` : `打开 ${platform?.name} 官方入口` }} ↗
            </button>
          </div>
        </section>
        <section v-if="browserState" class="browser-session-status">
          <div><span>窗口</span><strong>{{ browserState.windowOpen ? '已打开' : '已关闭' }}</strong></div>
          <div><span>域名</span><strong>{{ browserState.official ? '官方域名' : '等待校验' }}</strong></div>
          <div class="session-address"><span>最近地址</span><strong>{{ browserState.url || platform?.loginUrl }}</strong></div>
        </section>
      </div>

      <div v-else-if="activeTab === 'content'" class="detail-scroll">
        <AccountContentWidget :account-id="account.id" />
      </div>

      <form v-else class="detail-scroll settings-form" @submit.prevent="saveSettings">
        <div class="settings-grid">
          <label>本地别名<input v-model="form.alias" maxlength="40" required /></label>
          <label>标签<input v-model="form.tags" placeholder="使用逗号分隔，例如：工作, 重点" /></label>
        </div>
        <label>账号备注<textarea v-model="form.note" rows="4" maxlength="1000" placeholder="负责人、内容方向、登录说明等，仅保存在本机"></textarea></label>
        <fieldset>
          <legend>所属分组</legend>
          <label v-for="group in groups" :key="group.id" class="checkbox"><input v-model="form.groupIds" type="checkbox" :value="group.id" />{{ group.name }}</label>
          <span v-if="groups.length === 0" class="muted">尚未创建自定义分组</span>
        </fieldset>
        <div class="settings-grid">
          <label>未来平台插件的默认同步范围<select v-model="form.syncMode"><option value="profile_only">仅账号资料（推荐）</option><option value="recent_20">最近 20 条</option><option value="recent_100">最近 100 条</option><option value="disabled">不允许平台同步</option></select></label>
          <label class="checkbox default-check"><input v-model="form.isDefault" type="checkbox" />设为该平台默认账号</label>
        </div>
        <div class="form-actions"><button class="button primary" :disabled="busy" type="submit">保存本地设置</button><button class="button" :disabled="busy || account.connectionStatus === 'disconnected'" :title="account.connectionStatus === 'disconnected' ? '请先重新打开官方页面并建立连接' : undefined" type="button" @click="toggleSync">{{ account.syncEnabled ? '不允许未来平台同步' : '允许未来平台同步' }}</button></div>
        <p v-if="account.connectionStatus === 'disconnected'" class="muted">登录会话已断开，重新建立连接前不能允许未来平台同步。</p>
        <p v-if="localMessage" class="success-message">{{ localMessage }}</p>
        <p class="privacy-copy">别名、备注、标签和分组不会发送给平台或采集插件。</p>

        <section class="danger-zone session-zone">
          <div><strong>断开登录会话</strong><p>清除该账号的 Cookie、缓存和站点存储；账号资料和历史数据保留。</p></div>
          <button class="button danger" :disabled="busy" type="button" @click="disconnectAccount">断开并清除会话</button>
        </section>
        <section class="danger-zone">
          <div><strong>永久删除本地账号</strong><p>删除会话、账号资料、备注、内容、快照和任务记录；不会删除平台账号。</p></div>
          <button class="button danger strong" :disabled="busy" type="button" @click="purgeAccount">永久删除</button>
        </section>
      </form>
    </template>
  </section>
</template>
