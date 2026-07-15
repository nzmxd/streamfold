import { describe, expect, it } from 'vitest'
import {
  parseAccountMetricQuery,
  parseAnalyticsQuery,
  parseBulkUpdateAccounts,
  parseConfirmApiIdentity,
  parseEnqueueSyncBatch,
  parseContentQuery,
  parseCreateAccount,
  parseCreateEncryptedBackup,
  parseCreatePluginSchedule,
  parseExportData,
  parseMarkTaskHandled,
  parseMoveGroup,
  parseRestoreEncryptedBackup,
  parseTaskQuery,
  parseUpdateAccount,
  parseUpdateContent,
  parseUpdateGroup,
  parseUpdateSettings
} from './validation'

describe('IPC validation', () => {
  it('normalizes account creation input', () => {
    expect(parseCreateAccount({
      platformId: 'weibo',
      alias: '  工作号  ',
      syncMode: 'profile_only'
    })).toEqual({ platformId: 'weibo', alias: '工作号', syncMode: 'profile_only' })
    expect(parseCreateAccount({
      platformId: 'xiaohongshu',
      syncMode: 'profile_only'
    })).toEqual({ platformId: 'xiaohongshu', syncMode: 'profile_only' })
    expect(parseCreateAccount({
      platformId: 'xiaohongshu',
      alias: '   ',
      syncMode: 'profile_only'
    })).toEqual({ platformId: 'xiaohongshu', alias: '', syncMode: 'profile_only' })
    expect(parseUpdateAccount({ id: 'account', alias: '   ' }))
      .toEqual({ id: 'account', alias: '' })
  })

  it('accepts dynamic platform IDs and rejects malformed values', () => {
    expect(parseCreateAccount({ platformId: 'publisher.custom-platform', alias: '账号', syncMode: 'profile_only' }))
      .toEqual({ platformId: 'publisher.custom-platform', alias: '账号', syncMode: 'profile_only' })
    expect(() => parseCreateAccount({ platformId: 'Invalid Platform', alias: '账号', syncMode: 'profile_only' })).toThrow('平台无效')
    expect(() => parseUpdateAccount({ id: 'a', tags: new Array(21).fill('tag') })).toThrow('标签无效')
  })

  it('validates content and analytics filters', () => {
    expect(parseContentQuery({ platformId: 'douyin', type: 'video', query: '  测试  ', limit: 20, offset: 40 })).toEqual({
      platformId: 'douyin',
      type: 'video',
      query: '测试',
      limit: 20,
      offset: 40
    })
    expect(parseAnalyticsQuery({ days: 90 })).toEqual({ days: 90 })
    expect(() => parseAnalyticsQuery({ days: 31 })).toThrow('统计周期无效')
    expect(() => parseContentQuery({ limit: 1000 })).toThrow('返回数量无效')
  })

  it('validates account metric history filters', () => {
    expect(parseAccountMetricQuery({
      accountId: 'account-1',
      period: 'daily',
      from: '2026-07-01',
      to: '2026-07-15',
      limit: 30,
      offset: 0
    })).toEqual({
      accountId: 'account-1',
      period: 'daily',
      from: '2026-07-01',
      to: '2026-07-15',
      limit: 30,
      offset: 0
    })
    expect(() => parseAccountMetricQuery({ accountId: 'account-1', period: 'weekly' }))
      .toThrow('账号指标周期无效')
    expect(() => parseAccountMetricQuery({ accountId: 'account-1', from: '2026-02-30' }))
      .toThrow('开始日期无效')
    expect(() => parseAccountMetricQuery({
      accountId: 'account-1', from: '2026-07-15', to: '2026-07-01'
    })).toThrow('账号指标日期范围无效')
    expect(() => parseAccountMetricQuery({ period: 'daily' })).toThrow('ID无效')
  })

  it('validates local-only content updates', () => {
    expect(parseUpdateContent({ id: 'content', note: '  本地备注 ', tags: ['重点', '重点'] }))
      .toEqual({ id: 'content', note: '本地备注', tags: ['重点'] })
  })

  it('validates group edits, ordering and bounded batch operations', () => {
    expect(parseUpdateGroup({ id: 'group', name: '  工作号  ', color: '#339cFF' })).toEqual({
      id: 'group', name: '工作号', color: '#339cFF'
    })
    expect(parseMoveGroup({ id: 'group', direction: 'down' })).toEqual({ id: 'group', direction: 'down' })
    expect(parseBulkUpdateAccounts({
      accountIds: ['a', 'a', 'b'],
      groupChange: { groupId: 'group', action: 'add' },
      syncEnabled: false
    })).toEqual({
      accountIds: ['a', 'b'],
      groupChange: { groupId: 'group', action: 'add' },
      syncEnabled: false
    })
    expect(() => parseUpdateGroup({ id: 'group' })).toThrow('没有需要更新')
    expect(() => parseMoveGroup({ id: 'group', direction: 'first' })).toThrow('移动方向无效')
    expect(() => parseBulkUpdateAccounts({ accountIds: [] })).toThrow('至少选择一个账号')
    expect(() => parseBulkUpdateAccounts({ accountIds: ['a'] })).toThrow('没有需要执行')
  })

  it('validates batch sync selection and task query filters', () => {
    expect(parseEnqueueSyncBatch({
      accountIds: ['account-a', 'account-a'],
      groupIds: ['group-a'],
      requestedScope: 'recent_20'
    })).toEqual({
      accountIds: ['account-a'],
      groupIds: ['group-a'],
      requestedScope: 'recent_20',
      trigger: 'manual'
    })
    expect(parseTaskQuery({
      statuses: ['queued', 'paused'],
      triggers: ['manual'],
      attention: 'pending',
      platformId: 'xiaohongshu',
      limit: 50,
      offset: 100
    })).toEqual({
      statuses: ['queued', 'paused'],
      triggers: ['manual'],
      attention: 'pending',
      platformId: 'xiaohongshu',
      limit: 50,
      offset: 100
    })
    expect(() => parseEnqueueSyncBatch({ accountIds: [], groupIds: [] })).toThrow('至少选择一个账号或分组')
    expect(() => parseEnqueueSyncBatch({ accountIds: ['a'], trigger: 'scheduled' })).toThrow('触发来源无效')
    expect(() => parseTaskQuery({ statuses: ['unknown'] })).toThrow('任务状态无效')
    expect(() => parseTaskQuery({ attention: 'unknown' })).toThrow('任务处理状态无效')
    expect(() => parseTaskQuery({ limit: 201 })).toThrow('返回数量无效')
  })

  it('validates task attention mutations and every schedule cadence', () => {
    expect(parseMarkTaskHandled({ source: 'plugin-run', taskId: 'run-1' })).toEqual({
      source: 'plugin-run',
      taskId: 'run-1'
    })
    expect(() => parseMarkTaskHandled({ source: 'event', taskId: 'run-1' }))
      .toThrow('任务来源无效')

    const common = {
      pluginId: 'example.plugin',
      contributionId: 'example.schedule',
      accountIds: ['account-1'],
      groupIds: [],
      enabled: true
    }
    expect(parseCreatePluginSchedule({ ...common, intervalMinutes: 60 })).toMatchObject({
      ...common,
      cadence: { type: 'interval', intervalMinutes: 60 }
    })
    expect(parseCreatePluginSchedule({
      ...common,
      cadence: { type: 'daily', time: '09:30' }
    })).toMatchObject({ cadence: { type: 'daily', time: '09:30' } })
    expect(parseCreatePluginSchedule({
      ...common,
      cadence: { type: 'weekly', weekdays: [5, 1, 5], time: '18:00' }
    })).toMatchObject({
      cadence: { type: 'weekly', weekdays: [1, 5], time: '18:00' }
    })
    expect(parseCreatePluginSchedule({
      ...common,
      cadence: { type: 'monthly', monthDays: [31, 1], time: '08:05' }
    })).toMatchObject({
      cadence: { type: 'monthly', monthDays: [1, 31], time: '08:05' }
    })
    expect(() => parseCreatePluginSchedule({
      ...common,
      cadence: { type: 'daily', time: '25:00' }
    })).toThrow('执行时间无效')
    expect(() => parseCreatePluginSchedule({
      ...common,
      cadence: { type: 'weekly', weekdays: [], time: '09:00' }
    })).toThrow('每周执行日无效')
  })

  it('validates settings and export requests', () => {
    expect(parseUpdateSettings({ rawRetentionDays: 7, autoCheckUpdates: false })).toEqual({
      rawRetentionDays: 7,
      autoCheckUpdates: false
    })
    expect(parseExportData({ format: 'csv', accountId: 'account' })).toEqual({
      format: 'csv', accountId: 'account'
    })
    expect(() => parseUpdateSettings({ rawRetentionDays: 366 })).toThrow('原始响应保留天数无效')
    expect(() => parseUpdateSettings({ autoCheckUpdates: 'true' })).toThrow('自动检查更新无效')
    expect(() => parseExportData({ format: 'xlsx' })).toThrow('导出格式无效')
  })

  it('requires an explicit strong-enough backup password and restore confirmation', () => {
    expect(parseCreateEncryptedBackup({ password: 'correct horse battery staple' }))
      .toEqual({ password: 'correct horse battery staple' })
    expect(parseRestoreEncryptedBackup({
      password: 'correct horse battery staple', confirmReplace: true
    })).toEqual({ password: 'correct horse battery staple', confirmReplace: true })
    expect(() => parseCreateEncryptedBackup({ password: 'short' })).toThrow('12-256')
    expect(() => parseCreateEncryptedBackup({ password: '中文中文' })).toThrow('12-256')
    expect(() => parseRestoreEncryptedBackup({
      password: 'correct horse battery staple', confirmReplace: 'yes'
    })).toThrow('恢复确认无效')
  })

  it('binds identity confirmation to an account and one explicit boolean', () => {
    expect(parseConfirmApiIdentity({
      accountId: 'account', token: 'preview-token', confirmIdentity: true
    })).toEqual({ accountId: 'account', token: 'preview-token', confirmIdentity: true })
    expect(() => parseConfirmApiIdentity({
      accountId: 'account', token: 'preview-token', confirmIdentity: 'yes'
    })).toThrow('本人身份确认无效')
  })

})
