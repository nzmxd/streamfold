<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import type {
  Account,
  AccountAdapterOption,
  BrowserState,
  ConfirmSessionApiIdentityInput,
  Group,
  SessionApiIdentityCheckResult,
  SessionApiSyncResult,
  PlatformDefinition,
  SyncMode,
  UpdateAccountInput
} from '../../../../shared/contracts'
import AccountContentWidget from '../content/AccountContentWidget.vue'
import { formatNumber } from '../shared/format'
import { confirmDialog } from '../../ui/dialog'
import AccountAvatar from './AccountAvatar.vue'
import AccountMetricsPanel from './AccountMetricsPanel.vue'
import {
  accountDisplayName,
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
  verifyIdentity: (id: string) => Promise<SessionApiIdentityCheckResult>
  confirmIdentity: (input: ConfirmSessionApiIdentityInput) => Promise<SessionApiIdentityCheckResult>
  syncAccount: (id: string) => Promise<SessionApiSyncResult>
  disconnect: (id: string) => Promise<void>
  purge: (id: string) => Promise<void>
}>()

const activeTab = ref<DetailTab>('overview')
const busy = ref(false)
const localMessage = ref('')
const verification = ref<SessionApiIdentityCheckResult | null>(null)
const messageSyncAt = ref<string | null>(null)
const adapters = ref<AccountAdapterOption[]>([])
const supportsManagedSync = computed(() => Boolean(props.account?.adapterContributionId))
const form = reactive({
  alias: '',
  note: '',
  tags: '',
  groupIds: [] as string[],
  syncMode: 'profile_only' as SyncMode,
  isDefault: false
})

const displayName = computed(() => {
  const account = props.account
  return account ? accountDisplayName(account, props.platform?.name) : ''
})

const syncAuthorizationReason = computed(() => {
  const account = props.account
  if (!account || account.syncEnabled) return ''
  if (account.syncMode === 'disabled') return '请先选择同步范围并保存。'
  if (account.connectionStatus === 'expired') return '登录会话已过期，请重新登录并核验当前身份。'
  if (account.connectionStatus === 'mismatch') return '当前登录身份与本地绑定不一致，不能允许同步。'
  if (account.connectionStatus === 'disconnected') return '登录会话已断开，请重新打开官方页面并核验身份。'
  if (account.connectionStatus !== 'ready') return '连接尚未就绪，请先打开官方页面并完成登录。'
  if (account.ownershipStatus !== 'plugin_verified') return '请先在浏览器页签核验当前账号。'
  return ''
})

const syncToggleDisabled = computed(() =>
  busy.value || Boolean(!props.account?.syncEnabled && syncAuthorizationReason.value)
)

watch(
  () => props.account,
  (account, previous) => {
    if (!account) return
    if (previous?.id !== account.id) {
      activeTab.value = 'overview'
      localMessage.value = ''
      verification.value = null
      messageSyncAt.value = null
    } else if (previous.lastSyncedAt !== account.lastSyncedAt && messageSyncAt.value !== account.lastSyncedAt) {
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

watch(() => props.account?.id, async (id) => {
  adapters.value = id ? await window.socialVault.accounts.listAdapters(id).catch(() => []) : []
}, { immediate: true })

async function switchAdapter(event: Event): Promise<void> {
  if (!props.account || busy.value) return
  const contributionId = (event.target as HTMLSelectElement).value
  if (!contributionId || contributionId === props.account.adapterContributionId) return
  const target = adapters.value.find((item) => item.contributionId === contributionId)
  if (!target?.available) return
  const confirmed = await confirmDialog({
    title: `切换到“${target.name}”？`,
    description: '归页会先用候选适配器重新核验稳定账号 ID；只有身份一致才会切换，历史数据保持不变。',
    confirmLabel: '核验并切换'
  })
  if (!confirmed) return
  busy.value = true
  try {
    await window.socialVault.accounts.switchAdapter(props.account.id, contributionId)
    localMessage.value = '适配器已完成身份复验并切换。'
    adapters.value = await window.socialVault.accounts.listAdapters(props.account.id)
  } finally {
    busy.value = false
  }
}

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
    localMessage.value = '设置已保存。'
  } catch {
    // The account store renders the sanitized error at page level.
  } finally {
    busy.value = false
  }
}

async function toggleSync(): Promise<void> {
  if (!props.account || syncToggleDisabled.value) return
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

async function verifyLoginIdentity(): Promise<void> {
  if (!props.account || busy.value) return
  busy.value = true
  localMessage.value = ''
  verification.value = null
  try {
    verification.value = await props.verifyIdentity(props.account.id)
    localMessage.value = verification.value.message
  } catch {
    // The account store renders the sanitized error at page level.
  } finally {
    busy.value = false
  }
}

async function confirmLoginIdentity(): Promise<void> {
  if (!props.account || busy.value || !verification.value?.confirmationToken) return
  const candidate = verification.value
  const confirmationToken = candidate.confirmationToken!
  const confirmed = await confirmDialog({
    title: `绑定当前${props.platform?.name || '平台'}账号？`,
    description: '确认后将再次核对账号信息，并把当前身份关联到这个本地账号。',
    details: [`昵称：${candidate.remoteName}`, `账号 ID：${candidate.remoteId}`],
    confirmLabel: '确认绑定'
  })
  if (!confirmed) return
  busy.value = true
  localMessage.value = ''
  try {
    verification.value = await props.confirmIdentity({
      accountId: props.account.id,
      token: confirmationToken,
      confirmIdentity: true
    })
    localMessage.value = verification.value.message
  } catch {
    // The account store renders the sanitized error at page level.
  } finally {
    busy.value = false
  }
}

async function syncOwnedData(): Promise<void> {
  if (!props.account || busy.value) return
  busy.value = true
  localMessage.value = ''
  try {
    const result = await props.syncAccount(props.account.id)
    localMessage.value = result.message
    messageSyncAt.value = props.account?.lastSyncedAt ?? null
  } catch {
    // The account store renders the sanitized error at page level.
  } finally {
    busy.value = false
  }
}

async function disconnectAccount(): Promise<void> {
  if (!props.account || busy.value) return
  const confirmed = await confirmDialog({
    title: `退出“${displayName.value}”的登录？`,
    description: '将清除这个账号浏览器的登录状态，稍后可以重新登录。',
    details: ['账号资料、备注与分组会保留', '内容与历史指标会保留'],
    confirmLabel: '退出登录',
    tone: 'warning'
  })
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
  const alias = displayName.value
  const confirmed = await confirmDialog({
    title: `永久删除“${alias}”？`,
    description: '这个操作无法撤销，但不会更改平台上的账号和内容。',
    details: ['删除本机登录状态与账号备注', '删除已同步内容、指标快照和同步记录'],
    confirmLabel: '永久删除',
    tone: 'danger'
  })
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
      <p>从左侧选择账号，或添加一个新账号开始使用。</p>
    </div>

    <template v-else>
      <header class="account-head">
        <div class="account-identity">
          <AccountAvatar
            class="large"
            :src="account.avatarUrl"
            :fallback="platform?.shortName"
            :label="`${displayName}的头像`"
          />
          <div>
            <div class="title-line">
              <h2>{{ displayName }}</h2>
              <span v-if="account.isDefault" class="default-badge">默认</span>
            </div>
            <p>{{ platform?.name }} · {{ account.remoteName || '待绑定平台身份' }}</p>
            <small v-if="account.remoteId" class="head-remote-id">账号 ID：{{ account.remoteId }}</small>
          </div>
        </div>
        <button class="button browser-primary" :disabled="busy" @click="openBrowserWindow">
          <span>↗</span>{{ browserState?.windowOpen ? '切换到浏览器窗口' : account.connectionStatus === 'disconnected' ? '重新打开登录页面' : '打开账号浏览器' }}
        </button>
      </header>

      <nav class="tabs" role="tablist" aria-label="账号详情">
        <button role="tab" :aria-selected="activeTab === 'overview'" :class="{ active: activeTab === 'overview' }" @click="activeTab = 'overview'">总览</button>
        <button role="tab" :aria-selected="activeTab === 'browser'" :class="{ active: activeTab === 'browser' }" @click="activeTab = 'browser'">浏览器</button>
        <button role="tab" :aria-selected="activeTab === 'content'" :class="{ active: activeTab === 'content' }" @click="activeTab = 'content'">内容数据</button>
        <button role="tab" :aria-selected="activeTab === 'settings'" :class="{ active: activeTab === 'settings' }" @click="activeTab = 'settings'">设置与备注</button>
      </nav>

      <div v-if="activeTab === 'overview'" class="detail-scroll">
        <section class="profile-summary-card">
          <div class="profile-summary-main">
            <AccountAvatar
              class="profile-avatar"
              :src="account.avatarUrl"
              :fallback="platform?.shortName"
              :label="`${account.remoteName || displayName}的平台头像`"
            />
            <div class="profile-summary-copy">
              <span class="eyebrow">{{ platform?.name }}平台资料</span>
              <h3>{{ account.remoteName || '尚未同步平台资料' }}</h3>
              <p class="profile-account-id">账号 ID：{{ account.remoteId || '—' }}</p>
              <p class="profile-bio">{{ account.bio || '暂无简介' }}</p>
            </div>
          </div>
          <dl class="profile-stat-list" :class="{ 'four-columns': account.platformId === 'zhihu' }">
            <div><dt>关注</dt><dd>{{ formatNumber(account.latestSnapshot?.following) }}</dd></div>
            <div><dt>粉丝</dt><dd>{{ formatNumber(account.latestSnapshot?.followers) }}</dd></div>
            <template v-if="account.platformId === 'zhihu'">
              <div><dt>累计获赞</dt><dd>{{ formatNumber(account.latestSnapshot?.likes) }}</dd></div>
              <div><dt>获收藏</dt><dd>{{ formatNumber(account.latestSnapshot?.favorites) }}</dd></div>
            </template>
            <div v-else><dt>累计获赞与收藏</dt><dd>{{ formatNumber(account.latestSnapshot?.likesAndFavoritesTotal) }}</dd></div>
          </dl>
        </section>

        <AccountMetricsPanel
          v-if="account.platformId === 'zhihu'"
          :account-id="account.id"
          :refresh-key="account.lastSyncedAt"
        />

        <div class="metric-grid account-status-grid">
          <article>
            <span>连接状态</span><strong>{{ connectionStatusLabel(account.connectionStatus) }}</strong><small>{{ browserState?.windowOpen ? '浏览器窗口已打开' : '需要时可重新打开浏览器' }}</small>
          </article>
          <article>
            <span>身份归属</span><strong>{{ ownershipStatusLabel(account.ownershipStatus) }}</strong><small>{{ account.remoteName || '尚未绑定平台身份' }}</small>
          </article>
          <article>
            <span>数据同步</span><strong>{{ account.syncEnabled ? syncStatusLabel(account.syncStatus) : '未启用' }}</strong><small>{{ syncModeLabel(account.syncMode) }}</small>
          </article>
          <article>
            <span>浏览器窗口</span><strong>{{ browserState?.windowOpen ? '已打开' : '已关闭' }}</strong><small>{{ browserState?.windowOpen ? '可切换到窗口继续操作' : '登录状态会继续保留' }}</small>
          </article>
        </div>

        <section class="workflow-card">
          <div class="section-heading"><div><h3>使用步骤</h3><p>完成登录与身份核验后即可同步数据。</p></div></div>
          <ol class="steps">
            <li class="done"><b>1</b><div><strong>账号已添加</strong><span>可继续填写分组、标签和备注</span></div></li>
            <li :class="{ done: account.connectionStatus === 'ready' }"><b>2</b><div><strong>完成平台登录</strong><span>{{ account.connectionStatus === 'ready' ? '当前登录会话可用' : '需要登录时会打开账号浏览器' }}</span></div></li>
            <li :class="{ done: account.ownershipStatus === 'plugin_verified' }"><b>3</b><div><strong>核验当前账号</strong><span>{{ account.ownershipStatus === 'plugin_verified' ? '当前账号已核验' : '登录后点击“核验当前账号”' }}</span></div></li>
            <li :class="{ done: Boolean(account.lastSyncedAt) }"><b>4</b><div><strong>同步账号数据</strong><span>{{ account.lastSyncedAt ? '已完成首次同步' : '选择同步范围后开始同步' }}</span></div></li>
          </ol>
        </section>
        <section class="workflow-card sync-action-card">
          <div class="section-heading">
            <div><h3>同步本人数据</h3><p>同步账号资料、作品列表和统计指标。</p></div>
            <button
              class="button primary"
              :disabled="busy || !supportsManagedSync || account.ownershipStatus !== 'plugin_verified' || !account.syncEnabled"
              @click="syncOwnedData"
            >{{ busy ? '同步中…' : '立即同步' }}</button>
          </div>
          <p v-if="!supportsManagedSync" class="muted">该平台的数据同步功能仍在开发中。</p>
          <p v-else-if="account.ownershipStatus !== 'plugin_verified'" class="muted">请先登录账号，再到“浏览器”页签核验当前账号。</p>
          <p v-else-if="!account.syncEnabled" class="muted">请在“设置与备注”中启用数据同步。</p>
          <p v-else class="muted">将自动使用该账号的登录会话；需要重新登录时会打开账号浏览器。</p>
          <p v-if="localMessage" class="success-message">{{ localMessage }}</p>
        </section>
      </div>

      <div v-else-if="activeTab === 'browser'" class="detail-scroll">
        <section class="browser-launch-card">
          <div class="browser-illustration">
            <div class="mini-window"><span></span><span></span><span></span><i></i></div>
          </div>
          <div class="browser-launch-copy">
            <span class="eyebrow">账号浏览器</span>
            <h3>在独立窗口中完成登录</h3>
            <p>打开浏览器后，按平台页面提示完成登录。关闭窗口后，下次可以继续使用当前登录状态。</p>
            <ul><li>可使用前进、后退和刷新</li><li>登录完成后返回这里核验账号</li></ul>
            <div class="browser-actions" role="group" aria-label="账号浏览器操作">
              <button class="button primary large-action browser-open-action" type="button" :disabled="busy" @click="openBrowserWindow">
                {{ browserState?.windowOpen ? '切换到已打开的窗口' : account.connectionStatus === 'disconnected' ? `重新打开 ${platform?.name}` : `打开 ${platform?.name} 登录页面` }} ↗
              </button>
              <div v-if="supportsManagedSync" class="browser-followup-actions">
                <button
                  class="button large-action verify-action"
                  type="button"
                  :disabled="busy"
                  @click="verifyLoginIdentity"
                >{{ busy ? '正在核验…' : '核验当前账号' }}</button>
                <button
                  class="button primary large-action sync-action"
                  type="button"
                  :disabled="busy || account.ownershipStatus !== 'plugin_verified' || !account.syncEnabled"
                  @click="syncOwnedData"
                >{{ busy ? '同步中…' : `同步数据 · ${syncModeLabel(account.syncMode)}` }}</button>
              </div>
            </div>
            <p v-if="!supportsManagedSync" class="muted">该平台的数据同步功能仍在开发中。</p>
            <p v-if="verification" :class="{ 'success-message': verification.status === 'verified', 'danger-text': verification.status === 'identity_mismatch', muted: !['verified', 'identity_mismatch'].includes(verification.status) }">{{ verification.message }}<template v-if="verification.remoteName"> 当前身份：{{ verification.remoteName }}</template></p>
            <div v-if="verification?.status === 'confirmation_required'" class="form-actions">
              <button class="button primary" :disabled="busy" @click="confirmLoginIdentity">确认绑定此账号</button>
              <button class="button" :disabled="busy" @click="verification = null">暂不绑定</button>
            </div>
          </div>
        </section>
        <section v-if="browserState" class="browser-session-status">
          <div><span>窗口</span><strong>{{ browserState.windowOpen ? '已打开' : '已关闭' }}</strong></div>
          <div class="session-address"><span>最近地址</span><strong>{{ browserState.url || platform?.loginUrl }}</strong></div>
        </section>
      </div>

      <div v-else-if="activeTab === 'content'" class="detail-scroll">
        <AccountContentWidget :account-id="account.id" :refresh-key="account.lastSyncedAt" />
      </div>

      <form v-else class="detail-scroll settings-form" @submit.prevent="saveSettings">
        <div class="settings-grid">
          <label>本地备注名（可选）<input v-model="form.alias" maxlength="40" placeholder="留空时显示平台昵称" /></label>
          <label>标签<input v-model="form.tags" placeholder="使用逗号分隔，例如：工作, 重点" /></label>
        </div>
        <label v-if="adapters.length > 1">数据适配器<select :value="account.adapterContributionId ?? ''" :disabled="busy" @change="switchAdapter"><option v-for="adapter in adapters" :key="adapter.contributionId" :value="adapter.contributionId" :disabled="!adapter.available && !adapter.selected">{{ adapter.name }}{{ adapter.selected ? '（当前）' : adapter.available ? '' : '（不可用）' }}</option></select><small>切换前会重新核验稳定账号身份，不会清空历史内容与指标。</small></label>
        <label>账号备注<textarea v-model="form.note" rows="4" maxlength="1000" placeholder="负责人、内容方向、登录说明等"></textarea></label>
        <fieldset>
          <legend>所属分组</legend>
          <label v-for="group in groups" :key="group.id" class="checkbox"><input v-model="form.groupIds" type="checkbox" :value="group.id" />{{ group.name }}</label>
          <span v-if="groups.length === 0" class="muted">尚未创建自定义分组</span>
        </fieldset>
        <div class="settings-grid">
          <label>数据同步范围<select v-model="form.syncMode"><option value="profile_only">仅账号资料与指标（推荐）</option><option value="recent_20">最近 20 条作品</option><option value="recent_100">最近 100 条作品</option><option value="disabled">不启用同步</option></select></label>
          <label class="checkbox default-check"><input v-model="form.isDefault" type="checkbox" />设为该平台默认账号</label>
        </div>
        <div class="form-actions"><button class="button primary" :disabled="busy" type="submit">保存设置</button><button class="button" :disabled="syncToggleDisabled" :title="syncAuthorizationReason || undefined" type="button" @click="toggleSync">{{ account.syncEnabled ? '暂停数据同步' : '启用数据同步' }}</button></div>
        <p v-if="syncAuthorizationReason" class="muted">{{ syncAuthorizationReason }}</p>
        <p v-if="localMessage" class="success-message">{{ localMessage }}</p>
        <section class="danger-zone session-zone">
          <div><strong>退出账号浏览器</strong><p>退出该账号的网页登录；账号资料和历史数据会保留。</p></div>
          <button class="button danger" :disabled="busy" type="button" @click="disconnectAccount">退出登录</button>
        </section>
        <section class="danger-zone">
          <div><strong>永久删除本地账号</strong><p>删除会话、账号资料、备注、内容、快照和任务记录；不会删除平台账号。</p></div>
          <button class="button danger strong" :disabled="busy" type="button" @click="purgeAccount">永久删除</button>
        </section>
      </form>
    </template>
  </section>
</template>
