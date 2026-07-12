<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { Account, DashboardOverview, JobRecord } from '../../../../shared/contracts'
import { formatDate, formatNumber, jobStatusLabel, messageOf } from '../shared/format'

const emit = defineEmits<{ navigate: [section: 'accounts' | 'plugins'] }>()

const overview = ref<DashboardOverview | null>(null)
const accounts = ref<Account[]>([])
const jobs = ref<JobRecord[]>([])
const loading = ref(true)
const error = ref('')
let removeJobListener: (() => void) | null = null

const recentJobs = computed(() => [...jobs.value]
  .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  .slice(0, 5))

function accountName(id: string): string {
  return accounts.value.find((account) => account.id === id)?.alias ?? '已移除账号'
}

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const [dashboard, accountResult, jobResult] = await Promise.all([
      window.socialVault.analytics.dashboard(),
      window.socialVault.accounts.list(),
      window.socialVault.jobs.list()
    ])
    overview.value = dashboard
    accounts.value = accountResult
    jobs.value = jobResult
  } catch (cause) {
    error.value = messageOf(cause)
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  void load()
  removeJobListener = window.socialVault.jobs.onChanged((job) => {
    const index = jobs.value.findIndex((item) => item.id === job.id)
    if (index < 0) jobs.value = [job, ...jobs.value]
    else jobs.value.splice(index, 1, job)
    if (['succeeded', 'failed', 'cancelled'].includes(job.status)) void load()
  })
})

onBeforeUnmount(() => removeJobListener?.())
</script>

<template>
  <div class="feature-page dashboard-page">
    <header class="page-header feature-header">
      <div>
        <span class="page-eyebrow">LOCAL OVERVIEW</span>
        <h1>工作台</h1>
        <p>汇总本机中的本人账号、内容快照和导入状态</p>
      </div>
      <button class="button" :disabled="loading" @click="load">刷新</button>
    </header>

    <div v-if="error" class="alert error"><span>{{ error }}</span><button @click="error = ''">关闭</button></div>
    <div v-if="loading && !overview" class="feature-loading">正在汇总本地数据…</div>

    <template v-else-if="overview">
      <section class="dashboard-metrics" aria-label="数据概览">
        <article><span>本地账号</span><strong>{{ formatNumber(overview.accountCount) }}</strong><small>{{ overview.readyAccountCount }} 个综合状态就绪</small></article>
        <article><span>已归档内容</span><strong>{{ formatNumber(overview.contentCount) }}</strong><small>只统计已导入到本机的数据</small></article>
        <article><span>浏览量</span><strong>{{ formatNumber(overview.views) }}</strong><small>各平台可见口径的合计</small></article>
        <article><span>互动量</span><strong>{{ formatNumber(overview.interactions) }}</strong><small>赞、评、转、藏的可见合计</small></article>
      </section>

      <section v-if="overview.contentCount === 0" class="onboarding-card">
        <div class="onboarding-icon">⇩</div>
        <div>
          <span class="page-eyebrow">FIRST IMPORT</span>
          <h2>导入一份本人数据文件，开始建立本地统计</h2>
          <p>优先使用平台官方导出，也可以采用 Social Vault 模板。文件在本机校验与写入，不需要付费官方 API。</p>
        </div>
        <div class="onboarding-actions">
          <button class="button" @click="emit('navigate', 'accounts')">管理账号</button>
          <button class="button primary" @click="emit('navigate', 'plugins')">开始导入</button>
        </div>
      </section>

      <div class="dashboard-columns">
        <section class="feature-card reminder-card">
          <div class="feature-card-head"><div><h2>需要留意</h2><p>连接、数据和本地任务提醒</p></div><span>{{ overview.reminders.length }}</span></div>
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
          <div class="feature-card-head"><div><h2>最近状态</h2><p>本地导入与处理记录</p></div><small>上次导入 {{ formatDate(overview.lastImportedAt, true) }}</small></div>
          <div v-if="recentJobs.length === 0" class="compact-empty"><strong>还没有处理记录</strong><span>导入数据后会在这里显示进度。</span></div>
          <div v-for="job in recentJobs" :key="job.id" class="recent-row">
            <span class="job-state" :class="job.status">{{ jobStatusLabel(job.status) }}</span>
            <span><strong>{{ accountName(job.accountId) }}</strong><small>{{ job.stage || '文件导入' }} · {{ formatDate(job.createdAt, true) }}</small></span>
            <b>{{ Math.round(job.progress) }}%</b>
          </div>
        </section>
      </div>
    </template>
  </div>
</template>
