import { describe, expect, it } from 'vitest'
import type { UpdatePhase, UpdateState } from '../../../../shared/contracts'
import { formatUpdateProgress, presentUpdate } from './update-presentation'

function state(phase: UpdatePhase, value: Partial<UpdateState> = {}): UpdateState {
  return {
    phase,
    currentVersion: '0.4.0',
    availableVersion: null,
    releaseDate: null,
    lastCheckedAt: null,
    progress: null,
    error: '',
    automaticChecks: true,
    unsupportedReason: null,
    ...value
  }
}

describe('update presentation', () => {
  it('maps idle, checking, and current states to manual checks', () => {
    expect(presentUpdate(state('idle'))).toMatchObject({
      badge: '待检查',
      action: 'check',
      actionLabel: '检查更新',
      actionDisabled: false
    })
    expect(presentUpdate(state('checking'))).toMatchObject({
      badge: '检查中',
      action: 'check',
      actionDisabled: true
    })
    expect(presentUpdate(state('up-to-date')).title).toContain('v0.4.0')
  })

  it('exposes download progress and an install action', () => {
    const downloading = presentUpdate(state('downloading', {
      availableVersion: '0.5.0',
      progress: {
        percent: 48.6,
        transferred: 10 * 1024 * 1024,
        total: 20 * 1024 * 1024,
        bytesPerSecond: 2 * 1024 * 1024
      }
    }))
    expect(downloading).toMatchObject({
      action: 'download',
      actionDisabled: true,
      progressVisible: true,
      progressPercent: 49
    })
    expect(downloading.progressDetail).toBe('10.0 MB / 20.0 MB · 2.00 MB/秒')

    expect(presentUpdate(state('downloaded', { availableVersion: '0.5.0' }))).toMatchObject({
      badge: '等待安装',
      action: 'restart',
      actionLabel: '重启并安装',
      progressPercent: 100,
      titlebarAttention: true
    })
  })

  it('chooses the correct retry after an error', () => {
    expect(presentUpdate(state('error', { error: '无法连接更新服务器' }))).toMatchObject({
      action: 'check',
      actionLabel: '重新检查',
      description: '无法连接更新服务器'
    })
    expect(presentUpdate(state('error', { availableVersion: '0.5.0' }))).toMatchObject({
      action: 'download',
      actionLabel: '重新下载'
    })
  })

  it('uses product copy for unsupported package reasons', () => {
    expect(presentUpdate(state('unsupported', { unsupportedReason: 'development' })).description)
      .toContain('开发环境')
    expect(presentUpdate(state('unsupported', { unsupportedReason: 'missing-source' })).description)
      .toContain('更新源')
    expect(presentUpdate(state('unsupported', { unsupportedReason: 'unsupported-package' })).description)
      .toContain('AppImage')
  })

  it('formats missing and zero-valued progress without invalid output', () => {
    expect(formatUpdateProgress(state('downloading'))).toBe('')
    expect(formatUpdateProgress(state('downloading', {
      progress: { percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 }
    }))).toBe('0 B')
  })
})
