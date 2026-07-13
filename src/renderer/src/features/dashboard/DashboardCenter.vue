<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { Account, DashboardOverview } from '../../../../shared/contracts'
import { accountDisplayName } from '../accounts/presentation'
import { formatDate, formatNumber, messageOf, platformLabel } from '../shared/format'

const emit = defineEmits<{ navigate: [section: 'accounts'] }>()

const overview = ref<DashboardOverview | null>(null)
const accounts = ref<Account[]>([])
const loading = ref(true)
const error = ref('')

const recentlySyncedAccounts = computed(() => accounts.value
  .filter((account) => account.lastSyncedAt)
  .sort((left, right) => (right.lastSyncedAt ?? '').localeCompare(left.lastSyncedAt ?? ''))
  .slice(0, 5))

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const [dashboard, accountResult] = await Promise.all([
      window.socialVault.analytics.dashboard(),
      window.socialVault.accounts.list()
    ])
    overview.value = dashboard
    accounts.value = accountResult
  } catch (cause) {
    error.value = messageOf(cause)
  } finally {
    loading.value = false
  }
}

onMounted(() => void load())
</script>

<template>
  <div class="feature-page dashboard-page">
    <header class="page-header feature-header">
      <div>
        <span class="page-eyebrow">本地概览</span>
        <h1>工作台</h1>
        <p>查看账号、内容和指标的汇总情况</p>
      </div>
      <button class="button" :disabled="loading" @click="load">刷新</button>
    </header>

    <div v-if="error" class="alert error"><span>{{ error }}</span><button @click="error = ''">关闭</button></div>
    <div v-if="loading && !overview" class="feature-loading">正在汇总本地数据…</div>

    <template v-else-if="overview">
      <section class="dashboard-metrics" aria-label="数据概览">
        <article><span>账号</span><strong>{{ formatNumber(overview.accountCount) }}</strong><small>{{ overview.readyAccountCount }} 个账号可以同步</small></article>
        <article><span>已同步内容</span><strong>{{ formatNumber(overview.contentCount) }}</strong><small>已收录的作品数量</small></article>
        <article><span>浏览量</span><strong>{{ formatNumber(overview.views) }}</strong><small>各平台可见口径的合计</small></article>
        <article><span>互动量</span><strong>{{ formatNumber(overview.interactions) }}</strong><small>赞、评、转、藏的可见合计</small></article>
      </section>

      <section v-if="overview.contentCount === 0" class="onboarding-card">
        <div class="onboarding-icon">↻</div>
        <div>
          <span class="page-eyebrow">开始使用</span>
          <h2>{{ accounts.length === 0 ? '添加第一个账号' : '开始同步账号数据' }}</h2>
          <p>{{ accounts.length === 0 ? '添加账号后，在独立浏览器中完成登录。' : '选择账号，完成身份核验后即可同步资料、作品和指标。' }}</p>
        </div>
        <div class="onboarding-actions">
          <button class="button primary" @click="emit('navigate', 'accounts')">{{ accounts.length === 0 ? '添加账号' : '前往账号中心' }}</button>
        </div>
      </section>

      <div class="dashboard-columns">
        <section class="feature-card reminder-card">
          <div class="feature-card-head"><div><h2>需要留意</h2><p>连接、身份和数据同步提醒</p></div><span>{{ overview.reminders.length }}</span></div>
          <div v-if="overview.reminders.length === 0" class="compact-empty"><strong>暂无提醒</strong><span>当前本地状态正常。</span></div>
          <button
            v-for="reminder in overview.reminders"
            :key="reminder.id"
            class="reminder-row"
            :class="reminder.tone"
            @click="reminder.accountId && emit('navigate', 'accounts')"
          >
            <i></i><span><strong>{{ reminder.title }}</strong><small>{{ reminder.detail }}</small></span><b v-if="reminder.accountId">→</b>
          </button>
        </section>

        <section class="feature-card recent-card">
          <div class="feature-card-head"><div><h2>最近同步</h2><p>查看各账号最近一次同步时间</p></div><span>{{ recentlySyncedAccounts.length }}</span></div>
          <div v-if="recentlySyncedAccounts.length === 0" class="compact-empty"><strong>还没有同步记录</strong><span>完成账号登录和身份确认后，可在账号中心发起同步。</span></div>
          <div v-for="account in recentlySyncedAccounts" :key="account.id" class="recent-row">
            <span class="content-kind">已同步</span>
            <span><strong>{{ accountDisplayName(account, platformLabel(account.platformId)) }}</strong><small>{{ account.remoteName || '本人身份已确认' }}</small></span>
            <b>{{ formatDate(account.lastSyncedAt, true) }}</b>
          </div>
        </section>
      </div>
    </template>
  </div>
</template>
