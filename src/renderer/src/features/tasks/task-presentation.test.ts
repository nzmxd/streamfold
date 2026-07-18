import { describe, expect, it } from 'vitest'
import type { TaskView } from '../../../../shared/job-contracts'
import {
  batchProgress,
  canCancelTask,
  canRetryTask,
  summarizeTaskBatches,
  taskNeedsLogin,
  taskStatusLabel,
  taskStatusTone
} from './task-presentation'

function task(overrides: Partial<TaskView> = {}): TaskView {
  return {
    id: 'task-1',
    source: 'job',
    batchId: 'batch-1',
    kind: 'account.sync',
    trigger: 'manual',
    status: 'queued',
    accountId: 'account-1',
    accountAlias: '主账号',
    platformId: 'xiaohongshu',
    pluginId: 'streamfold.builtin.xiaohongshu',
    contributionId: 'xiaohongshu.adapter',
    coverage: null,
    warnings: [],
    progress: 0,
    stage: '等待执行',
    attempt: 1,
    errorCode: '',
    errorMessage: '',
    createdAt: '2026-07-15T01:00:00.000Z',
    startedAt: null,
    finishedAt: null,
    nextAttemptAt: null,
    attentionState: null,
    attentionResolvedAt: null,
    attentionSupersededByTaskId: null,
    ...overrides
  }
}

describe('task presentation', () => {
  it('maps task status to concise labels and tones', () => {
    expect(taskStatusLabel('interrupted')).toBe('已中断')
    expect(taskStatusTone('failed')).toBe('danger')
    expect(taskStatusTone('queued')).toBe('brand')
  })

  it('only enables actions supported by the task state', () => {
    expect(canCancelTask(task({ status: 'queued' }))).toBe(true)
    expect(canCancelTask(task({ status: 'running' }))).toBe(false)
    expect(canCancelTask(task({ kind: 'plugin.action', status: 'queued' }))).toBe(false)
    expect(canRetryTask(task({ status: 'paused', attentionState: 'pending' }))).toBe(true)
    expect(canRetryTask(task({ status: 'succeeded' }))).toBe(false)
  })

  it('recognizes account tasks that need login handling', () => {
    expect(taskNeedsLogin(task({ status: 'paused', attentionState: 'pending', errorCode: 'SESSION_EXPIRED' }))).toBe(true)
    expect(taskNeedsLogin(task({ status: 'failed', attentionState: 'pending', errorMessage: 'identity mismatch' }))).toBe(true)
    expect(taskNeedsLogin(task({ status: 'paused', attentionState: 'pending', stage: '登录已过期' }))).toBe(true)
    expect(taskNeedsLogin(task({ accountId: null, errorCode: 'LOGIN_REQUIRED' }))).toBe(false)
  })

  it('groups loaded tasks into batches and calculates settled progress', () => {
    const batches = summarizeTaskBatches([
      task({ id: 'queued', status: 'queued' }),
      task({ id: 'done', status: 'succeeded', finishedAt: '2026-07-15T01:01:00.000Z' }),
      task({ id: 'failed', status: 'failed', attentionState: 'pending', finishedAt: '2026-07-15T01:02:00.000Z' }),
      task({ id: 'single', batchId: null })
    ])

    expect(batches).toHaveLength(1)
    expect(batches[0]).toMatchObject({
      id: 'batch-1',
      totalCount: 3,
      queuedCount: 1,
      succeededCount: 1,
      needsAttentionCount: 1,
      finishedAt: null
    })
    expect(batchProgress(batches[0]!)).toBe(67)
  })
})
