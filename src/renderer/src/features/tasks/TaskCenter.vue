<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { Account, PlatformDefinition } from '../../../../shared/contracts'
import type {
  TaskBatchView,
  TaskAttentionFilter,
  TaskQuery,
  TaskStatus,
  TaskSummary,
  TaskTrigger,
  TaskView
} from '../../../../shared/job-contracts'
import { confirmDialog } from '../../ui/dialog'
import { formatDate, messageOf } from '../shared/format'
import TaskList from './TaskList.vue'
import {
  batchProgress,
  canCancelTask,
  canRetryTask,
  summarizeTaskBatches,
  taskAttentionLabel,
  taskKindLabel,
  taskNeedsLogin,
  taskStatusLabel,
  taskTriggerLabel
} from './task-presentation'

const emit = defineEmits<{ navigate: [target: 'plugins'] }>()

type TaskViewMode = 'tasks' | 'batches'
type TimeRange = 'today' | '7d' | '30d' | 'all'

const emptySummary: TaskSummary = {
  queuedCount: 0,
  runningCount: 0,
  needsAttentionCount: 0,
  completedTodayCount: 0,
  partialTodayCount: 0,
  failedTodayCount: 0,
  updatedAt: ''
}

const summary = ref<TaskSummary>({ ...emptySummary })
const tasks = ref<TaskView[]>([])
const batches = ref<TaskBatchView[]>([])
const total = ref(0)
const accounts = ref<Account[]>([])
const platforms = ref<PlatformDefinition[]>([])
const loading = ref(true)
const error = ref('')
const toast = ref('')
const busyTaskId = ref<string | null>(null)
const viewMode = ref<TaskViewMode>('tasks')
const statusFilter = ref<'all' | TaskStatus>('all')
const attentionFilter = ref<'all' | TaskAttentionFilter>('all')
const triggerFilter = ref<'all' | TaskTrigger>('all')
const platformFilter = ref('all')
const accountFilter = ref('all')
const timeRange = ref<TimeRange>('7d')
const page = ref(1)
const pageSize = 50
const selectedBatch = ref<TaskBatchView | null>(null)
const selectedTask = ref<TaskView | null>(null)
const batchLoading = ref(false)
let removeTaskListener: (() => void) | null = null
let removeAccountListener: (() => void) | null = null
let refreshTimer: number | null = null
let initialized = false
let batchRequestSequence = 0

const pageCount = computed(() => Math.max(1, Math.ceil(total.value / pageSize)))
const batchSummaries = computed(() => summarizeTaskBatches(
  batches.value.flatMap((batch) => batch.tasks.filter(matchesTaskFilters))
))
const filteredAccounts = computed(() => platformFilter.value === 'all'
  ? accounts.value
  : accounts.value.filter((account) => account.platformId === platformFilter.value))

watch([statusFilter, attentionFilter, triggerFilter, platformFilter, accountFilter, timeRange], () => {
  if (!initialized) return
  if (accountFilter.value !== 'all' && !filteredAccounts.value.some((item) => item.id === accountFilter.value)) {
    accountFilter.value = 'all'
    return
  }
  page.value = 1
  selectedBatch.value = null
  void loadTasks()
})

watch(page, () => {
  if (initialized) void loadTasks()
})

onMounted(async () => {
  removeTaskListener = window.socialVault.tasks.onChanged(scheduleRefresh)
  removeAccountListener = window.socialVault.accounts.onChanged(scheduleContextRefresh)
  await loadContext()
  initialized = true
  await reload()
})

onBeforeUnmount(() => {
  removeTaskListener?.()
  removeAccountListener?.()
  if (refreshTimer !== null) window.clearTimeout(refreshTimer)
})

function buildQuery(): TaskQuery {
  const query: TaskQuery = { offset: (page.value - 1) * pageSize, limit: pageSize }
  if (statusFilter.value !== 'all') query.statuses = [statusFilter.value]
  if (attentionFilter.value !== 'all') query.attention = attentionFilter.value
  if (triggerFilter.value !== 'all') query.triggers = [triggerFilter.value]
  if (platformFilter.value !== 'all') query.platformId = platformFilter.value
  if (accountFilter.value !== 'all') query.accountId = accountFilter.value
  const createdFrom = timeRangeStart(timeRange.value)
  if (createdFrom) query.createdFrom = createdFrom
  return query
}

function timeRangeStart(value: TimeRange): string | undefined {
  if (value === 'all') return undefined
  const date = new Date()
  if (value === 'today') date.setHours(0, 0, 0, 0)
  else date.setDate(date.getDate() - (value === '7d' ? 7 : 30))
  return date.toISOString()
}

async function loadContext(): Promise<void> {
  try {
    const [accountResult, platformResult] = await Promise.all([
      window.socialVault.accounts.list(),
      window.socialVault.platforms.list()
    ])
    accounts.value = accountResult
    platforms.value = platformResult
  } catch (cause) {
    error.value = messageOf(cause)
  }
}

async function loadTasks(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const result = await window.socialVault.tasks.list(buildQuery())
    tasks.value = result.items
    total.value = result.total
    if (page.value > Math.max(1, Math.ceil(result.total / pageSize))) {
      page.value = Math.max(1, Math.ceil(result.total / pageSize))
    }
  } catch (cause) {
    error.value = messageOf(cause)
  } finally {
    loading.value = false
  }
}

async function reload(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const [summaryResult, listResult, batchResult] = await Promise.all([
      window.socialVault.tasks.summary(),
      window.socialVault.tasks.list(buildQuery()),
      window.socialVault.tasks.listBatches()
    ])
    summary.value = summaryResult
    tasks.value = listResult.items
    total.value = listResult.total
    batches.value = batchResult
  } catch (cause) {
    error.value = messageOf(cause)
  } finally {
    loading.value = false
  }
}

function matchesTaskFilters(task: TaskView): boolean {
  if (statusFilter.value !== 'all' && task.status !== statusFilter.value) return false
  if (attentionFilter.value === 'pending' && task.attentionState !== 'pending') return false
  if (attentionFilter.value === 'resolved' && task.attentionState !== 'handled' && task.attentionState !== 'superseded') return false
  if (triggerFilter.value !== 'all' && task.trigger !== triggerFilter.value) return false
  if (platformFilter.value !== 'all' && task.platformId !== platformFilter.value) return false
  if (accountFilter.value !== 'all' && task.accountId !== accountFilter.value) return false
  const createdFrom = timeRangeStart(timeRange.value)
  return !createdFrom || task.createdAt >= createdFrom
}

function scheduleRefresh(): void {
  if (refreshTimer !== null) window.clearTimeout(refreshTimer)
  refreshTimer = window.setTimeout(() => {
    refreshTimer = null
    void reload()
    if (selectedBatch.value) void openBatch(selectedBatch.value.batch.id)
    if (selectedTask.value) void inspectTask(selectedTask.value)
  }, 180)
}

function scheduleContextRefresh(): void {
  void loadContext()
  scheduleRefresh()
}

async function cancelTask(task: TaskView): Promise<void> {
  if (busyTaskId.value || !canCancelTask(task)) return
  const confirmed = await confirmDialog({
    title: '取消这个排队任务？',
    description: '任务尚未开始，可以安全地从队列中移除。',
    confirmLabel: '取消任务',
    tone: 'warning'
  })
  if (!confirmed) return
  busyTaskId.value = task.id
  try {
    await window.socialVault.tasks.cancel(task.id)
    showToast('任务已取消。')
    await reload()
    if (selectedBatch.value) await openBatch(selectedBatch.value.batch.id)
  } catch (cause) {
    error.value = messageOf(cause)
  } finally {
    busyTaskId.value = null
  }
}

async function retryTask(task: TaskView): Promise<void> {
  if (busyTaskId.value || !canRetryTask(task)) return
  busyTaskId.value = task.id
  try {
    await window.socialVault.tasks.retry(task.id)
    showToast('已创建新的重试任务。')
    selectedTask.value = null
    await reload()
    if (selectedBatch.value) await openBatch(selectedBatch.value.batch.id)
  } catch (cause) {
    error.value = messageOf(cause)
  } finally {
    busyTaskId.value = null
  }
}

async function markTaskHandled(task: TaskView): Promise<void> {
  if (busyTaskId.value || task.attentionState !== 'pending') return
  const confirmed = await confirmDialog({
    title: '将这个失败标为已处理？',
    description: '任务的失败状态和错误详情会继续保留，但不再计入“需要处理”。',
    confirmLabel: '标为已处理'
  })
  if (!confirmed) return
  busyTaskId.value = task.id
  try {
    const handled = await window.socialVault.tasks.markHandled({
      source: task.source,
      taskId: task.id
    })
    if (selectedTask.value?.id === task.id && selectedTask.value.source === task.source) {
      selectedTask.value = handled
    }
    showToast('已从需要处理列表移除，失败记录仍保留。')
    await reload()
    if (selectedBatch.value) await openBatch(selectedBatch.value.batch.id)
  } catch (cause) {
    error.value = messageOf(cause)
  } finally {
    busyTaskId.value = null
  }
}

async function openAccountBrowser(task: TaskView): Promise<void> {
  if (!task.accountId || busyTaskId.value) return
  busyTaskId.value = task.id
  try {
    await window.socialVault.browser.open(task.accountId)
    showToast('已打开账号浏览器，请完成登录后重新同步。')
  } catch (cause) {
    error.value = messageOf(cause)
  } finally {
    busyTaskId.value = null
  }
}

async function openBatch(batchId: string): Promise<void> {
  const sequence = ++batchRequestSequence
  batchLoading.value = true
  try {
    const batch = await window.socialVault.tasks.listBatch(batchId)
    if (!batch) throw new Error('同步批次不存在或已清理')
    if (sequence === batchRequestSequence) selectedBatch.value = batch
  } catch (cause) {
    if (sequence === batchRequestSequence) error.value = messageOf(cause)
  } finally {
    if (sequence === batchRequestSequence) batchLoading.value = false
  }
}

function closeBatchDialog(): void {
  batchRequestSequence += 1
  batchLoading.value = false
  selectedBatch.value = null
}

async function inspectTask(task: TaskView): Promise<void> {
  try {
    const detail = await window.socialVault.tasks.get(task.id)
    if (!detail) throw new Error('任务不存在或已清理')
    selectedTask.value = detail
  } catch (cause) {
    error.value = messageOf(cause)
  }
}

function resetFilters(): void {
  statusFilter.value = 'all'
  attentionFilter.value = 'all'
  triggerFilter.value = 'all'
  platformFilter.value = 'all'
  accountFilter.value = 'all'
  timeRange.value = '7d'
}

function showToast(value: string): void {
  toast.value = value
  window.setTimeout(() => {
    if (toast.value === value) toast.value = ''
  }, 2800)
}

function paginationStatusLabel(value: boolean | null): string {
  if (value === true) return '已到末页'
  if (value === false) return '尚有下一页'
  return '未知'
}
</script>

<template>
  <div class="task-page">
    <header class="page-header task-page-header">
      <div>
        <span class="page-eyebrow">执行与同步</span>
        <h1>任务中心</h1>
        <p>查看同步进度、批次结果和需要处理的账号</p>
      </div>
      <div class="task-header-actions">
        <button class="button" type="button" @click="emit('navigate', 'plugins')">管理自动计划</button>
        <button class="button" type="button" :disabled="loading" @click="reload">
          {{ loading ? '刷新中…' : '刷新' }}
        </button>
      </div>
    </header>

    <div v-if="error" class="alert error">
      <span>{{ error }}</span>
      <button type="button" @click="error = ''">关闭</button>
    </div>

    <section class="task-summary-grid" aria-label="任务摘要">
      <article class="feature-card tone-brand">
        <span>排队</span><strong>{{ summary.queuedCount }}</strong><small>等待调度</small>
      </article>
      <article class="feature-card tone-running">
        <span>运行中</span><strong>{{ summary.runningCount }}</strong><small>正在处理</small>
      </article>
      <article class="feature-card tone-warning">
        <span>需要处理</span><strong>{{ summary.needsAttentionCount }}</strong><small>尚未解决的失败或中断</small>
      </article>
      <article class="feature-card tone-success">
        <span>今日完成</span><strong>{{ summary.completedTodayCount }}</strong><small>{{ summary.partialTodayCount }} 个部分完成 · {{ summary.failedTodayCount }} 个失败</small>
      </article>
    </section>

    <section class="task-filter-card feature-card" aria-label="任务筛选">
      <div class="task-view-switch" role="tablist" aria-label="任务展示方式">
        <button type="button" :class="{ active: viewMode === 'tasks' }" role="tab" :aria-selected="viewMode === 'tasks'" @click="viewMode = 'tasks'">任务</button>
        <button type="button" :class="{ active: viewMode === 'batches' }" role="tab" :aria-selected="viewMode === 'batches'" @click="viewMode = 'batches'">批次</button>
      </div>
      <label>状态<select v-model="statusFilter"><option value="all">全部状态</option><option value="queued">排队中</option><option value="running">运行中</option><option value="succeeded">已完成</option><option value="succeeded_with_warnings">部分完成</option><option value="failed">失败</option><option value="interrupted">已中断</option><option value="paused">已暂停</option><option value="cancelled">已取消</option></select></label>
      <label>处置<select v-model="attentionFilter"><option value="all">全部处置</option><option value="pending">需要处理</option><option value="resolved">已解决</option></select></label>
      <label>触发<select v-model="triggerFilter"><option value="all">全部来源</option><option value="manual">手动</option><option value="scheduled">定时</option><option value="event">事件</option><option value="retry">重试</option></select></label>
      <label>平台<select v-model="platformFilter"><option value="all">全部平台</option><option v-for="platform in platforms" :key="platform.id" :value="platform.id">{{ platform.name }}</option></select></label>
      <label>账号<select v-model="accountFilter"><option value="all">全部账号</option><option v-for="account in filteredAccounts" :key="account.id" :value="account.id">{{ account.alias || account.remoteName || account.id }}</option></select></label>
      <label>时间<select v-model="timeRange"><option value="today">今天</option><option value="7d">最近 7 天</option><option value="30d">最近 30 天</option><option value="all">全部时间</option></select></label>
      <button class="task-reset" type="button" @click="resetFilters">重置</button>
    </section>

    <div class="task-results-head">
      <div><strong>{{ viewMode === 'tasks' ? '任务记录' : '同步批次' }}</strong><span>共 {{ viewMode === 'tasks' ? total : batchSummaries.length }} 项</span></div>
      <span v-if="summary.updatedAt">更新于 {{ formatDate(summary.updatedAt, true) }}</span>
    </div>

    <div v-if="loading && tasks.length === 0" class="feature-card task-loading">正在读取任务…</div>
    <TaskList
      v-else-if="viewMode === 'tasks'"
      :tasks="tasks"
      :accounts="accounts"
      :platforms="platforms"
      :busy-task-id="busyTaskId"
      @cancel="cancelTask"
      @retry="retryTask"
      @handle="markTaskHandled"
      @open-browser="openAccountBrowser"
      @inspect="inspectTask"
    />
    <section v-else class="task-batch-list">
      <button
        v-for="batch in batchSummaries"
        :key="batch.id"
        class="task-batch-card feature-card"
        type="button"
        :class="{ active: selectedBatch?.batch.id === batch.id }"
        @click="openBatch(batch.id)"
      >
        <span class="batch-card-icon" aria-hidden="true">≡</span>
        <span class="batch-card-copy"><strong>同步批次 · {{ formatDate(batch.createdAt, true) }}</strong><small>{{ taskTriggerLabel(batch.trigger) }}触发 · {{ batch.totalCount }} 个任务<span v-if="batch.needsAttentionCount"> · {{ batch.needsAttentionCount }} 个需处理</span></small></span>
        <span class="batch-card-counts"><b>{{ batch.succeededCount }}</b><small>完成</small></span>
        <span class="batch-card-counts warning"><b>{{ batch.partialCount }}</b><small>部分完成</small></span>
        <span class="batch-card-progress"><i><b :style="{ width: `${batchProgress(batch)}%` }" /></i><small>{{ batchProgress(batch) }}%</small></span>
        <span class="batch-card-arrow">›</span>
      </button>
      <div v-if="batchSummaries.length === 0" class="feature-card task-empty-batches"><strong>没有符合条件的同步批次</strong><p>从账号中心发起批量同步后，批次会显示在这里。</p></div>
    </section>

    <footer v-if="viewMode === 'tasks' && total > pageSize" class="task-pagination">
      <button class="button" type="button" :disabled="page <= 1 || loading" @click="page -= 1">上一页</button>
      <span>第 {{ page }} / {{ pageCount }} 页</span>
      <button class="button" type="button" :disabled="page >= pageCount || loading" @click="page += 1">下一页</button>
    </footer>

    <div v-if="selectedBatch || batchLoading" class="modal-backdrop" @click.self="closeBatchDialog">
      <section class="modal task-batch-dialog" role="dialog" aria-modal="true" aria-labelledby="task-batch-title" @keydown.esc="closeBatchDialog">
        <div class="modal-head">
          <div><span class="page-eyebrow">批次详情</span><h2 id="task-batch-title">{{ selectedBatch ? `同步批次 · ${formatDate(selectedBatch.batch.createdAt, true)}` : '正在读取批次' }}</h2><p v-if="selectedBatch">{{ taskTriggerLabel(selectedBatch.batch.trigger) }}触发 · 同步范围 {{ selectedBatch.batch.requestedScope === 'account_default' ? '按账号默认设置' : selectedBatch.batch.requestedScope === 'profile_only' ? '仅资料' : selectedBatch.batch.requestedScope === 'recent_20' ? '最近 20 条' : '最近 100 条' }}</p></div>
          <button type="button" aria-label="关闭批次详情" @click="closeBatchDialog">×</button>
        </div>
        <div v-if="selectedBatch" class="batch-dialog-summary"><span>共 {{ selectedBatch.totalCount }}</span><span>{{ selectedBatch.succeededCount }} 完成</span><span>{{ selectedBatch.partialCount }} 部分完成</span><span>{{ selectedBatch.runningCount }} 运行中</span><span>{{ selectedBatch.needsAttentionCount }} 需处理</span></div>
        <div class="batch-dialog-content">
          <div v-if="batchLoading" class="task-loading">正在读取批次任务…</div>
          <TaskList
            v-else-if="selectedBatch"
            :tasks="selectedBatch.tasks"
            :accounts="accounts"
            :platforms="platforms"
            :busy-task-id="busyTaskId"
            @cancel="cancelTask"
            @retry="retryTask"
            @handle="markTaskHandled"
            @open-browser="openAccountBrowser"
            @inspect="inspectTask"
          />
        </div>
      </section>
    </div>

    <div v-if="selectedTask" class="modal-backdrop" @click.self="selectedTask = null">
      <section class="modal task-detail-dialog" role="dialog" aria-modal="true" aria-labelledby="task-detail-title" @keydown.esc="selectedTask = null">
        <div class="modal-head"><div><span class="page-eyebrow">任务详情</span><h2 id="task-detail-title">{{ taskKindLabel(selectedTask.kind) }}</h2><p>{{ taskStatusLabel(selectedTask.status) }} · {{ taskTriggerLabel(selectedTask.trigger) }}触发</p></div><button type="button" aria-label="关闭任务详情" @click="selectedTask = null">×</button></div>
        <dl class="task-detail-list">
          <div><dt>任务 ID</dt><dd>{{ selectedTask.id }}</dd></div>
          <div><dt>账号</dt><dd>{{ selectedTask.accountAlias || selectedTask.accountId || '通用任务' }}</dd></div>
          <div v-if="selectedTask.pluginId"><dt>插件</dt><dd>{{ selectedTask.pluginId }}<span v-if="selectedTask.contributionId"> · {{ selectedTask.contributionId }}</span></dd></div>
          <div><dt>阶段</dt><dd>{{ selectedTask.stage || '—' }}<span v-if="selectedTask.progress !== null"> · {{ selectedTask.progress }}%</span></dd></div>
          <div v-if="selectedTask.coverage"><dt>同步覆盖</dt><dd>请求 {{ selectedTask.coverage.requestedContentCount }} 条 · 实际 {{ selectedTask.coverage.actualContentCount }} 条 · 分页 {{ paginationStatusLabel(selectedTask.coverage.paginationEnded) }}</dd></div>
          <div><dt>创建时间</dt><dd>{{ formatDate(selectedTask.createdAt, true) }}</dd></div>
          <div v-if="selectedTask.startedAt"><dt>开始时间</dt><dd>{{ formatDate(selectedTask.startedAt, true) }}</dd></div>
          <div v-if="selectedTask.finishedAt"><dt>结束时间</dt><dd>{{ formatDate(selectedTask.finishedAt, true) }}</dd></div>
          <div v-if="selectedTask.attentionState"><dt>处置状态</dt><dd>{{ taskAttentionLabel(selectedTask.attentionState) }}<span v-if="selectedTask.attentionResolvedAt"> · {{ formatDate(selectedTask.attentionResolvedAt, true) }}</span></dd></div>
          <div v-if="selectedTask.warnings.length" class="detail-warning"><dt>同步提示</dt><dd><span v-for="(warning, index) in selectedTask.warnings" :key="index">{{ warning }}</span></dd></div>
          <div v-if="selectedTask.errorCode || selectedTask.errorMessage" class="detail-error"><dt>错误</dt><dd><b v-if="selectedTask.errorCode">{{ selectedTask.errorCode }}</b>{{ selectedTask.errorMessage }}</dd></div>
        </dl>
        <div class="modal-actions"><button class="button" type="button" @click="selectedTask = null">关闭</button><button v-if="selectedTask.kind !== 'account.sync'" class="button" type="button" @click="emit('navigate', 'plugins'); selectedTask = null">打开插件中心</button><button v-if="taskNeedsLogin(selectedTask)" class="button" type="button" :disabled="busyTaskId === selectedTask.id" @click="openAccountBrowser(selectedTask)">处理登录</button><button v-if="canCancelTask(selectedTask)" class="button" type="button" :disabled="busyTaskId === selectedTask.id" @click="cancelTask(selectedTask)">取消任务</button><button v-if="selectedTask.attentionState === 'pending'" class="button" type="button" :disabled="busyTaskId === selectedTask.id" @click="markTaskHandled(selectedTask)">标为已处理</button><button v-if="canRetryTask(selectedTask)" class="button primary" type="button" :disabled="busyTaskId === selectedTask.id" @click="retryTask(selectedTask)">重试</button></div>
      </section>
    </div>

    <div v-if="toast" class="toast">{{ toast }}</div>
  </div>
</template>

<style scoped>
.task-page { display: flex; height: 100%; min-height: 0; flex-direction: column; overflow: auto; }
.task-page-header { flex: 0 0 auto; }
.task-header-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
.task-summary-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 11px; margin-bottom: 12px; }
.task-summary-grid article { position: relative; display: grid; min-height: 102px; gap: 2px; padding: 14px 15px 13px 18px; overflow: hidden; }
.task-summary-grid article::before { position: absolute; inset: 13px auto 13px 0; width: 3px; background: var(--brand); border-radius: 0 4px 4px 0; content: ''; }
.task-summary-grid article.tone-running::before { background: var(--accent); }
.task-summary-grid article.tone-warning::before { background: var(--warning); }
.task-summary-grid article.tone-success::before { background: var(--success); }
.task-summary-grid span, .task-summary-grid small { color: var(--text-tertiary); font-size: var(--font-secondary); line-height: var(--line-secondary); }
.task-summary-grid strong { color: var(--text); font-size: var(--font-metric); line-height: var(--line-metric); letter-spacing: -.02em; }
.task-summary-grid small { font-size: var(--font-caption); line-height: var(--line-caption); }
.task-filter-card { display: grid; grid-template-columns: auto repeat(6, minmax(110px, 1fr)) auto; align-items: end; gap: 9px; margin-bottom: 12px; padding: 11px; }
.task-filter-card label { display: grid; gap: 4px; color: var(--text-secondary); font-size: var(--font-caption); line-height: var(--line-caption); }
.task-filter-card select { min-height: 36px; padding-block: 7px; }
.task-view-switch { display: flex; min-height: 36px; padding: 3px; background: var(--surface-subtle); border: 1px solid var(--border); border-radius: 9px; }
.task-view-switch button { min-width: 58px; padding: 4px 9px; color: var(--text-secondary); background: transparent; border: 0; border-radius: 6px; cursor: pointer; font-size: var(--font-body); line-height: var(--line-body); }
.task-view-switch button.active { color: var(--text); background: var(--surface); box-shadow: var(--shadow-sm); font-weight: 620; }
.task-reset { min-height: 36px; padding: 6px 10px; color: var(--text-secondary); background: var(--surface); border: 1px solid var(--border); border-radius: 8px; cursor: pointer; }
.task-results-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 3px 2px 9px; }
.task-results-head > div { display: flex; align-items: baseline; gap: 8px; }
.task-results-head strong { font-size: var(--font-section); line-height: var(--line-section); }
.task-results-head span { color: var(--text-tertiary); font-size: var(--font-caption); line-height: var(--line-caption); }
.task-loading { display: grid; min-height: 220px; place-items: center; color: var(--text-tertiary); font-size: var(--font-secondary); line-height: var(--line-secondary); }
.task-batch-list { display: grid; gap: 8px; }
.task-batch-card { display: grid; width: 100%; grid-template-columns: 38px minmax(190px, 1fr) 58px 58px minmax(130px, .5fr) 20px; align-items: center; gap: 12px; padding: 13px 14px; color: var(--text); text-align: left; cursor: pointer; }
.task-batch-card:hover, .task-batch-card.active { background: color-mix(in srgb, var(--brand-soft) 42%, var(--surface)); border-color: color-mix(in srgb, var(--brand) 30%, var(--border)); }
.batch-card-icon { display: grid; width: 36px; height: 36px; place-items: center; color: var(--brand); background: var(--brand-soft); border-radius: 10px; font-size: var(--font-title); line-height: 1; }
.batch-card-copy { display: grid; min-width: 0; gap: 2px; }
.batch-card-copy strong, .batch-card-copy small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.batch-card-copy strong { font-size: var(--font-body); line-height: var(--line-body); }
.batch-card-copy small, .batch-card-counts small, .batch-card-progress small { color: var(--text-tertiary); font-size: var(--font-caption); line-height: var(--line-caption); }
.batch-card-counts { display: grid; justify-items: center; }
.batch-card-counts b { color: var(--success); font-size: var(--font-section); line-height: var(--line-section); }
.batch-card-counts.warning b { color: var(--warning); }
.batch-card-progress { display: grid; grid-template-columns: minmax(70px, 1fr) 34px; align-items: center; gap: 7px; }
.batch-card-progress > i { height: 6px; overflow: hidden; background: var(--surface-hover); border-radius: 99px; }
.batch-card-progress > i > b { display: block; height: 100%; background: var(--brand); border-radius: inherit; }
.batch-card-arrow { color: var(--text-tertiary); font-size: 25px; }
.task-empty-batches { display: grid; min-height: 220px; place-content: center; justify-items: center; gap: 5px; color: var(--text-tertiary); text-align: center; }
.task-empty-batches strong { color: var(--text); }
.task-empty-batches p { font-size: var(--font-secondary); line-height: var(--line-secondary); }
.task-pagination { display: flex; justify-content: center; align-items: center; gap: 12px; padding: 14px 0 2px; }
.task-pagination span { color: var(--text-secondary); font-size: var(--font-secondary); line-height: var(--line-secondary); }
.task-pagination .button { min-height: 34px; padding: 5px 11px; }
.task-batch-dialog { width: min(1180px, 96vw); max-height: min(780px, 90vh); grid-template-rows: auto auto minmax(0, 1fr); }
.batch-dialog-summary { display: flex; flex-wrap: wrap; gap: 7px; }
.batch-dialog-summary span { padding: 5px 9px; color: var(--text-secondary); background: var(--surface-subtle); border: 1px solid var(--border); border-radius: 99px; font-size: var(--font-caption); line-height: var(--line-caption); }
.batch-dialog-content { min-height: 0; overflow: auto; }
.task-detail-dialog { width: min(560px, 100%); }
.task-detail-list { display: grid; gap: 1px; overflow: hidden; background: var(--border); border: 1px solid var(--border); border-radius: 10px; }
.task-detail-list > div { display: grid; grid-template-columns: 105px minmax(0, 1fr); gap: 12px; padding: 10px 11px; background: var(--surface-subtle); }
.task-detail-list dt { color: var(--text-tertiary); font-size: var(--font-caption); line-height: var(--line-caption); }
.task-detail-list dd { min-width: 0; margin: 0; overflow-wrap: anywhere; color: var(--text-secondary); font-size: var(--font-secondary); line-height: var(--line-secondary); }
.task-detail-list .detail-error dd { display: grid; gap: 3px; color: var(--danger); }
.task-detail-list .detail-error b { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: var(--font-caption); }
.task-detail-list .detail-warning dd { display: grid; gap: 4px; color: var(--warning); }
@media (max-width: 1180px) {
  .task-filter-card { grid-template-columns: auto repeat(3, minmax(125px, 1fr)); }
  .task-filter-card label:nth-of-type(n + 4), .task-filter-card > .task-reset { grid-row: 2; }
}
@media (max-width: 980px) {
  .task-summary-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .task-batch-card { grid-template-columns: 38px minmax(170px, 1fr) 52px 52px 18px; }
  .batch-card-progress { display: none; }
}
</style>
