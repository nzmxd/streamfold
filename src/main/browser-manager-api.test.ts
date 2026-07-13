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
    expect(source).toContain("headers: { Accept: 'application/json' }")
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
