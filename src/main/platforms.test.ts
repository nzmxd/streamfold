import { describe, expect, it } from 'vitest'
import { isOfficialContentUrl, isOfficialUrl } from './platforms'

describe('isOfficialUrl', () => {
  it('allows only explicitly reviewed HTTPS hosts', () => {
    expect(isOfficialUrl('xiaohongshu', 'https://creator.xiaohongshu.com/')).toBe(true)
    expect(isOfficialUrl('weibo', 'https://passport.weibo.com/')).toBe(true)
    expect(isOfficialUrl('zhihu', 'https://www.zhihu.com/signin')).toBe(true)
    expect(isOfficialUrl('weibo', 'https://login.sina.com.cn/')).toBe(true)
  })

  it('rejects lookalike domains and unsafe protocols', () => {
    expect(isOfficialUrl('xiaohongshu', 'https://xiaohongshu.com.evil.test/')).toBe(false)
    expect(isOfficialUrl('xiaohongshu', 'https://evil-xiaohongshu.com/')).toBe(false)
    expect(isOfficialUrl('douyin', 'http://creator.douyin.com/')).toBe(false)
    expect(isOfficialUrl('douyin', 'javascript:alert(1)')).toBe(false)
    expect(isOfficialUrl('weibo', 'https://news.sina.com.cn/')).toBe(false)
    expect(isOfficialUrl('xiaohongshu', 'https://unreviewed.xiaohongshu.com/')).toBe(false)
  })

  it('rejects credentials, IP addresses and nonstandard ports', () => {
    expect(isOfficialUrl('weibo', 'https://user:pass@weibo.com/')).toBe(false)
    expect(isOfficialUrl('weibo', 'https://weibo.com:8443/')).toBe(false)
    expect(isOfficialUrl('weibo', 'https://127.0.0.1/')).toBe(false)
  })
})

describe('isOfficialContentUrl', () => {
  const noteId = 'aaaaaaaaaaaaaaaaaaaaaaaa'

  it('accepts only the matching Xiaohongshu public note path and validated xsec context', () => {
    expect(isOfficialContentUrl(
      'xiaohongshu',
      `https://www.xiaohongshu.com/explore/${noteId}`,
      noteId
    )).toBe(true)
    expect(isOfficialContentUrl(
      'xiaohongshu',
      `https://www.xiaohongshu.com/explore/${noteId}?xsec_token=abc_DEF-123&xsec_source=pc_user`,
      noteId
    )).toBe(true)
  })

  it('rejects mismatched posts, extra parameters and unsafe token values', () => {
    expect(isOfficialContentUrl(
      'xiaohongshu',
      'https://www.xiaohongshu.com/explore/bbbbbbbbbbbbbbbbbbbbbbbb',
      noteId
    )).toBe(false)
    expect(isOfficialContentUrl(
      'xiaohongshu',
      `https://www.xiaohongshu.com/explore/${noteId}?redirect=https://evil.test`,
      noteId
    )).toBe(false)
    expect(isOfficialContentUrl(
      'xiaohongshu',
      `https://www.xiaohongshu.com/explore/${noteId}?xsec_token=bad%20token`,
      noteId
    )).toBe(false)
  })
})
