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
import { statusPresentation, syncModeLabel } from './presentation'

type DetailTab = 'overview' | 'browser' | 'content' | 'settings'

const props = defineProps<{
  account: Account | null
  platform?: PlatformDefinition
  groups: Group[]
  browserState?: BrowserState
  save: (input: UpdateAccountInput) => Promise<Account>
  openBrowser: (id: string) => Promise<BrowserState>
  disconnect: (id: string) => Promise<void>
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
    if (previous?.id !== account.id) activeTab.value = 'overview'
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

async function togglePaused(): Promise<void> {
  if (!props.account || busy.value) return
  busy.value = true
  try {
    await props.save({
      id: props.account.id,
      status: props.account.status === 'paused' ? 'pending' : 'paused'
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
    `断开“${props.account.alias}”？\n\n这会关闭该账号浏览器窗口，清除本机 Cookie、缓存和站点存储，并移除本地账号记录；不会删除或修改平台账号。`
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
            <p>{{ platform?.name }} · {{ statusPresentation(account.status).label }} · 独立本地会话</p>
          </div>
        </div>
        <button class="button browser-primary" :disabled="busy" @click="openBrowserWindow">
          <span>↗</span>{{ browserState?.windowOpen ? '切换到浏览器窗口' : '打开独立浏览器' }}
        </button>
      </header>

      <nav class="tabs" role="tablist" aria-label="账号详情">
        <button :class="{ active: activeTab === 'overview' }" @click="activeTab = 'overview'">总览</button>
        <button :class="{ active: activeTab === 'browser' }" @click="activeTab = 'browser'">浏览器</button>
        <button :class="{ active: activeTab === 'content' }" @click="activeTab = 'content'">内容数据</button>
        <button :class="{ active: activeTab === 'settings' }" @click="activeTab = 'settings'">设置与备注</button>
      </nav>

      <div v-if="activeTab === 'overview'" class="detail-scroll">
        <div class="metric-grid">
          <article>
            <span>账号身份</span><strong>{{ account.remoteId ? '已确认' : '待确认' }}</strong><small>确认后才允许采集</small>
          </article>
          <article>
            <span>同步范围</span><strong>{{ syncModeLabel(account.syncMode) }}</strong><small>首次默认最小范围</small>
          </article>
          <article>
            <span>浏览器状态</span><strong>{{ browserState?.windowOpen ? '已打开' : '未打开' }}</strong><small>独立窗口 · 独立会话</small>
          </article>
        </div>

        <section class="workflow-card">
          <div class="section-heading"><div><h3>安全接入流程</h3><p>当前版本只开放前两步，采集仍保持关闭。</p></div><span class="read-only-badge">只读设计</span></div>
          <ol class="steps">
            <li class="done"><b>1</b><div><strong>账号空间已创建</strong><span>Session Partition 与其他账号完全隔离</span></div></li>
            <li :class="{ done: browserState?.official }"><b>2</b><div><strong>在独立窗口登录官方页面</strong><span>完整宽度显示平台页面，地址栏持续校验域名</span></div></li>
            <li><b>3</b><div><strong>确认本人身份</strong><span>待只读 whoami 适配器完成安全审计</span></div></li>
            <li><b>4</b><div><strong>低频同步本人数据</strong><span>当前未启用任何真实采集插件</span></div></li>
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
              {{ browserState?.windowOpen ? '切换到已打开的窗口' : `打开 ${platform?.name} 官方入口` }} ↗
            </button>
          </div>
        </section>
        <section v-if="browserState" class="browser-session-status">
          <div><span>窗口</span><strong>{{ browserState.windowOpen ? '已打开' : '已关闭' }}</strong></div>
          <div><span>域名</span><strong>{{ browserState.official ? '官方域名' : '等待校验' }}</strong></div>
          <div class="session-address"><span>最近地址</span><strong>{{ browserState.url || platform?.loginUrl }}</strong></div>
        </section>
      </div>

      <div v-else-if="activeTab === 'content'" class="detail-scroll content-empty">
        <span>▤</span><h3>尚未接入采集插件</h3>
        <p>先把登录、会话隔离和身份确认做稳定，再接入经过审核的只读采集插件。</p>
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
          <label>首次同步范围<select v-model="form.syncMode"><option value="profile_only">仅账号资料（推荐）</option><option value="recent_20">最近 20 条</option><option value="recent_100">最近 100 条</option><option value="disabled">暂不同步</option></select></label>
          <label class="checkbox default-check"><input v-model="form.isDefault" type="checkbox" />设为该平台默认账号</label>
        </div>
        <div class="form-actions"><button class="button primary" :disabled="busy" type="submit">保存本地设置</button><button class="button" :disabled="busy" type="button" @click="togglePaused">{{ account.status === 'paused' ? '恢复账号' : '暂停账号' }}</button></div>
        <p v-if="localMessage" class="success-message">{{ localMessage }}</p>
        <p class="privacy-copy">别名、备注、标签和分组不会发送给平台或采集插件。</p>

        <section class="danger-zone">
          <div><strong>断开本地账号</strong><p>清除该账号在本机的 Cookie、缓存、站点存储和账号记录；不会删除平台账号。</p></div>
          <button class="button danger" :disabled="busy" type="button" @click="disconnectAccount">断开并清除会话</button>
        </section>
      </form>
    </template>
  </section>
</template>
