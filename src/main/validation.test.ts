import { describe, expect, it } from 'vitest'
import { parseCreateAccount, parseUpdateAccount } from './validation'

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

})
