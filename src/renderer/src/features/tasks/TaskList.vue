<script setup lang="ts">
import { computed } from 'vue'
import type { Account, PlatformDefinition } from '../../../../shared/contracts'
import type { TaskView } from '../../../../shared/job-contracts'
import { formatDate } from '../shared/format'
import {
  canCancelTask,
  canRetryTask,
  taskKindLabel,
  taskNeedsLogin,
  taskStatusLabel,
  taskStatusTone,
  taskTriggerLabel
} from './task-presentation'

const props = defineProps<{
  tasks: TaskView[]
  accounts: Account[]
  platforms: PlatformDefinition[]
  busyTaskId: string | null
  emptyTitle?: string
  emptyDescription?: string
}>()

const emit = defineEmits<{
  cancel: [task: TaskView]
  retry: [task: TaskView]
  openBrowser: [task: TaskView]
  inspect: [task: TaskView]
}>()

const accountMap = computed(() => new Map(props.accounts.map((account) => [account.id, account])))
const platformMap = computed(() => new Map(props.platforms.map((platform) => [platform.id, platform])))

function accountLabel(task: TaskView): string {
  if (task.accountAlias) return task.accountAlias
  if (!task.accountId) return '通用任务'
  const account = accountMap.value.get(task.accountId)
  return account?.alias || account?.remoteName || task.accountId
}

function platformLabel(task: TaskView): string {
  if (!task.platformId) return task.pluginId ? '插件' : '通用'
  return platformMap.value.get(task.platformId)?.name ?? task.platformId
}

function progressValue(task: TaskView): number {
  return Math.min(100, Math.max(0, task.progress ?? 0))
}
</script>

<template>
  <div v-if="tasks.length" class="task-table-wrap feature-card">
    <table class="task-table">
      <thead>
        <tr>
          <th>状态</th>
          <th>任务</th>
          <th>账号 / 平台</th>
          <th>触发</th>
          <th>进度</th>
          <th>时间</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="task in tasks" :key="task.id">
          <td>
            <span class="task-status" :class="`tone-${taskStatusTone(task.status)}`">
              <i />{{ taskStatusLabel(task.status) }}
            </span>
          </td>
          <td>
            <button class="task-title" type="button" :title="`查看任务 ${task.id}`" @click="emit('inspect', task)">
              <strong>{{ taskKindLabel(task.kind) }}</strong>
              <small>{{ task.batchId ? `批次 ${task.batchId.slice(0, 8)}` : '单独任务' }} · 第 {{ task.attempt }} 次</small>
            </button>
          </td>
          <td>
            <strong class="cell-primary">{{ accountLabel(task) }}</strong>
            <small>{{ platformLabel(task) }}</small>
          </td>
          <td>
            <span class="cell-primary">{{ taskTriggerLabel(task.trigger) }}</span>
            <small v-if="task.nextAttemptAt">下次 {{ formatDate(task.nextAttemptAt, true) }}</small>
          </td>
          <td class="task-progress-cell">
            <div v-if="task.status === 'running' || task.status === 'queued'" class="task-progress" :aria-label="`进度 ${progressValue(task)}%`">
              <span><i :style="{ width: `${progressValue(task)}%` }" /></span>
              <b>{{ progressValue(task) }}%</b>
            </div>
            <span v-else class="cell-primary">{{ task.stage || '—' }}</span>
            <small v-if="task.status === 'running' || task.status === 'queued'">{{ task.stage || '等待调度' }}</small>
            <small v-else-if="task.errorMessage" class="task-error" :title="task.errorMessage">{{ task.errorMessage }}</small>
          </td>
          <td>
            <span class="cell-primary">{{ formatDate(task.startedAt ?? task.createdAt, true) }}</span>
            <small v-if="task.finishedAt">完成于 {{ formatDate(task.finishedAt, true) }}</small>
            <small v-else>{{ task.startedAt ? '已开始' : '已创建' }}</small>
          </td>
          <td>
            <div class="task-actions">
              <button
                v-if="taskNeedsLogin(task)"
                type="button"
                :disabled="busyTaskId === task.id"
                @click="emit('openBrowser', task)"
              >处理登录</button>
              <button
                v-if="canCancelTask(task)"
                type="button"
                :disabled="busyTaskId === task.id"
                @click="emit('cancel', task)"
              >取消</button>
              <button
                v-if="canRetryTask(task)"
                class="primary"
                type="button"
                :disabled="busyTaskId === task.id"
                @click="emit('retry', task)"
              >{{ busyTaskId === task.id ? '处理中…' : '重试' }}</button>
              <button v-if="!taskNeedsLogin(task) && !canCancelTask(task) && !canRetryTask(task)" type="button" @click="emit('inspect', task)">详情</button>
            </div>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
  <div v-else class="feature-card task-empty">
    <span aria-hidden="true">✓</span>
    <strong>{{ emptyTitle ?? '没有符合条件的任务' }}</strong>
    <p>{{ emptyDescription ?? '调整筛选条件，或从账号中心发起同步。' }}</p>
  </div>
</template>

<style scoped>
.task-table-wrap { min-height: 0; overflow: auto; }
.task-table { width: 100%; min-width: 1050px; border-collapse: collapse; text-align: left; }
.task-table th { padding: 10px 12px; color: var(--text-tertiary); background: var(--surface-subtle); border-bottom: 1px solid var(--border); font-size: var(--font-caption); line-height: var(--line-caption); font-weight: 650; white-space: nowrap; }
.task-table td { max-width: 245px; padding: 12px; border-bottom: 1px solid var(--border); vertical-align: middle; font-size: var(--font-secondary); line-height: var(--line-secondary); }
.task-table tbody tr:last-child td { border-bottom: 0; }
.task-table tbody tr:hover { background: color-mix(in srgb, var(--surface-subtle) 58%, transparent); }
.task-table td > small, .task-table td > .cell-primary { display: block; }
.task-table td > small { margin-top: 2px; overflow: hidden; color: var(--text-tertiary); font-size: var(--font-caption); line-height: var(--line-caption); text-overflow: ellipsis; white-space: nowrap; }
.cell-primary { color: var(--text); font-weight: 570; }
.task-title { display: grid; gap: 2px; max-width: 100%; padding: 0; color: var(--text); background: transparent; border: 0; text-align: left; cursor: pointer; }
.task-title:hover strong { color: var(--brand); }
.task-title strong, .task-title small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.task-title small { color: var(--text-tertiary); font-size: var(--font-caption); line-height: var(--line-caption); font-weight: 400; }
.task-status { display: inline-flex; width: max-content; align-items: center; gap: 6px; padding: 4px 8px; color: var(--text-secondary); background: var(--surface-subtle); border: 1px solid var(--border); border-radius: 99px; font-size: var(--font-caption); line-height: var(--line-caption); white-space: nowrap; }
.task-status i { width: 6px; height: 6px; background: currentColor; border-radius: 50%; }
.task-status.tone-brand { color: var(--brand); background: var(--brand-soft); border-color: color-mix(in srgb, var(--brand) 26%, var(--border)); }
.task-status.tone-success { color: var(--success); background: var(--success-soft); border-color: color-mix(in srgb, var(--success) 26%, var(--border)); }
.task-status.tone-warning { color: var(--warning); background: var(--warning-soft); border-color: color-mix(in srgb, var(--warning) 26%, var(--border)); }
.task-status.tone-danger { color: var(--danger); background: var(--danger-soft); border-color: color-mix(in srgb, var(--danger) 26%, var(--border)); }
.task-progress-cell { min-width: 155px; }
.task-progress { display: grid; grid-template-columns: minmax(80px, 1fr) 32px; align-items: center; gap: 8px; }
.task-progress > span { display: block; height: 6px; overflow: hidden; background: var(--surface-hover); border-radius: 99px; }
.task-progress i { display: block; height: 100%; background: var(--brand); border-radius: inherit; transition: width .18s ease; }
.task-progress b { color: var(--text-secondary); font-size: var(--font-caption); line-height: var(--line-caption); font-weight: 600; }
.task-error { max-width: 210px; color: var(--danger) !important; }
.task-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 5px; }
.task-actions button { min-height: 31px; padding: 4px 8px; color: var(--text-secondary); background: var(--surface); border: 1px solid var(--border); border-radius: 7px; cursor: pointer; font-size: var(--font-caption); line-height: var(--line-caption); white-space: nowrap; }
.task-actions button:hover:not(:disabled) { color: var(--text); background: var(--surface-hover); border-color: var(--border-strong); }
.task-actions button.primary { color: var(--brand-contrast); background: var(--brand); border-color: var(--brand); }
.task-actions button:disabled { opacity: .55; cursor: not-allowed; }
.task-empty { display: grid; min-height: 260px; place-content: center; justify-items: center; gap: 8px; padding: 36px; color: var(--text-tertiary); text-align: center; }
.task-empty > span { display: grid; width: 42px; height: 42px; place-items: center; color: var(--success); background: var(--success-soft); border-radius: 12px; font-size: var(--font-title); }
.task-empty strong { color: var(--text); font-size: var(--font-section); line-height: var(--line-section); }
.task-empty p { max-width: 440px; font-size: var(--font-secondary); line-height: var(--line-secondary); }
</style>
