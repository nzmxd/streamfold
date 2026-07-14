import { describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import { __zhihuApiTransportTest } from './browser-manager'
import { ZHIHU_API_ENDPOINTS, ZhihuApiError } from './zhihu-api'

const origin = 'https://www.zhihu.com'

describe('BrowserManager Zhihu API transport', () => {
  it('loads a fixed first-party page for a cold background workspace', async () => {
    let currentUrl = ''
    const contents = {
      getURL: () => currentUrl,
      isLoading: () => false,
      isDestroyed: () => false
    }
    const loadOfficial = vi.fn(async (url: string) => { currentUrl = url })

    await __zhihuApiTransportTest.prepareApiPage(contents, loadOfficial, {
      quietMs: 1,
      pollMs: 1,
      timeoutMs: 100
    })

    expect(loadOfficial).toHaveBeenCalledOnce()
    expect(loadOfficial).toHaveBeenCalledWith(`${origin}/`)
  })

  it('reuses an existing Zhihu page without replacing it', async () => {
    const loadOfficial = vi.fn(async () => undefined)
    await __zhihuApiTransportTest.prepareApiPage({
      getURL: () => `${origin}/creator`,
      isLoading: () => false,
      isDestroyed: () => false
    }, loadOfficial, { quietMs: 1, pollMs: 1, timeoutMs: 100 })

    expect(loadOfficial).not.toHaveBeenCalled()
  })

  it('uses a fixed same-origin JSON request without reading page elements', async () => {
    const executeJavaScript = vi.fn(async (_source: string) => ({
      status: 200,
      url: `${origin}${ZHIHU_API_ENDPOINTS.identity}`,
      contentType: 'application/json; charset=utf-8',
      text: JSON.stringify({ id: 'owner-id', url_token: 'owner-token', name: '本人' })
    }))

    const response = await __zhihuApiTransportTest.fetchPageJson({
      executeJavaScript,
      getURL: () => `${origin}/creator`,
      isDestroyed: () => false
    }, ZHIHU_API_ENDPOINTS.identity, 100)

    expect(response).toMatchObject({ status: 200, url: `${origin}${ZHIHU_API_ENDPOINTS.identity}` })
    const source = executeJavaScript.mock.calls[0]?.[0] as string
    expect(source).toContain("credentials: 'include'")
    expect(source).toContain("redirect: 'manual'")
    expect(source).toContain("headers: { Accept: 'application/json' }")
    expect(source).not.toMatch(/document|querySelector|innerText|textContent|outerHTML|innerHTML|cookie|localStorage/)
  })

  it('rejects non-whitelisted routes and non-Zhihu page origins', async () => {
    const contents = {
      executeJavaScript: vi.fn(async () => ({})),
      getURL: () => `${origin}/creator`,
      isDestroyed: () => false
    }
    await expect(__zhihuApiTransportTest.fetchPageJson(
      contents,
      '/api/v4/members/owner/followers?limit=20&offset=0',
      100
    )).rejects.toThrow('白名单')

    await expect(__zhihuApiTransportTest.fetchPageJson(
      { ...contents, getURL: () => 'https://zhuanlan.zhihu.com/' },
      ZHIHU_API_ENDPOINTS.identity,
      100
    )).rejects.toThrow('知乎官方页面')
  })

  it('classifies login expiry, rate limits and non-JSON responses', async () => {
    const executeJavaScript = vi.fn(async () => ({
      status: 401,
      url: `${origin}${ZHIHU_API_ENDPOINTS.identity}`,
      redirected: false,
      contentType: 'application/json',
      text: '{}'
    }))
    const contents = {
      executeJavaScript,
      getURL: () => `${origin}/`,
      isDestroyed: () => false
    }

    await expect(__zhihuApiTransportTest.fetchPageJson(contents, ZHIHU_API_ENDPOINTS.identity, 100))
      .rejects.toMatchObject({ code: 'AUTH_REQUIRED' } satisfies Partial<ZhihuApiError>)

    executeJavaScript.mockResolvedValueOnce({
      status: 429,
      url: `${origin}${ZHIHU_API_ENDPOINTS.identity}`,
      redirected: false,
      contentType: 'application/json',
      text: '{}'
    })
    await expect(__zhihuApiTransportTest.fetchPageJson(contents, ZHIHU_API_ENDPOINTS.identity, 100))
      .rejects.toMatchObject({ code: 'RATE_LIMITED' } satisfies Partial<ZhihuApiError>)

    executeJavaScript.mockResolvedValueOnce({
      status: 200,
      url: `${origin}${ZHIHU_API_ENDPOINTS.identity}`,
      redirected: false,
      contentType: 'text/html',
      text: ''
    })
    await expect(__zhihuApiTransportTest.fetchPageJson(contents, ZHIHU_API_ENDPOINTS.identity, 100))
      .rejects.toMatchObject({ code: 'AUTH_REQUIRED' } satisfies Partial<ZhihuApiError>)

    executeJavaScript.mockResolvedValueOnce({
      status: 200,
      url: `${origin}/signin?next=%2Fapi%2Fv4%2Fme`,
      redirected: true,
      contentType: 'text/html',
      text: ''
    })
    await expect(__zhihuApiTransportTest.fetchPageJson(contents, ZHIHU_API_ENDPOINTS.identity, 100))
      .rejects.toMatchObject({ code: 'AUTH_REQUIRED' } satisfies Partial<ZhihuApiError>)
  })
})
