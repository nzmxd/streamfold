import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import {
  __browserWorkspaceLeaseTest,
  __xiaohongshuApiTransportTest,
} from './browser-manager'
import {
  XIAOHONGSHU_API_ENDPOINTS,
  XIAOHONGSHU_API_ROUTES
} from './xiaohongshu-api'

const origin = 'https://creator.xiaohongshu.com'

class FakeDebugger extends EventEmitter {
  attached = false
  readonly commands: Array<{ method: string, params?: Record<string, unknown> }> = []
  bodies = new Map<string, { body: string, base64Encoded: boolean }>()

  isAttached(): boolean {
    return this.attached
  }

  attach(version: string): void {
    expect(version).toBe('1.3')
    this.attached = true
  }

  detach(): void {
    this.attached = false
    this.emit('detach', {}, 'target closed')
  }

  async sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.commands.push({ method, params })
    if (method === 'Network.getResponseBody') {
      const requestId = String(params?.requestId || '')
      const value = this.bodies.get(requestId)
      if (!value) throw new Error('missing fake body')
      return value
    }
    return {}
  }
}

function fakeContents(
  onLoad: (debuggerApi: FakeDebugger) => void
): {
  contents: Pick<WebContents, 'debugger' | 'isDestroyed' | 'loadURL' | 'sendInputEvent'>
  debuggerApi: FakeDebugger
  loadURL: ReturnType<typeof vi.fn>
  sendInputEvent: ReturnType<typeof vi.fn>
} {
  const debuggerApi = new FakeDebugger()
  const loadURL = vi.fn(async () => {
    queueMicrotask(() => onLoad(debuggerApi))
  })
  const sendInputEvent = vi.fn()
  const contents = {
    debugger: debuggerApi,
    isDestroyed: () => false,
    loadURL,
    sendInputEvent
  } as unknown as Pick<WebContents, 'debugger' | 'isDestroyed' | 'loadURL' | 'sendInputEvent'>
  return { contents, debuggerApi, loadURL, sendInputEvent }
}

function emitJsonCapture(
  debuggerApi: FakeDebugger,
  url = `${origin}${XIAOHONGSHU_API_ENDPOINTS.noteAnalyzeList}?type=0&page_size=10&page_num=1`,
  contentType = 'application/json',
  requestId = 'request-1',
  json: unknown = { code: 0, data: { total: 0, note_infos: [] } },
  finish = true
): void {
  const body = JSON.stringify(json)
  debuggerApi.bodies.set(requestId, { body, base64Encoded: false })
  debuggerApi.emit('message', {}, 'Network.responseReceived', {
    requestId,
    type: 'Fetch',
    response: {
      url,
      status: 200,
      mimeType: contentType,
      headers: new Proxy({}, {
        ownKeys: () => { throw new Error('response headers must not be enumerated') },
        get: () => { throw new Error('response headers must not be read') }
      })
    }
  })
  if (finish) finishJsonCapture(debuggerApi, requestId, body)
}

function finishJsonCapture(debuggerApi: FakeDebugger, requestId: string, body: string): void {
  debuggerApi.emit('message', {}, 'Network.loadingFinished', {
    requestId,
    encodedDataLength: Buffer.byteLength(body)
  })
}

describe('BrowserManager Xiaohongshu API transport', () => {
  it('disposes only background-created workspaces after their final API lease', () => {
    const background = { foregroundRequested: false, apiLeaseCount: 0 }
    __browserWorkspaceLeaseTest.begin(background)
    __browserWorkspaceLeaseTest.begin(background)
    expect(__browserWorkspaceLeaseTest.end(background)).toBe(false)
    expect(__browserWorkspaceLeaseTest.end(background)).toBe(true)

    const foreground = { foregroundRequested: true, apiLeaseCount: 0 }
    __browserWorkspaceLeaseTest.begin(foreground)
    expect(__browserWorkspaceLeaseTest.end(foreground)).toBe(false)
  })

  it('retains a background workspace promoted for interactive login', () => {
    const workspace = { foregroundRequested: false, apiLeaseCount: 0 }
    __browserWorkspaceLeaseTest.begin(workspace)
    __browserWorkspaceLeaseTest.promote(workspace)
    expect(workspace.foregroundRequested).toBe(true)
    expect(__browserWorkspaceLeaseTest.end(workspace)).toBe(false)
  })

  it('loads the fixed creator home for a cold API workspace and waits until navigation is stable', async () => {
    let currentUrl = ''
    let loading = false
    const contents = {
      getURL: () => currentUrl,
      isLoading: () => loading,
      isDestroyed: () => false
    }
    const loadOfficial = vi.fn(async (url: string) => {
      loading = true
      currentUrl = url
      loading = false
    })

    await __xiaohongshuApiTransportTest.prepareApiPage(contents, loadOfficial, {
      quietMs: 1,
      pollMs: 1,
      timeoutMs: 100
    })

    expect(loadOfficial).toHaveBeenCalledOnce()
    expect(loadOfficial).toHaveBeenCalledWith(XIAOHONGSHU_API_ROUTES.home)
  })

  it('waits for an existing creator navigation without replacing the visible page', async () => {
    let loading = true
    const contents = {
      getURL: () => XIAOHONGSHU_API_ROUTES.noteManager,
      isLoading: () => loading,
      isDestroyed: () => false
    }
    const loadOfficial = vi.fn(async () => undefined)
    setTimeout(() => { loading = false }, 2)

    await __xiaohongshuApiTransportTest.prepareApiPage(contents, loadOfficial, {
      quietMs: 2,
      pollMs: 1,
      timeoutMs: 100
    })

    expect(loadOfficial).not.toHaveBeenCalled()
  })

  it('uses a fixed page-origin JSON request without page element access', async () => {
    const executeJavaScript = vi.fn(async (_source: string) => ({
      status: 200,
      url: `${origin}${XIAOHONGSHU_API_ENDPOINTS.personalInfo}`,
      contentType: 'application/json; charset=utf-8',
      text: JSON.stringify({ code: 0, data: { user_id: '5605904194' } })
    }))
    const result = await __xiaohongshuApiTransportTest.fetchPageJson(
      {
        executeJavaScript,
        getURL: () => `${origin}/new/home`,
        isDestroyed: () => false
      },
      XIAOHONGSHU_API_ENDPOINTS.personalInfo,
      100
    )

    expect(result).toMatchObject({ status: 200, url: `${origin}${XIAOHONGSHU_API_ENDPOINTS.personalInfo}` })
    const source = executeJavaScript.mock.calls[0]?.[0] as string
    expect(source).toContain("credentials: 'include'")
    expect(source).toContain("redirect: 'manual'")
    expect(source).not.toContain("redirect: 'error'")
    expect(source).toContain("headers: { Accept: 'application/json' }")
    expect(source).toContain('if (!isJson)')
    expect(source).not.toContain('error.message')
    expect(source).not.toMatch(/document|querySelector|innerText|textContent|outerHTML|innerHTML/)
  })

  it('allows the fixed read-only user profile endpoint used for avatar metadata', async () => {
    const executeJavaScript = vi.fn(async () => ({
      status: 200,
      url: `${origin}${XIAOHONGSHU_API_ENDPOINTS.userInfo}`,
      contentType: 'application/json',
      text: JSON.stringify({ code: 0, data: { redId: '5605904194' } })
    }))
    await expect(__xiaohongshuApiTransportTest.fetchPageJson(
      {
        executeJavaScript,
        getURL: () => `${origin}/new/home`,
        isDestroyed: () => false
      },
      XIAOHONGSHU_API_ENDPOINTS.userInfo,
      100
    )).resolves.toMatchObject({ status: 200 })
  })

  it('rejects non-whitelisted endpoints, non-official pages and non-JSON responses', async () => {
    const executeJavaScript = vi.fn(async (_source: string) => ({
      status: 200,
      url: `${origin}${XIAOHONGSHU_API_ENDPOINTS.personalInfo}`,
      contentType: 'text/html',
      text: '{}'
    }))
    const contents = {
      executeJavaScript,
      getURL: () => `${origin}/new/home`,
      isDestroyed: () => false
    }
    await expect(__xiaohongshuApiTransportTest.fetchPageJson(contents, '/api/private/write', 100))
      .rejects.toThrow('白名单')

    await expect(__xiaohongshuApiTransportTest.fetchPageJson(
      { ...contents, getURL: () => 'https://evil.example/' },
      XIAOHONGSHU_API_ENDPOINTS.personalInfo,
      100
    )).rejects.toThrow('创作中心')

    await expect(__xiaohongshuApiTransportTest.fetchPageJson(
      contents,
      XIAOHONGSHU_API_ENDPOINTS.personalInfo,
      100
    )).rejects.toThrow('Content-Type')
  })

  it('rejects page API timeout and response size failures', async () => {
    const contents = {
      executeJavaScript: vi.fn(async () => ({ error: 'TIMEOUT' })),
      getURL: () => `${origin}/new/home`,
      isDestroyed: () => false
    }
    await expect(__xiaohongshuApiTransportTest.fetchPageJson(
      contents,
      XIAOHONGSHU_API_ENDPOINTS.accountStats,
      100
    )).rejects.toThrow('请求超时')

    contents.executeJavaScript.mockResolvedValueOnce({ error: 'TOO_LARGE' })
    await expect(__xiaohongshuApiTransportTest.fetchPageJson(
      contents,
      XIAOHONGSHU_API_ENDPOINTS.accountStats,
      100
    )).rejects.toThrow('256 KiB')
  })

  it('surfaces a browser Failed to fetch without falling back to page content', async () => {
    const executeJavaScript = vi.fn(async (_source: string) => ({
      error: 'NETWORK',
      detail: 'Failed to fetch'
    }))
    const beforeRetry = vi.fn(async () => undefined)
    const action = __xiaohongshuApiTransportTest.fetchPageJson(
      {
        executeJavaScript,
        getURL: () => `${origin}/new/home`,
        isDestroyed: () => false
      },
      XIAOHONGSHU_API_ENDPOINTS.personalInfo,
      100,
      beforeRetry
    )

    const error = await rejectionOf(() => action)
    expect(error.message).toBe('小红书 API 暂时无法连接，请稍后重试')
    expect(error.message).not.toContain('Failed to fetch')
    expect(executeJavaScript).toHaveBeenCalledTimes(2)
    expect(beforeRetry).toHaveBeenCalledOnce()
    const source = executeJavaScript.mock.calls[0]?.[0] as string
    expect(source).toContain("redirect: 'manual'")
    expect(source).toContain("return { error: 'AUTH_REDIRECT' }")
    expect(source).toContain("response.status === 0) return { error: 'NETWORK' }")
    expect(source).not.toMatch(/document|querySelector|innerText|textContent|outerHTML|innerHTML/)
  })

  it('retries one transient Failed to fetch and then returns the exact API response', async () => {
    const executeJavaScript = vi.fn()
      .mockResolvedValueOnce({ error: 'NETWORK', detail: 'Failed to fetch' })
      .mockResolvedValueOnce({
        status: 200,
        url: `${origin}${XIAOHONGSHU_API_ENDPOINTS.personalInfo}`,
        redirected: false,
        contentType: 'application/json',
        text: JSON.stringify({ code: 0, data: { user_id: '5605904194' } })
      })

    const beforeRetry = vi.fn(async () => undefined)
    await expect(__xiaohongshuApiTransportTest.fetchPageJson(
      {
        executeJavaScript,
        getURL: () => `${origin}/new/home`,
        isDestroyed: () => false
      },
      XIAOHONGSHU_API_ENDPOINTS.personalInfo,
      100,
      beforeRetry
    )).resolves.toMatchObject({ status: 200 })
    expect(executeJavaScript).toHaveBeenCalledTimes(2)
    expect(beforeRetry).toHaveBeenCalledOnce()
    expect(executeJavaScript.mock.invocationCallOrder[0])
      .toBeLessThan(beforeRetry.mock.invocationCallOrder[0]!)
    expect(beforeRetry.mock.invocationCallOrder[0])
      .toBeLessThan(executeJavaScript.mock.invocationCallOrder[1]!)
  })

  it('maps a manual authentication redirect to AUTH_REQUIRED without exposing details', async () => {
    const responseSecret = 'redirect-ticket-secret'
    const executeJavaScript = vi.fn(async () => ({
      error: 'AUTH_REDIRECT',
      detail: `https://creator.xiaohongshu.com/login?ticket=${responseSecret}`,
      text: `<html>${responseSecret}</html>`
    }))
    const error = await rejectionOf(() => __xiaohongshuApiTransportTest.fetchPageJson(
      {
        executeJavaScript,
        getURL: () => `${origin}/new/home`,
        isDestroyed: () => false
      },
      XIAOHONGSHU_API_ENDPOINTS.personalInfo,
      100
    ))

    expect(error).toMatchObject({ code: 'AUTH_REQUIRED' })
    expect(error.message).toContain('登录状态已失效')
    expect(error.message).not.toContain(responseSecret)
    expect(error.message).not.toContain('<html>')
  })

  it('maps a known final login URL and HTTP authentication status to AUTH_REQUIRED', async () => {
    const executeJavaScript = vi.fn()
      .mockResolvedValueOnce({
        status: 200,
        url: `${origin}/login?redirect=%2Fnew%2Fhome`,
        redirected: true,
        contentType: 'text/html',
        text: '<html>login</html>'
      })
      .mockResolvedValueOnce({
        status: 401,
        url: `${origin}${XIAOHONGSHU_API_ENDPOINTS.personalInfo}`,
        redirected: false,
        contentType: 'text/html',
        text: '<html>login</html>'
      })
    const contents = {
      executeJavaScript,
      getURL: () => `${origin}/new/home`,
      isDestroyed: () => false
    }

    await expect(__xiaohongshuApiTransportTest.fetchPageJson(
      contents,
      XIAOHONGSHU_API_ENDPOINTS.personalInfo,
      100
    )).rejects.toMatchObject({ code: 'AUTH_REQUIRED' })
    await expect(__xiaohongshuApiTransportTest.fetchPageJson(
      contents,
      XIAOHONGSHU_API_ENDPOINTS.personalInfo,
      100
    )).rejects.toMatchObject({ code: 'AUTH_REQUIRED' })
  })

  it('rejects an API redirect without exposing its URL, credentials or HTML body', async () => {
    const responseSecret = 'session-cookie-secret'
    const executeJavaScript = vi.fn(async () => ({
      status: 302,
      url: `https://user:${responseSecret}@creator.xiaohongshu.com/login?ticket=${responseSecret}`,
      contentType: 'text/html',
      text: `<html><body>${responseSecret}</body></html>`
    }))
    const message = await rejectionMessage(() => __xiaohongshuApiTransportTest.fetchPageJson(
      {
        executeJavaScript,
        getURL: () => `${origin}/new/home`,
        isDestroyed: () => false
      },
      XIAOHONGSHU_API_ENDPOINTS.personalInfo,
      100
    ))

    expect(message).toContain('响应来源不在白名单')
    expect(message).not.toContain(responseSecret)
    expect(message).not.toContain('<html>')
  })

  it('rejects login HTML and malformed JSON without exposing response bodies', async () => {
    const responseSecret = 'private-login-payload'
    const executeJavaScript = vi.fn()
      .mockResolvedValueOnce({
        status: 200,
        url: `${origin}${XIAOHONGSHU_API_ENDPOINTS.personalInfo}`,
        contentType: 'text/html; charset=utf-8',
        text: `<html><body>${responseSecret}</body></html>`
      })
      .mockResolvedValueOnce({
        status: 200,
        url: `${origin}${XIAOHONGSHU_API_ENDPOINTS.personalInfo}`,
        contentType: 'application/json',
        text: `{ "token": "${responseSecret}" `
      })
    const contents = {
      executeJavaScript,
      getURL: () => `${origin}/new/home`,
      isDestroyed: () => false
    }

    const htmlMessage = await rejectionMessage(() => __xiaohongshuApiTransportTest.fetchPageJson(
      contents,
      XIAOHONGSHU_API_ENDPOINTS.personalInfo,
      100
    ))
    expect(htmlMessage).toContain('JSON Content-Type')
    expect(htmlMessage).not.toContain(responseSecret)
    expect(htmlMessage).not.toContain('<html>')

    const jsonMessage = await rejectionMessage(() => __xiaohongshuApiTransportTest.fetchPageJson(
      contents,
      XIAOHONGSHU_API_ENDPOINTS.personalInfo,
      100
    ))
    expect(jsonMessage).toContain('无效 JSON')
    expect(jsonMessage).not.toContain(responseSecret)
  })

  it('captures only the exact signed analyze JSON through CDP and always detaches', async () => {
    const { contents, debuggerApi, loadURL } = fakeContents((current) => emitJsonCapture(current))
    const result = await __xiaohongshuApiTransportTest.captureSignedJson(
      contents,
      XIAOHONGSHU_API_ROUTES.noteAnalytics,
      'note_analyze_list',
      20,
      200,
      5
    )

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      status: 200,
      json: { code: 0, data: { total: 0, note_infos: [] } }
    })
    expect(loadURL).toHaveBeenCalledWith(XIAOHONGSHU_API_ROUTES.noteAnalytics)
    expect(debuggerApi.commands.map((item) => item.method)).toEqual([
      'Network.enable',
      'Network.getResponseBody',
      'Network.disable'
    ])
    expect(debuggerApi.attached).toBe(false)
    expect(contents).not.toHaveProperty('executeJavaScript')
  })

  it('captures the official posted-note API from the note manager route', async () => {
    const postedUrl = `${origin}${XIAOHONGSHU_API_ENDPOINTS.postedNotes}?tab=0&page=0`
    const { contents, debuggerApi, loadURL } = fakeContents((current) => {
      emitJsonCapture(current, postedUrl)
    })

    const result = await __xiaohongshuApiTransportTest.captureSignedJson(
      contents,
      XIAOHONGSHU_API_ROUTES.noteManager,
      'posted_notes',
      20,
      200,
      5
    )

    expect(result).toHaveLength(1)
    expect(result[0]?.url).toBe(postedUrl)
    expect(loadURL).toHaveBeenCalledWith(XIAOHONGSHU_API_ROUTES.noteManager)
    expect(debuggerApi.attached).toBe(false)
  })

  it('keeps a slow second response pending beyond the first quiet window', async () => {
    const firstUrl = `${origin}${XIAOHONGSHU_API_ENDPOINTS.noteAnalyzeList}?page_num=1`
    const secondUrl = `${origin}${XIAOHONGSHU_API_ENDPOINTS.noteAnalyzeList}?page_num=2`
    const secondJson = { code: 0, data: { total: 2, note_infos: [] } }
    const secondBody = JSON.stringify(secondJson)
    const { contents } = fakeContents((current) => {
      emitJsonCapture(current, firstUrl, 'application/json', 'request-1')
      setTimeout(() => {
        emitJsonCapture(current, secondUrl, 'application/json', 'request-2', secondJson, false)
      }, 2)
      setTimeout(() => finishJsonCapture(current, 'request-2', secondBody), 15)
    })

    const result = await __xiaohongshuApiTransportTest.captureSignedJson(
      contents,
      XIAOHONGSHU_API_ROUTES.noteAnalytics,
      'note_analyze_list',
      20,
      100,
      5
    )

    expect(result.map((item) => item.url)).toEqual([firstUrl, secondUrl])
  })

  it('drives posted-note pagination without reading page elements', async () => {
    const firstUrl = `${origin}${XIAOHONGSHU_API_ENDPOINTS.postedNotes}?tab=0&page=0`
    const secondUrl = `${origin}${XIAOHONGSHU_API_ENDPOINTS.postedNotes}?tab=0&page=1`
    const firstJson = {
      code: 0,
      success: true,
      data: { total: 2, has_more: true, notes: [{ note_id: 'aaaaaaaaaaaaaaaaaaaaaaaa' }] }
    }
    const secondJson = {
      code: 0,
      success: true,
      data: { total: 2, has_more: false, notes: [{ note_id: 'bbbbbbbbbbbbbbbbbbbbbbbb' }] }
    }
    const { contents, sendInputEvent } = fakeContents((current) => {
      emitJsonCapture(current, firstUrl, 'application/json', 'request-1', firstJson)
    })
    let emittedSecondPage = false
    sendInputEvent.mockImplementation((event: Electron.InputEvent) => {
      if (event.type !== 'keyUp' || emittedSecondPage) return
      emittedSecondPage = true
      queueMicrotask(() => emitJsonCapture(
        (contents.debugger as unknown) as FakeDebugger,
        secondUrl,
        'application/json',
        'request-2',
        secondJson
      ))
    })

    const result = await __xiaohongshuApiTransportTest.captureSignedJson(
      contents,
      XIAOHONGSHU_API_ROUTES.noteManager,
      'posted_notes',
      2,
      200,
      5
    )

    expect(result.map((item) => item.url)).toEqual([firstUrl, secondUrl])
    expect(sendInputEvent).toHaveBeenCalledWith({ type: 'keyDown', keyCode: 'PageDown' })
  })

  it('ignores non-official captures, times out and still cleans up the debugger', async () => {
    const { contents, debuggerApi } = fakeContents((current) => {
      emitJsonCapture(current, 'https://evil.example/api/galaxy/creator/datacenter/note/analyze/list')
    })
    await expect(__xiaohongshuApiTransportTest.captureSignedJson(
      contents,
      XIAOHONGSHU_API_ROUTES.noteAnalytics,
      'note_analyze_list',
      20,
      20,
      5
    )).rejects.toThrow('超时')
    expect(debuggerApi.attached).toBe(false)
    expect(debuggerApi.listenerCount('message')).toBe(0)
    expect(debuggerApi.listenerCount('detach')).toBe(0)
  })
})

async function rejectionMessage(action: () => Promise<unknown>): Promise<string> {
  return (await rejectionOf(action)).message
}

async function rejectionOf(action: () => Promise<unknown>): Promise<Error & { code?: string }> {
  try {
    await action()
    throw new Error('expected action to reject')
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
}
