import { beforeAll, describe, expect, it } from 'vitest'
import { ExtensionRegistry } from './plugins/extension-registry'
import {
  getPlatform,
  isOfficialContentUrl,
  isOfficialUrl,
  registerManifestPlatforms,
  shouldBlockRemoteNavigation
} from './platforms'

beforeAll(() => {
  registerManifestPlatforms(new ExtensionRegistry().platformDefinitions().map((platform) => ({
    id: platform.id,
    name: platform.name,
    shortName: platform.shortName,
    loginUrl: platform.loginUrl,
    homeUrl: platform.homeUrl,
    officialHosts: platform.navigationHosts,
    contentUrls: platform.contentUrls,
    riskNote: platform.riskNote
  })))
})

describe('platform definitions', () => {
  it('opens Zhihu sign-in with an explicit official creator destination', () => {
    const zhihu = getPlatform('zhihu')
    expect(zhihu.loginUrl).toBe('https://www.zhihu.com/signin?next=%2Fcreator')
    expect(isOfficialUrl('zhihu', zhihu.loginUrl)).toBe(true)
    expect(isOfficialUrl('zhihu', zhihu.homeUrl)).toBe(true)
  })
})

describe('isOfficialUrl', () => {
  it('allows only explicitly reviewed HTTPS hosts', () => {
    expect(isOfficialUrl('xiaohongshu', 'https://creator.xiaohongshu.com/')).toBe(true)
    expect(isOfficialUrl('zhihu', 'https://www.zhihu.com/signin')).toBe(true)
    expect(isOfficialUrl('zhihu', 'https://zhuanlan.zhihu.com/p/123')).toBe(true)
  })

  it('rejects lookalike domains and unsafe protocols', () => {
    expect(isOfficialUrl('xiaohongshu', 'https://xiaohongshu.com.evil.test/')).toBe(false)
    expect(isOfficialUrl('xiaohongshu', 'https://evil-xiaohongshu.com/')).toBe(false)
    expect(isOfficialUrl('zhihu', 'http://www.zhihu.com/')).toBe(false)
    expect(isOfficialUrl('zhihu', 'javascript:alert(1)')).toBe(false)
    expect(isOfficialUrl('zhihu', 'https://news.sina.com.cn/')).toBe(false)
    expect(isOfficialUrl('xiaohongshu', 'https://unreviewed.xiaohongshu.com/')).toBe(false)
  })

  it('rejects credentials, IP addresses and nonstandard ports', () => {
    expect(isOfficialUrl('zhihu', 'https://user:pass@www.zhihu.com/')).toBe(false)
    expect(isOfficialUrl('zhihu', 'https://www.zhihu.com:8443/')).toBe(false)
    expect(isOfficialUrl('zhihu', 'https://www.zhihu.com:443/')).toBe(false)
    expect(isOfficialUrl('zhihu', 'https://127.0.0.1/')).toBe(false)
  })
})

describe('shouldBlockRemoteNavigation', () => {
  it('blocks nonofficial top-level navigation without breaking isolated verification frames', () => {
    expect(shouldBlockRemoteNavigation('zhihu', 'https://example.com/', true)).toBe(true)
    expect(shouldBlockRemoteNavigation('zhihu', 'https://www.zhihu.com/signin', true)).toBe(false)
    expect(shouldBlockRemoteNavigation('zhihu', 'https://captcha.example/', false)).toBe(false)
    expect(shouldBlockRemoteNavigation('zhihu', 'about:blank', false)).toBe(false)
    expect(shouldBlockRemoteNavigation('zhihu', 'blob:https://captcha.example/id', false)).toBe(false)
    expect(shouldBlockRemoteNavigation('zhihu', 'http://captcha.example/', false)).toBe(true)
    expect(shouldBlockRemoteNavigation('zhihu', 'file:///C:/private.txt', false)).toBe(true)
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

  it('accepts exact Zhihu answer, article and pin canonical paths', () => {
    expect(isOfficialContentUrl(
      'zhihu',
      'https://www.zhihu.com/question/123456789/answer/987654321',
      'answer:123456789:987654321'
    )).toBe(true)
    expect(isOfficialContentUrl(
      'zhihu',
      'https://zhuanlan.zhihu.com/p/123456789',
      'article:123456789'
    )).toBe(true)
    expect(isOfficialContentUrl(
      'zhihu',
      'https://www.zhihu.com/pin/1621203130250403840',
      'pin:1621203130250403840'
    )).toBe(true)
  })

  it.each([
    ['lookalike answer host', 'https://www.zhihu.com.evil.test/question/123/answer/456', 'answer:123:456'],
    ['wrong answer id', 'https://www.zhihu.com/question/123/answer/457', 'answer:123:456'],
    ['wrong question id', 'https://www.zhihu.com/question/124/answer/456', 'answer:123:456'],
    ['answer on article host', 'https://zhuanlan.zhihu.com/question/123/answer/456', 'answer:123:456'],
    ['article on main host', 'https://www.zhihu.com/p/456', 'article:456'],
    ['pin on article host', 'https://zhuanlan.zhihu.com/pin/456', 'pin:456'],
    ['unexpected query', 'https://www.zhihu.com/question/123/answer/456?utm_source=test', 'answer:123:456'],
    ['unexpected hash', 'https://zhuanlan.zhihu.com/p/456#comment', 'article:456'],
    ['trailing slash', 'https://www.zhihu.com/pin/456/', 'pin:456'],
    ['encoded path id', 'https://zhuanlan.zhihu.com/p/%34%35%36', 'article:456'],
    ['non-HTTPS URL', 'http://www.zhihu.com/pin/456', 'pin:456'],
    ['credentials', 'https://user:secret@www.zhihu.com/pin/456', 'pin:456'],
    ['explicit default port', 'https://www.zhihu.com:443/pin/456', 'pin:456'],
    ['unknown content namespace', 'https://www.zhihu.com/pin/456', 'video:456'],
    ['ambiguous unscoped id', 'https://www.zhihu.com/pin/456', '456']
  ])('rejects unsafe or mismatched Zhihu content URLs: %s', (_case, url, remoteId) => {
    expect(isOfficialContentUrl('zhihu', url, remoteId)).toBe(false)
  })
})
