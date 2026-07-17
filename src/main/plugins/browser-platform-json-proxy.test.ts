import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import type { PlatformCaptureDeclaration } from '../../shared/plugin-host-contracts'
import { __pluginPlatformJsonTest } from '../browser-manager'
import { BrowserPlatformJsonProxy } from './browser-platform-json-proxy'
import { formatSandboxDiagnostic } from './sandbox-diagnostics'
import {
  PluginNetworkDiagnosticError,
  pluginNetworkResponseError
} from './network-diagnostics'

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

  it.each([
    [500, 'application/json', JSON.stringify({
      errors: [{ code: 88, message: 'limited', auth_token: 'private-token' }],
      headers: { authorization: 'private-header' },
      query: { cursor: 'private-query' }
    }), '异常状态'],
    [200, 'text/html', '<html>login Cookie: private-cookie</html>', '未返回 JSON'],
    [200, 'application/json', '{"broken":', '无效 JSON'],
    [200, 'application/json', JSON.stringify({
      error: { code: 'ACCOUNT_LOCKED', message: 'locked', accessToken: 'private-token' }
    }), 'API 错误']
  ] as const)('retains sanitized diagnostics for status/content-type/parse/API failures', async (
    status,
    contentType,
    text,
    expectedMessage
  ) => {
    const target = 'https://api.example.com/users/owner?token=must-not-reach-error'
    const error = await rejectionOf(() => __pluginPlatformJsonTest.fetchDeclaredPlatformJson({
      executeJavaScript: vi.fn(async () => ({ status, url: target, contentType, text })),
      isDestroyed: () => false
    }, target, 64 * 1024))

    expect(error).toBeInstanceOf(PluginNetworkDiagnosticError)
    expect((error as Error).message).toContain(expectedMessage)
    expect(error).toMatchObject({
      status,
      contentType: contentType.includes('json') ? 'application/json' : 'text/html',
      responseBytes: Buffer.byteLength(text, 'utf8')
    })
    const diagnostic = formatSandboxDiagnostic(error) ?? ''
    for (const hidden of [
      'must-not-reach-error', 'private-token', 'private-header', 'private-query', 'private-cookie',
      'headers', 'query'
    ]) expect(diagnostic).not.toContain(hidden)
    if (text.includes('ACCOUNT_LOCKED')) expect(diagnostic).toContain('ACCOUNT_LOCKED')
  })
})

describe('BrowserPlatformJsonProxy transport boundary', () => {
  it('replaces raw transport errors without retaining URL, query, headers or params', async () => {
    const browser = {
      getPluginPlatformJson: vi.fn(async () => {
        throw new Error(
          'load failed https://api.example.test/path?token=private-url headers={cookie: private-header} params={id: private-param}'
        )
      })
    }
    const proxy = new BrowserPlatformJsonProxy(browser as never)
    const error = await rejectionOf(() => proxy.getJson({} as never))

    expect(error).toBeInstanceOf(PluginNetworkDiagnosticError)
    expect((error as Error).message).toBe('平台 JSON 端点请求失败')
    expect(error).not.toHaveProperty('cause')
    const diagnostic = formatSandboxDiagnostic(error) ?? ''
    for (const hidden of [
      'api.example.test', 'private-url', 'private-header', 'private-param', 'headers=', 'params='
    ]) expect(diagnostic).not.toContain(hidden)
  })

  it('preserves an already projected response diagnostic', async () => {
    const projected = pluginNetworkResponseError('平台请求暂时受限，请稍后重试', {
      status: 429,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 88, message: 'limited' } })
    })
    const browser = {
      capturePluginPlatformJson: vi.fn(async () => { throw projected })
    }
    const proxy = new BrowserPlatformJsonProxy(browser as never)

    await expect(rejectionOf(() => proxy.captureJson({} as never))).resolves.toBe(projected)
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

  it('allows a bounded slow first Network.enable on a cold account workspace', async () => {
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
      browserDebugger.enableDelayMs = 6_000
      const contents = {
        debugger: browserDebugger,
        isDestroyed: () => false,
        loadURL: vi.fn(async () => {
          emitCapture(browserDebugger, 'settings', expected, 'GET', 'XHR', { screen_name: 'owner' })
        }),
        sendInputEvent: vi.fn()
      } as unknown as Pick<WebContents, 'debugger' | 'isDestroyed' | 'loadURL' | 'sendInputEvent'>

      const capture = __pluginPlatformJsonTest.captureDeclaredPlatformJson(
        contents,
        declaration,
        expected,
        1
      )
      const assertion = expect(capture).resolves.toEqual([{ screen_name: 'owner' }])
      await vi.runAllTimersAsync()
      await assertion
      expect(browserDebugger.commands[0]?.method).toBe('Network.enable')
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
      .toEqual([
        { method: 'Network.getResponseBody', params: { requestId: 'rejected' } },
        { method: 'Network.getResponseBody', params: { requestId: 'accepted' } }
      ])
  })

  it('waits for a delayed valid response after an earlier rejected candidate', async () => {
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
          emitCapture(browserDebugger, 'rejected', expected, 'GET', 'XHR', { ignored: true }, {
            status: 500,
            contentType: 'application/json'
          })
          setTimeout(() => {
            emitCapture(browserDebugger, 'accepted', expected, 'GET', 'XHR', { screen_name: 'owner' })
          }, 1_500)
        }),
        sendInputEvent: vi.fn()
      } as unknown as Pick<WebContents, 'debugger' | 'isDestroyed' | 'loadURL' | 'sendInputEvent'>

      const capture = __pluginPlatformJsonTest.captureDeclaredPlatformJson(
        contents,
        declaration,
        expected,
        1
      )
      await vi.advanceTimersByTimeAsync(1_100)
      await vi.advanceTimersByTimeAsync(1_000)
      await expect(capture).resolves.toEqual([{ screen_name: 'owner' }])
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps page-down capture active beyond the first quiet window', async () => {
    vi.useFakeTimers()
    try {
      const declaration: PlatformCaptureDeclaration = {
        id: 'contents.capture',
        route: 'https://example.com/home',
        responseOrigin: 'https://api.example.com',
        responsePath: '/v1/contents',
        resourceTypes: ['XHR'],
        method: 'GET',
        pagination: 'page-down',
        maximumResponses: 2,
        maximumResponseBytes: 1_024,
        maximumTotalBytes: 2_048
      }
      const expected = 'https://api.example.com/v1/contents'
      const browserDebugger = new FakeDebugger()
      let secondScheduled = false
      const sendInputEvent = vi.fn((event: Electron.InputEvent) => {
        if (event.type !== 'keyUp' || secondScheduled) return
        secondScheduled = true
        setTimeout(() => {
          emitCapture(browserDebugger, 'second', expected, 'GET', 'XHR', { page: 2 })
        }, 1_500)
      })
      const contents = {
        debugger: browserDebugger,
        isDestroyed: () => false,
        loadURL: vi.fn(async () => {
          emitCapture(browserDebugger, 'first', expected, 'GET', 'XHR', { page: 1 })
        }),
        sendInputEvent
      } as unknown as Pick<WebContents, 'debugger' | 'isDestroyed' | 'loadURL' | 'sendInputEvent'>

      let settled = false
      const capture = __pluginPlatformJsonTest.captureDeclaredPlatformJson(
        contents,
        declaration,
        expected,
        2
      ).finally(() => { settled = true })

      await vi.advanceTimersByTimeAsync(1_100)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(1_000)
      await expect(capture).resolves.toEqual([{ page: 1 }, { page: 2 }])
      expect(sendInputEvent).toHaveBeenCalledWith({ type: 'keyDown', keyCode: 'END' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('fails when a rejected pagination response follows valid data', async () => {
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
      maximumResponses: 2,
      maximumResponseBytes: 64 * 1_024,
      maximumTotalBytes: 128 * 1_024
    }
      const expected = 'https://api.example.com/v1/contents'
      const browserDebugger = new FakeDebugger()
      const contents = {
      debugger: browserDebugger,
      isDestroyed: () => false,
      loadURL: vi.fn(async () => {
        emitCapture(browserDebugger, 'accepted', expected, 'GET', 'XHR', { items: [{ id: 'first' }] })
        emitCapture(browserDebugger, 'rejected', expected, 'GET', 'XHR', {
          errors: [{ code: 'UPSTREAM_PAGE_FAILED', message: 'second page failed' }]
        })
      }),
      sendInputEvent: vi.fn()
    } as unknown as Pick<WebContents, 'debugger' | 'isDestroyed' | 'loadURL' | 'sendInputEvent'>

      const capture = __pluginPlatformJsonTest.captureDeclaredPlatformJson(
        contents,
        declaration,
        expected,
        2
      )
      const errorPromise = rejectionOf(() => capture)
      await vi.advanceTimersByTimeAsync(21_000)
      const error = await errorPromise
      expect(error).toBeInstanceOf(PluginNetworkDiagnosticError)
      expect(formatSandboxDiagnostic(error)).toContain('UPSTREAM_PAGE_FAILED')
    } finally {
      vi.useRealTimers()
    }
  })

  it.each([
    [500, { error: { code: 'UPSTREAM_FAILED', message: 'remote failed', auth_token: 'private-token' } }, '异常状态'],
    [200, { errors: [{ code: 88, message: 'limited', cookie: 'private-cookie' }] }, 'API 错误']
  ] as const)('reports a sanitized rejected response when no valid candidate follows', async (
    status,
    value,
    expectedMessage
  ) => {
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
      maximumResponseBytes: 64 * 1024,
      maximumTotalBytes: 64 * 1024
    }
      const expected = 'https://api.example.com/v1/account/settings.json'
      const browserDebugger = new FakeDebugger()
      const contents = {
      debugger: browserDebugger,
      isDestroyed: () => false,
      loadURL: vi.fn(async () => {
        emitCapture(browserDebugger, 'rejected', expected, 'GET', 'XHR', value, { status })
      }),
      sendInputEvent: vi.fn()
    } as unknown as Pick<WebContents, 'debugger' | 'isDestroyed' | 'loadURL' | 'sendInputEvent'>

      const capture = __pluginPlatformJsonTest.captureDeclaredPlatformJson(
        contents,
        declaration,
        expected,
        1
      )
      const errorPromise = rejectionOf(() => capture)
      await vi.advanceTimersByTimeAsync(21_000)
      const error = await errorPromise
      expect(error).toBeInstanceOf(PluginNetworkDiagnosticError)
      expect((error as Error).message).toContain(expectedMessage)
      const diagnostic = formatSandboxDiagnostic(error) ?? ''
      expect(diagnostic).toContain(status === 500 ? 'UPSTREAM_FAILED' : 'limited')
      expect(diagnostic).not.toContain('private-token')
      expect(diagnostic).not.toContain('private-cookie')
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports an unexpected debugger detach instead of returning an empty capture', async () => {
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
          setTimeout(() => browserDebugger.detach(), 500)
        }),
        sendInputEvent: vi.fn()
      } as unknown as Pick<WebContents, 'debugger' | 'isDestroyed' | 'loadURL' | 'sendInputEvent'>

      const capture = __pluginPlatformJsonTest.captureDeclaredPlatformJson(
        contents,
        declaration,
        expected,
        1
      )
      const errorPromise = rejectionOf(() => capture)
      await vi.advanceTimersByTimeAsync(1_000)
      await expect(errorPromise).resolves.toMatchObject({
        message: expect.stringContaining('调试通道意外断开')
      })
    } finally {
      vi.useRealTimers()
    }
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
  enableDelayMs = 0
  readonly commands: Array<{ method: string; params?: Record<string, unknown> }> = []
  readonly bodies = new Map<string, string>()

  isAttached(): boolean { return this.attached }
  attach(version: string): void {
    expect(version).toBe('1.3')
    this.attached = true
  }
  detach(): void {
    this.attached = false
    this.emit('detach', {}, 'target closed')
  }

  async sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.commands.push({ method, ...(params ? { params } : {}) })
    if (method === 'Network.enable' && this.enableDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.enableDelayMs))
    }
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

async function rejectionOf(action: () => Promise<unknown>): Promise<unknown> {
  try {
    await action()
  } catch (error) {
    return error
  }
  throw new Error('Expected action to reject')
}
