import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { PlatformCaptureDeclaration } from '../../shared/plugin-host-contracts'
import {
  BackgroundCaptureSupervisor,
  type BackgroundCaptureNotice
} from './background-capture-supervisor'

describe('BackgroundCaptureSupervisor', () => {
  it('ignores responses from another route identity and accepts a correlated response', async () => {
    const browserDebugger = new FakeDebugger()
    const notices: BackgroundCaptureNotice[] = []
    const route = 'https://social.example/users/owner'
    const endpoint = 'https://api.example/profile'
    const supervisor = createSupervisor(browserDebugger, notices)

    expect(supervisor.read(
      'example:1',
      capture('profile', route, endpoint),
      ['/data/screen_name', '/data/name'],
      [{
        routeParameter: 'handle',
        responseFieldPaths: ['/data/screen_name'],
        comparison: 'case-insensitive'
      }],
      { handle: 'Owner' },
      endpoint,
      route,
      1
    )).toEqual([])
    await vi.waitFor(() => expect(browserDebugger.loadURL).toHaveBeenCalledOnce())

    emitCapture(browserDebugger, 'wrong-owner', endpoint, {
      data: { screen_name: 'someone-else', name: 'Other' }
    })
    await vi.waitFor(() => expect(bodyReadCount(browserDebugger)).toBe(1))
    expect(supervisor.read(
      'example:1',
      capture('profile', route, endpoint),
      ['/data/screen_name', '/data/name'],
      [{
        routeParameter: 'handle',
        responseFieldPaths: ['/data/screen_name'],
        comparison: 'case-insensitive'
      }],
      { handle: 'Owner' },
      endpoint,
      route,
      1
    )).toEqual([])
    expect(captureNotices(notices)).toEqual([])

    emitCapture(browserDebugger, 'owner', endpoint, {
      data: { screen_name: 'owner', name: 'Owner' }
    })
    await vi.waitFor(() => expect(captureNotices(notices)).toEqual(['profile']))
    expect(supervisor.read(
      'example:1',
      capture('profile', route, endpoint),
      ['/data/screen_name', '/data/name'],
      [{
        routeParameter: 'handle',
        responseFieldPaths: ['/data/screen_name'],
        comparison: 'case-insensitive'
      }],
      { handle: 'Owner' },
      endpoint,
      route,
      1
    )).toEqual([{ data: { screen_name: 'owner', name: 'Owner' } }])
    supervisor.dispose()
  })

  it('keeps independent rules isolated by capture id and endpoint', async () => {
    const browserDebugger = new FakeDebugger()
    const notices: BackgroundCaptureNotice[] = []
    const supervisor = createSupervisor(browserDebugger, notices)
    const settingsEndpoint = 'https://api.example/settings'
    const profileEndpoint = 'https://api.example/profile'
    const settings = capture('settings', 'https://social.example/settings', settingsEndpoint)
    const profile = capture('profile', 'https://social.example/profile', profileEndpoint)

    expect(supervisor.read(
      'example:1', settings, ['/screen_name'], [], {},
      settingsEndpoint, settings.route, 1
    )).toEqual([])
    expect(supervisor.read(
      'example:1', profile, ['/data/name'], [], {},
      profileEndpoint, profile.route, 1
    )).toEqual([])
    await vi.waitFor(() => expect(browserDebugger.loadURL).toHaveBeenCalledTimes(2))

    emitCapture(browserDebugger, 'settings', settingsEndpoint, { screen_name: 'owner' })
    await vi.waitFor(() => expect(captureNotices(notices)).toEqual(['settings']))
    expect(supervisor.read(
      'example:1', settings, ['/screen_name'], [], {},
      settingsEndpoint, settings.route, 1
    )).toEqual([{ screen_name: 'owner' }])
    expect(supervisor.read(
      'example:1', profile, ['/data/name'], [], {},
      profileEndpoint, profile.route, 1
    )).toEqual([])

    emitCapture(browserDebugger, 'profile', profileEndpoint, { data: { name: 'Owner' } })
    await vi.waitFor(() => expect(captureNotices(notices)).toEqual(['settings', 'profile']))
    expect(supervisor.read(
      'example:1', profile, ['/data/name'], [], {},
      profileEndpoint, profile.route, 1
    )).toEqual([{ data: { name: 'Owner' } }])
    expect(supervisor.read(
      'example:1', settings, ['/screen_name'], [], {},
      settingsEndpoint, settings.route, 1
    )).toEqual([{ screen_name: 'owner' }])
    supervisor.dispose()
  })

  it('keeps a response retry armed when the page load that produced the failure succeeds', async () => {
    vi.useFakeTimers()
    try {
      const browserDebugger = new FakeDebugger()
      const notices: BackgroundCaptureNotice[] = []
      const route = 'https://social.example/settings'
      const endpoint = 'https://api.example/settings'
      browserDebugger.loadURL.mockImplementationOnce(async () => {
        emitCapture(
          browserDebugger,
          'failed-response',
          endpoint,
          { error: { code: 'UPSTREAM_FAILED', message: 'try again' } },
          { status: 500 }
        )
      })
      const supervisor = createSupervisor(browserDebugger, notices, {
        retryInitialDelayMs: 1_000,
        retryMaximumDelayMs: 1_000
      })

      expect(supervisor.read(
        'example:1',
        capture('settings', route, endpoint),
        ['/screen_name'],
        [],
        {},
        endpoint,
        route,
        1
      )).toEqual([])
      await vi.advanceTimersByTimeAsync(0)
      expect(browserDebugger.loadURL).toHaveBeenCalledOnce()
      expect(supervisor.health()).toMatchObject({ status: 'retrying', retryAttempt: 1 })

      await vi.advanceTimersByTimeAsync(999)
      expect(browserDebugger.loadURL).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(1)
      expect(browserDebugger.loadURL).toHaveBeenCalledTimes(2)
      supervisor.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})

class FakeDebugger extends EventEmitter {
  attached = false
  readonly commands: Array<{ method: string; params?: Record<string, unknown> }> = []
  readonly bodies = new Map<string, string>()
  readonly loadURL = vi.fn(async () => undefined)

  isAttached(): boolean { return this.attached }
  attach(): void { this.attached = true }
  detach(): void {
    this.attached = false
    this.emit('detach', {}, 'target closed')
  }

  async sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.commands.push({ method, ...(params ? { params } : {}) })
    if (method === 'Network.getResponseBody') {
      return { body: this.bodies.get(String(params?.requestId)) ?? '', base64Encoded: false }
    }
    return {}
  }
}

function createSupervisor(
  browserDebugger: FakeDebugger,
  notices: BackgroundCaptureNotice[],
  options: { retryInitialDelayMs?: number; retryMaximumDelayMs?: number } = {}
): BackgroundCaptureSupervisor {
  return new BackgroundCaptureSupervisor({
    debugger: browserDebugger as never,
    getURL: () => '',
    isDestroyed: () => false,
    loadURL: browserDebugger.loadURL
  }, (notice) => notices.push(notice), Date.now, options)
}

function capture(id: string, route: string, endpoint: string): PlatformCaptureDeclaration {
  const url = new URL(endpoint)
  return {
    id,
    route,
    responseOrigin: url.origin,
    responsePath: url.pathname,
    resourceTypes: ['Fetch', 'XHR'],
    method: 'GET',
    maximumResponses: 1,
    maximumResponseBytes: 128 * 1024,
    maximumTotalBytes: 128 * 1024
  }
}

function emitCapture(
  browserDebugger: FakeDebugger,
  requestId: string,
  url: string,
  value: unknown,
  options: { status?: number; mimeType?: string } = {}
): void {
  browserDebugger.bodies.set(requestId, JSON.stringify(value))
  browserDebugger.emit('message', {}, 'Network.requestWillBeSent', {
    requestId,
    request: { url, method: 'GET' }
  })
  browserDebugger.emit('message', {}, 'Network.responseReceived', {
    requestId,
    type: 'XHR',
    response: {
      url,
      status: options.status ?? 200,
      mimeType: options.mimeType ?? 'application/json'
    }
  })
  browserDebugger.emit('message', {}, 'Network.loadingFinished', { requestId })
}

function bodyReadCount(browserDebugger: FakeDebugger): number {
  return browserDebugger.commands.filter((item) => item.method === 'Network.getResponseBody').length
}

function captureNotices(notices: readonly BackgroundCaptureNotice[]): string[] {
  return notices.flatMap((notice) => (
    notice.reason === 'capture' && notice.captureId ? [notice.captureId] : []
  ))
}
