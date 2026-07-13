import { describe, expect, it } from 'vitest'
import { accountDisplayName } from './presentation'

describe('accountDisplayName', () => {
  it('prefers the local note name', () => {
    expect(accountDisplayName({ alias: '工作账号', remoteName: '平台昵称' }, '小红书')).toBe('工作账号')
  })

  it('falls back to the platform nickname when the local name is blank', () => {
    expect(accountDisplayName({ alias: '  ', remoteName: '平台昵称' }, '小红书')).toBe('平台昵称')
  })

  it('provides a useful label before identity binding', () => {
    expect(accountDisplayName({ alias: '', remoteName: '' }, '小红书')).toBe('小红书账号')
  })
})
