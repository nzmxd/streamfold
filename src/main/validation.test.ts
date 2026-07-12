import { describe, expect, it } from 'vitest'
import {
  parseAnalyticsQuery,
  parseCommitFileImport,
  parseContentQuery,
  parseCreateAccount,
  parseExportData,
  parseUpdateAccount,
  parseUpdateContent,
  parseUpdateSettings
} from './validation'

describe('IPC validation', () => {
  it('normalizes account creation input', () => {
    expect(parseCreateAccount({
      platformId: 'weibo',
      alias: '  工作号  ',
      syncMode: 'profile_only'
    })).toEqual({ platformId: 'weibo', alias: '工作号', syncMode: 'profile_only' })
  })

  it('rejects unknown fields when their values are invalid', () => {
    expect(() => parseCreateAccount({ platformId: 'unknown', alias: '账号', syncMode: 'profile_only' })).toThrow('平台无效')
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

  it('validates import ownership and local-only updates', () => {
    expect(parseCommitFileImport({ token: 'preview', accountId: 'account', confirmOwnership: true }))
      .toEqual({ token: 'preview', accountId: 'account', confirmOwnership: true })
    expect(() => parseCommitFileImport({ token: 'preview', accountId: 'account', confirmOwnership: 'yes' }))
      .toThrow('本人账号确认无效')
    expect(parseUpdateContent({ id: 'content', note: '  本地备注 ', tags: ['重点', '重点'] }))
      .toEqual({ id: 'content', note: '本地备注', tags: ['重点'] })
  })

  it('validates settings and export requests', () => {
    expect(parseUpdateSettings({ rawRetentionDays: 7 })).toEqual({ rawRetentionDays: 7 })
    expect(parseExportData({ format: 'csv', accountId: 'account' })).toEqual({
      format: 'csv', accountId: 'account'
    })
    expect(() => parseUpdateSettings({ rawRetentionDays: 366 })).toThrow('原始响应保留天数无效')
    expect(() => parseExportData({ format: 'xlsx' })).toThrow('导出格式无效')
  })

})
