import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { PlatformCaptureDeclaration } from '../../shared/plugin-host-contracts'
import {
  XBackgroundCaptureMonitor,
  __xBackgroundCaptureTest
} from './x-background-capture-monitor'
import { PluginNetworkDiagnosticError } from './network-diagnostics'
import { formatSandboxDiagnostic } from './sandbox-diagnostics'

describe('official X background identity capture', () => {
  it('projects only identity fields and removes credentials before caching', () => {
    const projected = __xBackgroundCaptureTest.project('x.identity.profile.initial', {
      auth_token: 'top-secret',
      cookie: 'private-cookie',
      data: {
        user: {
          result: {
            rest_id: '12345',
            access_token: 'hidden',
            core: { screen_name: 'owner', name: 'Owner', authorization: 'hidden' },
            avatar: { image_url: 'https://pbs.twimg.com/profile.jpg', cookie: 'hidden' },
            profile_bio: { description: 'bio', csrf: 'hidden' },
            legacy: {
              followers_count: 12,
              friends_count: 3,
              statuses_count: 8,
              session: 'hidden'
            }
          }
        }
      }
    })

    expect(projected).toEqual({
      data: {
        user: {
          result: {
            rest_id: '12345',
            core: { screen_name: 'owner', name: 'Owner' },
            avatar: { image_url: 'https://pbs.twimg.com/profile.jpg' },
            profile_bio: { description: 'bio' },
            legacy: { followers_count: 12, friends_count: 3, statuses_count: 8 }
          }
        }
      }
    })
    expect(JSON.stringify(projected)).not.toContain('secret')
    expect(JSON.stringify(projected)).not.toContain('hidden')
  })

  it('returns immediately, attaches once, and serves a later whitelisted response from memory', async () => {
    const browserDebugger = new FakeDebugger()
    const notices: string[] = []
    const route = 'https://x.com/home'
    const loadURL = vi.fn(async () => {
      emitCapture(browserDebugger, 'settings', 'https://api.x.com/1.1/account/settings.json', {
        screen_name: 'owner',
        auth_token: 'must-not-reach-plugin'
      })
    })
    const monitor = new XBackgroundCaptureMonitor({
      debugger: browserDebugger as never,
      getURL: () => route,
      isDestroyed: () => false,
      loadURL
    }, (notice) => notices.push(notice.captureId))

    expect(monitor.read('official:1', settingsCapture(), 'https://api.x.com/1.1/account/settings.json', route, 1))
      .toEqual([])
    await vi.waitFor(() => expect(notices).toEqual(['x.identity.settings']))

    expect(monitor.read('official:1', settingsCapture(), 'https://api.x.com/1.1/account/settings.json', route, 1))
      .toEqual([{ screen_name: 'owner' }])
    expect(browserDebugger.commands.filter((item) => item.method === 'Network.enable')).toHaveLength(1)
    expect(browserDebugger.commands.filter((item) => item.method === 'Network.getResponseBody')).toHaveLength(1)
    expect(loadURL).toHaveBeenCalledOnce()

    monitor.dispose()
    expect(browserDebugger.attached).toBe(false)
    expect(browserDebugger.listenerCount('message')).toBe(0)
  })

  it('reattaches and rearms registered captures after an unexpected debugger detach', async () => {
    vi.useFakeTimers()
    try {
      const browserDebugger = new FakeDebugger()
      const notices: string[] = []
      const route = 'https://x.com/home'
      const loadURL = vi.fn(async () => undefined)
      const monitor = new XBackgroundCaptureMonitor({
        debugger: browserDebugger as never,
        getURL: () => route,
        isDestroyed: () => false,
        loadURL
      }, (notice) => notices.push(notice.captureId))

      expect(monitor.read(
        'official:1', settingsCapture(), 'https://api.x.com/1.1/account/settings.json', route, 1
      )).toEqual([])
      await vi.advanceTimersByTimeAsync(0)
      expect(loadURL).toHaveBeenCalledOnce()

      browserDebugger.detach()
      await vi.advanceTimersByTimeAsync(0)
      expect(notices).toEqual(['x.identity.settings'])

      await vi.advanceTimersByTimeAsync(1_000)
      expect(browserDebugger.commands.filter((item) => item.method === 'Network.enable')).toHaveLength(2)
      expect(loadURL).toHaveBeenCalledTimes(2)
      monitor.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('retries initialization failures without an overall listener deadline', async () => {
    vi.useFakeTimers()
    try {
      const browserDebugger = new FakeDebugger()
      browserDebugger.enableFailures = 1
      const notices: string[] = []
      const route = 'https://x.com/home'
      const loadURL = vi.fn(async () => undefined)
      const monitor = new XBackgroundCaptureMonitor({
        debugger: browserDebugger as never,
        getURL: () => route,
        isDestroyed: () => false,
        loadURL
      }, (notice) => notices.push(notice.captureId))

      expect(monitor.read(
        'official:1', settingsCapture(), 'https://api.x.com/1.1/account/settings.json', route, 1
      )).toEqual([])
      await vi.advanceTimersByTimeAsync(0)
      expect(notices).toEqual(['x.identity.settings'])
      expect(loadURL).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(1_000)
      expect(browserDebugger.commands.filter((item) => item.method === 'Network.enable')).toHaveLength(2)
      expect(loadURL).toHaveBeenCalledOnce()
      monitor.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('refreshes a repeated identity response without emitting a duplicate notice', async () => {
    const browserDebugger = new FakeDebugger()
    let now = 1_000
    const notices: string[] = []
    const route = 'https://x.com/home'
    const endpoint = 'https://api.x.com/1.1/account/settings.json'
    const loadURL = vi.fn(async () => {
      emitCapture(browserDebugger, 'first', endpoint, { screen_name: 'owner' })
    })
    const monitor = new XBackgroundCaptureMonitor({
      debugger: browserDebugger as never,
      getURL: () => route,
      isDestroyed: () => false,
      loadURL
    }, (notice) => notices.push(notice.captureId), () => now)

    expect(monitor.read('official:1', settingsCapture(), endpoint, route, 1)).toEqual([])
    await vi.waitFor(() => expect(loadURL).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(monitor.read(
      'official:1', settingsCapture(), endpoint, route, 1
    )).toEqual([{ screen_name: 'owner' }]))
    await vi.waitFor(() => expect(notices).toHaveLength(1))

    now += 2 * 60_000 + 1
    emitCapture(browserDebugger, 'repeated', endpoint, { screen_name: 'owner' })
    await vi.waitFor(() => expect(
      browserDebugger.commands.filter((item) => item.method === 'Network.getResponseBody')
    ).toHaveLength(2))
    await new Promise<void>((resolve) => setImmediate(resolve))
    await vi.waitFor(() => expect(monitor.read(
      'official:1', settingsCapture(), endpoint, route, 1
    )).toEqual([{ screen_name: 'owner' }]))
    expect(notices).toHaveLength(1)
    monitor.dispose()
  })

  it('never reads a body for an undeclared origin, method, resource type or operation', async () => {
    const browserDebugger = new FakeDebugger()
    const route = 'https://x.com/owner'
    const loadURL = vi.fn(async () => {
      emitCapture(browserDebugger, 'origin', 'https://evil.example/i/api/graphql/q/UserByScreenName', {})
      emitCapture(browserDebugger, 'operation', 'https://x.com/i/api/graphql/q/Viewer', {})
      emitCapture(browserDebugger, 'method', 'https://x.com/i/api/graphql/q/UserByScreenName', {}, 'POST')
      emitCapture(browserDebugger, 'resource', 'https://x.com/i/api/graphql/q/UserByScreenName', {}, 'GET', 'Document')
    })
    const monitor = new XBackgroundCaptureMonitor({
      debugger: browserDebugger as never,
      getURL: () => route,
      isDestroyed: () => false,
      loadURL
    }, vi.fn())

    expect(monitor.read(
      'official:1',
      profileCapture(),
      'https://x.com/i/api/graphql',
      route,
      1
    )).toEqual([])
    await vi.waitFor(() => expect(loadURL).toHaveBeenCalledOnce())
    await Promise.resolve()

    expect(browserDebugger.commands.filter((item) => item.method === 'Network.getResponseBody')).toHaveLength(0)
    monitor.dispose()
  })

  it.each([
    [401, 'application/json', JSON.stringify({
      error: { code: 'AUTH_EXPIRED', message: 'sign in again', auth_token: 'private-token' }
    }), '平台登录状态已失效'],
    [429, 'application/json', JSON.stringify({
      error: { code: 'RATE_LIMITED', message: 'try later', cookie: 'private-cookie' }
    }), '平台请求暂时受限'],
    [500, 'application/json', JSON.stringify({
      error: { code: 'UPSTREAM_FAILED', message: 'remote failed', clientSecret: 'private-secret' }
    }), '异常状态'],
    [200, 'text/html', '<html>unexpected login page Cookie: private-cookie</html>', '未返回 JSON'],
    [200, 'application/json', '{"broken":', '无效 JSON'],
    [200, 'application/json', JSON.stringify({
      errors: [{ code: 88, message: 'GraphQL limited', authorization: 'private-auth' }]
    }), 'API 错误']
  ] as const)('reports a sanitized background response failure for HTTP %s', async (
    status,
    mimeType,
    rawBody,
    expectedMessage
  ) => {
    const { failure, monitor } = await captureFailure({ status, mimeType, rawBody })

    expect(failure).toBeInstanceOf(PluginNetworkDiagnosticError)
    expect((failure as Error).message).toContain(expectedMessage)
    expect(failure).toMatchObject({ status, contentType: mimeType })
    const diagnostic = formatSandboxDiagnostic(failure) ?? ''
    expect(diagnostic).toContain(String(status))
    for (const secret of [
      'private-token', 'private-cookie', 'private-secret', 'private-auth',
      'request-cookie', 'response-authorization'
    ]) expect(diagnostic).not.toContain(secret)
    monitor.dispose()
  })

  it('clears a background failure after a later valid projected response', async () => {
    const browserDebugger = new FakeDebugger()
    const notices: string[] = []
    const route = 'https://x.com/home'
    const endpoint = 'https://api.x.com/1.1/account/settings.json'
    const loadURL = vi.fn(async () => {
      emitCapture(browserDebugger, 'failed', endpoint, {
        error: { code: 'UPSTREAM_FAILED', message: 'remote failed' }
      }, 'GET', 'XHR', { status: 500 })
    })
    const monitor = new XBackgroundCaptureMonitor({
      debugger: browserDebugger as never,
      getURL: () => route,
      isDestroyed: () => false,
      loadURL
    }, (notice) => notices.push(notice.captureId))

    expect(monitor.read('official:1', settingsCapture(), endpoint, route, 1)).toEqual([])
    await vi.waitFor(() => expect(notices).toHaveLength(1))
    expect(() => monitor.read('official:1', settingsCapture(), endpoint, route, 1)).toThrow('异常状态')

    emitCapture(browserDebugger, 'valid', endpoint, { screen_name: 'owner' })
    await vi.waitFor(() => expect(notices).toHaveLength(2))
    expect(monitor.read('official:1', settingsCapture(), endpoint, route, 1))
      .toEqual([{ screen_name: 'owner' }])
    monitor.dispose()
  })
})

class FakeDebugger extends EventEmitter {
  attached = false
  enableFailures = 0
  readonly commands: Array<{ method: string; params?: Record<string, unknown> }> = []
  readonly bodies = new Map<string, string>()

  isAttached(): boolean { return this.attached }
  attach(): void { this.attached = true }
  detach(): void {
    this.attached = false
    this.emit('detach', {}, 'target closed')
  }

  async sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.commands.push({ method, ...(params ? { params } : {}) })
    if (method === 'Network.enable' && this.enableFailures > 0) {
      this.enableFailures -= 1
      throw new Error('enable failed')
    }
    if (method === 'Network.getResponseBody') {
      return { body: this.bodies.get(String(params?.requestId)) ?? '', base64Encoded: false }
    }
    return {}
  }
}

function emitCapture(
  browserDebugger: FakeDebugger,
  requestId: string,
  url: string,
  value: unknown,
  method = 'GET',
  resourceType = 'XHR',
  options: { status?: number; mimeType?: string; rawBody?: string } = {}
): void {
  browserDebugger.bodies.set(requestId, options.rawBody ?? JSON.stringify(value))
  browserDebugger.emit('message', {}, 'Network.requestWillBeSent', {
    requestId,
    request: { url, method, headers: { cookie: 'request-cookie' } }
  })
  browserDebugger.emit('message', {}, 'Network.responseReceived', {
    requestId,
    type: resourceType,
    response: {
      url,
      status: options.status ?? 200,
      mimeType: options.mimeType ?? 'application/json',
      headers: { authorization: 'response-authorization' }
    }
  })
  browserDebugger.emit('message', {}, 'Network.loadingFinished', { requestId })
}

async function captureFailure(input: {
  status: number
  mimeType: string
  rawBody: string
}): Promise<{ failure: unknown; monitor: XBackgroundCaptureMonitor }> {
  const browserDebugger = new FakeDebugger()
  const notices: string[] = []
  const route = 'https://x.com/home'
  const endpoint = 'https://api.x.com/1.1/account/settings.json?auth_token=request-secret'
  const monitor = new XBackgroundCaptureMonitor({
    debugger: browserDebugger as never,
    getURL: () => route,
    isDestroyed: () => false,
    loadURL: vi.fn(async () => {
      emitCapture(browserDebugger, 'failure', endpoint, null, 'GET', 'XHR', input)
    })
  }, (notice) => notices.push(notice.captureId))

  expect(monitor.read('official:1', settingsCapture(), endpoint, route, 1)).toEqual([])
  await vi.waitFor(() => expect(notices).toHaveLength(1))
  let failure: unknown
  try {
    monitor.read('official:1', settingsCapture(), endpoint, route, 1)
  } catch (error) {
    failure = error
  }
  return { failure, monitor }
}

function settingsCapture(): PlatformCaptureDeclaration {
  return {
    id: 'x.identity.settings',
    route: 'https://x.com/home',
    responseOrigin: 'https://api.x.com',
    responsePath: '/1.1/account/settings.json',
    resourceTypes: ['Fetch', 'XHR'],
    method: 'GET',
    maximumResponses: 1,
    maximumResponseBytes: 128 * 1024,
    maximumTotalBytes: 128 * 1024
  }
}

function profileCapture(): PlatformCaptureDeclaration {
  return {
    id: 'x.identity.profile.initial',
    route: 'https://x.com/{handle}',
    responseOrigin: 'https://x.com',
    responsePath: '/i/api/graphql',
    graphqlOperationName: 'UserByScreenName',
    resourceTypes: ['Fetch', 'XHR'],
    method: 'GET',
    maximumResponses: 1,
    maximumResponseBytes: 512 * 1024,
    maximumTotalBytes: 512 * 1024
  }
}
