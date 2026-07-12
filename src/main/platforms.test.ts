import { describe, expect, it } from 'vitest'
import { isOfficialUrl } from './platforms'

describe('isOfficialUrl', () => {
  it('allows reviewed HTTPS hosts and their real subdomains', () => {
    expect(isOfficialUrl('xiaohongshu', 'https://creator.xiaohongshu.com/')).toBe(true)
    expect(isOfficialUrl('weibo', 'https://passport.weibo.com/')).toBe(true)
    expect(isOfficialUrl('zhihu', 'https://www.zhihu.com/signin')).toBe(true)
  })

  it('rejects lookalike domains and unsafe protocols', () => {
    expect(isOfficialUrl('xiaohongshu', 'https://xiaohongshu.com.evil.test/')).toBe(false)
    expect(isOfficialUrl('xiaohongshu', 'https://evil-xiaohongshu.com/')).toBe(false)
    expect(isOfficialUrl('douyin', 'http://creator.douyin.com/')).toBe(false)
    expect(isOfficialUrl('douyin', 'javascript:alert(1)')).toBe(false)
  })

  it('rejects credentials, IP addresses and nonstandard ports', () => {
    expect(isOfficialUrl('weibo', 'https://user:pass@weibo.com/')).toBe(false)
    expect(isOfficialUrl('weibo', 'https://weibo.com:8443/')).toBe(false)
    expect(isOfficialUrl('weibo', 'https://127.0.0.1/')).toBe(false)
  })
})
