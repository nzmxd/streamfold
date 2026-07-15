import type {
  TaskAttentionState,
  TaskStatus,
  TaskTrigger,
  TaskView
} from '../../../../shared/job-contracts'

export type TaskTone = 'brand' | 'success' | 'warning' | 'danger' | 'muted'

export interface TaskBatchSummary {
  id: string
  trigger: TaskTrigger
  createdAt: string
  finishedAt: string | null
  totalCount: number
  queuedCount: number
  runningCount: number
  succeededCount: number
  needsAttentionCount: number
  cancelledCount: number
}

const loginErrorPattern = /(login|session|auth|credential|identity|expired|mismatch|登录|会话|身份|凭证|过期|不一致)/i

export function taskStatusLabel(status: TaskStatus): string {
  return ({
    queued: '排队中',
    running: '运行中',
    succeeded: '已完成',
    failed: '失败',
    cancelled: '已取消',
    interrupted: '已中断',
    paused: '已暂停'
  } satisfies Record<TaskStatus, string>)[status]
}

export function taskStatusTone(status: TaskStatus): TaskTone {
  if (status === 'succeeded') return 'success'
  if (status === 'running' || status === 'queued') return 'brand'
  if (status === 'failed') return 'danger'
  if (status === 'interrupted' || status === 'paused') return 'warning'
  return 'muted'
}

export function taskTriggerLabel(trigger: TaskTrigger): string {
  return ({
    manual: '手动',
    scheduled: '定时',
    event: '事件',
    retry: '重试'
  } satisfies Record<TaskTrigger, string>)[trigger]
}

export function taskKindLabel(kind: TaskView['kind']): string {
  return ({
    'account.sync': '账号同步',
    'plugin.action': '插件操作',
    'plugin.event': '事件处理',
    'plugin.schedule': '定时任务'
  } satisfies Record<TaskView['kind'], string>)[kind]
}

export function taskAttentionLabel(state: TaskAttentionState | null): string {
  if (state === 'pending') return '需要处理'
  if (state === 'handled') return '已手动处理'
  if (state === 'superseded') return '后续任务已成功'
  return ''
}

export function canCancelTask(task: TaskView): boolean {
  return task.kind === 'account.sync' && task.status === 'queued'
}

export function canRetryTask(task: TaskView): boolean {
  return task.status === 'failed' || task.status === 'interrupted' || task.status === 'paused'
}

export function taskNeedsLogin(task: TaskView): boolean {
  return task.attentionState === 'pending' && Boolean(task.accountId) && (
    loginErrorPattern.test(task.errorCode) ||
    loginErrorPattern.test(task.errorMessage) ||
    (task.status === 'paused' && loginErrorPattern.test(task.stage))
  )
}

export function summarizeTaskBatches(tasks: TaskView[]): TaskBatchSummary[] {
  const byBatch = new Map<string, TaskView[]>()
  for (const task of tasks) {
    if (!task.batchId) continue
    const batch = byBatch.get(task.batchId) ?? []
    batch.push(task)
    byBatch.set(task.batchId, batch)
  }

  return [...byBatch.entries()].map(([id, batch]) => {
    const sorted = [...batch].sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    const finished = batch
      .map((task) => task.finishedAt)
      .filter((value): value is string => Boolean(value))
      .sort()
    return {
      id,
      trigger: sorted[0]?.trigger ?? 'manual',
      createdAt: sorted[0]?.createdAt ?? '',
      finishedAt: batch.every((task) => Boolean(task.finishedAt)) ? finished.at(-1) ?? null : null,
      totalCount: batch.length,
      queuedCount: batch.filter((task) => task.status === 'queued').length,
      runningCount: batch.filter((task) => task.status === 'running').length,
      succeededCount: batch.filter((task) => task.status === 'succeeded').length,
      needsAttentionCount: batch.filter((task) => task.attentionState === 'pending').length,
      cancelledCount: batch.filter((task) => task.status === 'cancelled').length
    }
  }).sort((left, right) => right.createdAt.localeCompare(left.createdAt))
}

export function batchProgress(summary: TaskBatchSummary): number {
  if (summary.totalCount === 0) return 0
  const settled = summary.totalCount - summary.queuedCount - summary.runningCount
  return Math.round((settled / summary.totalCount) * 100)
}
