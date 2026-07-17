import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import type { PlatformCaptureDeclaration } from '../../shared/plugin-host-contracts'
import { __pluginPlatformJsonTest } from '../browser-manager'

describe('declarative platform JSON endpoint proxy', () => {
  it('renders only declared scalar path and query parameters', () => {
    expect(__pluginPlatformJsonTest.renderDeclaredUrl(
      'https://api.example.com',
      '/users/{userId}/contents',
      ['cursor', 'includeMetrics'],
      { userId: 'owner/a', cursor: 12, includeMetrics: true }
    )).toBe('https://api.example.com/users/owner%2Fa/contents?cursor=12&includeMetrics=true')

    expect(() => __pluginPlatformJsonTest.renderDeclaredUrl(
      'https://api.example.com', '/users/{userId}', [], {}
    )).toThrow('参数 userId 无效')
    expect(() => __pluginPlatformJsonTest.renderDeclaredUrl(
      'https://api.example.com', '/users/{userId}', [], { userId: 'owner', admin: true }
    )).toThrow('未声明参数')
    expect(() => __pluginPlatformJsonTest.renderDeclaredUrl(
      'https://api.example.com', '/users/{userId}', [], { userId: { raw: 'owner' } }
    )).toThrow('参数 userId 无效')
  })

  it('executes a fixed GET JSON request and rejects redirects or non-JSON bodies', async () => {
    const target = 'https://api.example.com/users/owner'
    const executeJavaScript = vi.fn(async (_source: string) => ({
      status: 200,
      url: target,
      contentType: 'application/json; charset=utf-8',
      text: JSON.stringify({ id: 'owner' })
    }))
    await expect(__pluginPlatformJsonTest.fetchDeclaredPlatformJson({
      executeJavaScript,
      isDestroyed: () => false
    }, target, 1_024)).resolves.toEqual({ id: 'owner' })

    const source = executeJavaScript.mock.calls[0]![0] as string
    expect(source).toContain("method: 'GET'")
    expect(source).toContain("credentials: 'include'")
    expect(source).toContain("redirect: 'error'")
    expect(source).not.toMatch(/document|querySelector|innerHTML|outerHTML|cookie/)

    executeJavaScript.mockResolvedValueOnce({
      status: 200,
      url: 'https://api.example.com/login',
      contentType: 'application/json',
      text: '{}'
    })
    await expect(__pluginPlatformJsonTest.fetchDeclaredPlatformJson({
      executeJavaScript,
      isDestroyed: () => false
    }, target, 1_024)).rejects.toThrow('响应地址与清单端点不一致')

    executeJavaScript.mockResolvedValueOnce({
      status: 200,
      url: target,
      contentType: 'text/html',
      text: '<html>login</html>'
    })
    await expect(__pluginPlatformJsonTest.fetchDeclaredPlatformJson({
      executeJavaScript,
      isDestroyed: () => false
    }, target, 1_024)).rejects.toThrow('未返回 JSON')
  })
})

describe('declarative platform Fetch/XHR capture', () => {
  it('renders shared route and response path parameters without accepting extras', () => {
    const declaration: PlatformCaptureDeclaration = {
      id: 'contents.capture',
      route: 'https://example.com/i/user/{userId}?source=official',
      responseOrigin: 'https://api.example.com',
      responsePath: '/v1/users/{userId}/contents',
      resourceTypes: ['Fetch'],
      method: 'GET'
    }

    expect(__pluginPlatformJsonTest.renderDeclaredCaptureUrls(declaration, { userId: 'owner/a' })).toEqual({
      routeUrl: 'https://example.com/i/user/owner%2Fa?source=official',
      responseUrl: 'https://api.example.com/v1/users/owner%2Fa/contents'
    })
    expect(() => __pluginPlatformJsonTest.renderDeclaredCaptureUrls(
      declaration,
      { userId: 'owner', admin: true }
    )).toThrow('未声明参数')
    expect(() => __pluginPlatformJsonTest.renderDeclaredCaptureUrls(declaration, {}))
      .toThrow('参数 userId 无效')
  })

  it('matches GraphQL captures by a single safe query id and the declared operation', () => {
    const declaration: PlatformCaptureDeclaration = {
      id: 'contents.capture',
      route: 'https://example.com/home',
      responseOrigin: 'https://api.example.com',
      responsePath: '/i/api/graphql',
      graphqlOperationName: 'UserTweets',
      resourceTypes: ['Fetch', 'XHR'],
      method: 'GET'
    }
    const expected = 'https://api.example.com/i/api/graphql'
    const matches = (url: string): boolean => __pluginPlatformJsonTest.matchesDeclaredCaptureUrl(
      url,
      declaration,
      expected
    )

    expect(matches('https://api.example.com/i/api/graphql/Abc_123-x/UserTweets?variables=private')).toBe(true)
    expect(matches('https://evil.example/i/api/graphql/Abc_123-x/UserTweets')).toBe(false)
    expect(matches('https://api.example.com/i/api/graphql/Abc_123-x/UserByScreenName')).toBe(false)
    expect(matches('https://api.example.com/i/api/graphql/Abc_123-x/UserTweets/extra')).toBe(false)
    expect(matches('https://api.example.com/i/api/graphql/bad.id/UserTweets')).toBe(false)
    expect(matches(`https://api.example.com/i/api/graphql/${'a'.repeat(129)}/UserTweets`)).toBe(false)
  })

  it('captures only the declared origin, exact path, GET method and resource type', async () => {
    const declaration: PlatformCaptureDeclaration = {
      id: 'contents.capture',
      route: 'https://creator.example.com/content-manager',
      responseOrigin: 'https://api.example.com',
      responsePath: '/v1/users/{userId}/contents',
      resourceTypes: ['Fetch', 'XHR'],
      method: 'GET',
      pagination: 'none',
      maximumResponses: 1,
      maximumResponseBytes: 1_024,
      maximumTotalBytes: 2_048
    }
    const expected = 'https://api.example.com/v1/users/owner/contents'
    const browserDebugger = new FakeDebugger()
    const loadURL = vi.fn(async (url: string) => {
      expect(url).toBe(declaration.route)
      emitCapture(browserDebugger, 'wrong-origin', 'https://evil.example/v1/users/owner/contents', 'GET', 'Fetch')
      emitCapture(browserDebugger, 'wrong-path', 'https://api.example.com/v1/users/owner/private', 'GET', 'Fetch')
      emitCapture(browserDebugger, 'wrong-method', expected, 'POST', 'Fetch')
      emitCapture(browserDebugger, 'wrong-resource', expected, 'GET', 'Document')
      emitCapture(browserDebugger, 'accepted', `${expected}?page=2`, 'GET', 'XHR', { items: [{ id: 'post-1' }] })
      await Promise.resolve()
    })
    const contents = {
      debugger: browserDebugger,
      isDestroyed: () => false,
      loadURL,
      sendInputEvent: vi.fn()
    } as unknown as Pick<WebContents, 'debugger' | 'isDestroyed' | 'loadURL' | 'sendInputEvent'>

    await expect(__pluginPlatformJsonTest.captureDeclaredPlatformJson(
      contents,
      declaration,
      expected,
      1
    )).resolves.toEqual([{ items: [{ id: 'post-1' }] }])

    expect(browserDebugger.commands.filter((item) => item.method === 'Network.getResponseBody'))
      .toEqual([{ method: 'Network.getResponseBody', params: { requestId: 'accepted' } }])
    expect(browserDebugger.attached).toBe(false)
    expect(browserDebugger.listenerCount('message')).toBe(0)
  })

  it('waits for concurrent response bodies and never exceeds the declared response limit', async () => {
    vi.useFakeTimers()
    try {
      const declaration: PlatformCaptureDeclaration = {
        id: 'identity.capture',
        route: 'https://example.com/home',
        responseOrigin: 'https://api.example.com',
        responsePath: '/v1/account/settings.json',
        resourceTypes: ['XHR'],
        method: 'GET',
        pagination: 'none',
        maximumResponses: 1,
        maximumResponseBytes: 1_024,
        maximumTotalBytes: 2_048
      }
      const expected = 'https://api.example.com/v1/account/settings.json'
      const browserDebugger = new FakeDebugger()
      let releaseBodies = (): void => undefined
      browserDebugger.bodyGate = new Promise<void>((resolve) => { releaseBodies = resolve })
      const contents = {
        debugger: browserDebugger,
        isDestroyed: () => false,
        loadURL: vi.fn(async () => {
          emitCapture(browserDebugger, 'first', expected, 'GET', 'XHR', { screen_name: 'owner' })
          emitCapture(browserDebugger, 'duplicate', expected, 'GET', 'XHR', { screen_name: 'owner' })
        }),
        sendInputEvent: vi.fn()
      } as unknown as Pick<WebContents, 'debugger' | 'isDestroyed' | 'loadURL' | 'sendInputEvent'>

      let settled = false
      const capture = __pluginPlatformJsonTest.captureDeclaredPlatformJson(
        contents,
        declaration,
        expected,
        1
      ).finally(() => { settled = true })
      await vi.advanceTimersByTimeAsync(1_100)

      expect(settled).toBe(false)
      expect(browserDebugger.attached).toBe(true)

      releaseBodies()
      await vi.runAllTimersAsync()
      await expect(capture).resolves.toEqual([{ screen_name: 'owner' }])
      expect(browserDebugger.commands.filter((item) => item.method === 'Network.getResponseBody'))
        .toEqual([{ method: 'Network.getResponseBody', params: { requestId: 'first' } }])
      expect(browserDebugger.attached).toBe(false)
      expect(browserDebugger.listenerCount('message')).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('waits beyond the quiet window for the first matching response', async () => {
    vi.useFakeTimers()
    try {
      const declaration: PlatformCaptureDeclaration = {
        id: 'identity.capture',
        route: 'https://example.com/home',
        responseOrigin: 'https://api.example.com',
        responsePath: '/v1/account/settings.json',
        resourceTypes: ['XHR'],
        method: 'GET',
        pagination: 'none',
        maximumResponses: 1,
        maximumResponseBytes: 1_024,
        maximumTotalBytes: 2_048
      }
      const expected = 'https://api.example.com/v1/account/settings.json'
      const browserDebugger = new FakeDebugger()
      const contents = {
        debugger: browserDebugger,
        isDestroyed: () => false,
        loadURL: vi.fn(async () => {
          setTimeout(() => {
            emitCapture(browserDebugger, 'delayed', expected, 'GET', 'XHR', { screen_name: 'owner' })
          }, 1_500)
        }),
        sendInputEvent: vi.fn()
      } as unknown as Pick<WebContents, 'debugger' | 'isDestroyed' | 'loadURL' | 'sendInputEvent'>

      let settled = false
      const capture = __pluginPlatformJsonTest.captureDeclaredPlatformJson(
        contents,
        declaration,
        expected,
        1
      ).finally(() => { settled = true })
      await vi.advanceTimersByTimeAsync(1_100)
      expect(settled).toBe(false)

      await vi.advanceTimersByTimeAsync(1_000)
      await expect(capture).resolves.toEqual([{ screen_name: 'owner' }])
      expect(browserDebugger.attached).toBe(false)
      expect(browserDebugger.listenerCount('message')).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('waits until the capture deadline when no matching response arrives', async () => {
    vi.useFakeTimers()
    try {
      const declaration: PlatformCaptureDeclaration = {
        id: 'identity.capture',
        route: 'https://example.com/home',
        responseOrigin: 'https://api.example.com',
        responsePath: '/v1/account/settings.json',
        resourceTypes: ['XHR'],
        method: 'GET',
        pagination: 'none',
        maximumResponses: 1,
        maximumResponseBytes: 1_024,
        maximumTotalBytes: 2_048
      }
      const expected = 'https://api.example.com/v1/account/settings.json'
      const browserDebugger = new FakeDebugger()
      const contents = {
        debugger: browserDebugger,
        isDestroyed: () => false,
        loadURL: vi.fn(async () => undefined),
        sendInputEvent: vi.fn()
      } as unknown as Pick<WebContents, 'debugger' | 'isDestroyed' | 'loadURL' | 'sendInputEvent'>

      let settled = false
      const capture = __pluginPlatformJsonTest.captureDeclaredPlatformJson(
        contents,
        declaration,
        expected,
        1
      ).finally(() => { settled = true })
      await vi.advanceTimersByTimeAsync(1_100)
      expect(settled).toBe(false)

      await vi.advanceTimersByTimeAsync(20_000)
      await expect(capture).resolves.toEqual([])
      expect(browserDebugger.attached).toBe(false)
      expect(browserDebugger.listenerCount('message')).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('times out a stalled response body and releases the debugger channel', async () => {
    vi.useFakeTimers()
    try {
      const declaration: PlatformCaptureDeclaration = {
        id: 'identity.capture',
        route: 'https://example.com/home',
        responseOrigin: 'https://api.example.com',
        responsePath: '/v1/account/settings.json',
        resourceTypes: ['XHR'],
        method: 'GET',
        pagination: 'none',
        maximumResponses: 1,
        maximumResponseBytes: 1_024,
        maximumTotalBytes: 2_048
      }
      const expected = 'https://api.example.com/v1/account/settings.json'
      const browserDebugger = new FakeDebugger()
      browserDebugger.bodyGate = new Promise<void>(() => undefined)
      const contents = {
        debugger: browserDebugger,
        isDestroyed: () => false,
        loadURL: vi.fn(async () => {
          emitCapture(browserDebugger, 'stalled', expected, 'GET', 'XHR', { screen_name: 'owner' })
        }),
        sendInputEvent: vi.fn()
      } as unknown as Pick<WebContents, 'debugger' | 'isDestroyed' | 'loadURL' | 'sendInputEvent'>

      const capture = __pluginPlatformJsonTest.captureDeclaredPlatformJson(
        contents,
        declaration,
        expected,
        1
      )
      const assertion = expect(capture).rejects.toThrow('平台响应正文读取超时')
      await vi.advanceTimersByTimeAsync(6_000)
      await assertion

      expect(browserDebugger.attached).toBe(false)
      expect(browserDebugger.listenerCount('message')).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('lets a later valid response replace an earlier rejected candidate', async () => {
    const declaration: PlatformCaptureDeclaration = {
      id: 'identity.capture',
      route: 'https://example.com/home',
      responseOrigin: 'https://api.example.com',
      responsePath: '/v1/account/settings.json',
      resourceTypes: ['XHR'],
      method: 'GET',
      pagination: 'none',
      maximumResponses: 1,
      maximumResponseBytes: 1_024,
      maximumTotalBytes: 2_048
    }
    const expected = 'https://api.example.com/v1/account/settings.json'
    const browserDebugger = new FakeDebugger()
    const contents = {
      debugger: browserDebugger,
      isDestroyed: () => false,
      loadURL: vi.fn(async () => {
        emitCapture(browserDebugger, 'rejected', expected, 'GET', 'XHR', { ignored: true }, {
          status: 500,
          contentType: 'application/json'
        })
        emitCapture(browserDebugger, 'accepted', expected, 'GET', 'XHR', { screen_name: 'owner' })
      }),
      sendInputEvent: vi.fn()
    } as unknown as Pick<WebContents, 'debugger' | 'isDestroyed' | 'loadURL' | 'sendInputEvent'>

    await expect(__pluginPlatformJsonTest.captureDeclaredPlatformJson(
      contents,
      declaration,
      expected,
      1
    )).resolves.toEqual([{ screen_name: 'owner' }])
    expect(browserDebugger.commands.filter((item) => item.method === 'Network.getResponseBody'))
      .toEqual([{ method: 'Network.getResponseBody', params: { requestId: 'accepted' } }])
  })

  it('bounds the entire serial response drain by the capture deadline', async () => {
    vi.useFakeTimers()
    try {
      const declaration: PlatformCaptureDeclaration = {
        id: 'contents.capture',
        route: 'https://example.com/home',
        responseOrigin: 'https://api.example.com',
        responsePath: '/v1/contents',
        resourceTypes: ['XHR'],
        method: 'GET',
        pagination: 'none',
        maximumResponses: 100,
        maximumResponseBytes: 1_024,
        maximumTotalBytes: 100 * 1_024
      }
      const expected = 'https://api.example.com/v1/contents'
      const browserDebugger = new FakeDebugger()
      browserDebugger.bodyDelayMs = 4_000
      const contents = {
        debugger: browserDebugger,
        isDestroyed: () => false,
        loadURL: vi.fn(async () => {
          for (let index = 0; index < 20; index += 1) {
            emitCapture(browserDebugger, `slow-${index}`, expected, 'GET', 'XHR', { index })
          }
        }),
        sendInputEvent: vi.fn()
      } as unknown as Pick<WebContents, 'debugger' | 'isDestroyed' | 'loadURL' | 'sendInputEvent'>

      const capture = __pluginPlatformJsonTest.captureDeclaredPlatformJson(
        contents,
        declaration,
        expected,
        100
      )
      const assertion = expect(capture).rejects.toThrow('平台响应正文读取超时')
      await vi.advanceTimersByTimeAsync(40_000)
      await assertion

      expect(browserDebugger.attached).toBe(false)
      expect(browserDebugger.listenerCount('message')).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

class FakeDebugger extends EventEmitter {
  attached = false
  bodyGate: Promise<void> | null = null
  bodyDelayMs = 0
  readonly commands: Array<{ method: string; params?: Record<string, unknown> }> = []
  readonly bodies = new Map<string, string>()

  isAttached(): boolean { return this.attached }
  attach(version: string): void {
    expect(version).toBe('1.3')
    this.attached = true
  }
  detach(): void { this.attached = false }

  async sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.commands.push({ method, ...(params ? { params } : {}) })
    if (method === 'Network.getResponseBody') {
      if (this.bodyGate) await this.bodyGate
      if (this.bodyDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.bodyDelayMs))
      return { body: this.bodies.get(String(params?.requestId)) ?? '', base64Encoded: false }
    }
    return {}
  }
}

function emitCapture(
  browserDebugger: FakeDebugger,
  requestId: string,
  url: string,
  method: string,
  resourceType: string,
  value: unknown = { ignored: true },
  metadata: { status?: number; contentType?: string } = {}
): void {
  browserDebugger.bodies.set(requestId, JSON.stringify(value))
  browserDebugger.emit('message', {}, 'Network.requestWillBeSent', {
    requestId,
    request: { url, method }
  })
  browserDebugger.emit('message', {}, 'Network.responseReceived', {
    requestId,
    type: resourceType,
    response: {
      url,
      status: metadata.status ?? 200,
      headers: { 'content-type': metadata.contentType ?? 'application/json' }
    }
  })
  browserDebugger.emit('message', {}, 'Network.loadingFinished', { requestId })
}
