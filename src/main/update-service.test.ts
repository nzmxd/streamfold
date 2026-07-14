import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  UpdateService,
  updateErrorMessage,
  type UpdateClient,
  type UpdateClientHandlers,
  type UpdateDescriptor,
  type UpdateDownloadProgress
} from './update-service'

class FakeUpdateClient implements UpdateClient {
  handlers: UpdateClientHandlers | null = null
  checkCalls = 0
  downloadCalls = 0
  installCalls = 0
  checkResult: () => Promise<void> = async () => undefined
  downloadResult: () => Promise<void> = async () => undefined

  subscribe(handlers: UpdateClientHandlers): () => void {
    this.handlers = handlers
    return () => { this.handlers = null }
  }

  async check(): Promise<void> {
    this.checkCalls += 1
    await this.checkResult()
  }

  async download(): Promise<void> {
    this.downloadCalls += 1
    await this.downloadResult()
  }

  restartAndInstall(): void {
    this.installCalls += 1
  }

  checking(): void {
    this.handlers?.checking()
  }

  available(info: UpdateDescriptor): void {
    this.handlers?.available(info)
  }

  notAvailable(info: UpdateDescriptor = { version: '0.4.0' }): void {
    this.handlers?.notAvailable(info)
  }

  progress(info: UpdateDownloadProgress): void {
    this.handlers?.progress(info)
  }

  downloaded(info: UpdateDescriptor): void {
    this.handlers?.downloaded(info)
  }

  error(error: Error): void {
    this.handlers?.error(error)
  }
}

const services: UpdateService[] = []

function createService(client: FakeUpdateClient, overrides: Partial<ConstructorParameters<typeof UpdateService>[0]> = {}): UpdateService {
  const service = new UpdateService({
    currentVersion: '0.4.0',
    automaticChecks: false,
    unsupportedReason: null,
    client,
    now: () => new Date('2026-07-14T08:00:00.000Z'),
    ...overrides
  })
  services.push(service)
  service.start()
  return service
}

afterEach(() => {
  for (const service of services.splice(0)) service.destroy()
  vi.useRealTimers()
})

describe('UpdateService', () => {
  it('keeps development builds offline and reports why updates are unavailable', async () => {
    const client = new FakeUpdateClient()
    const service = createService(client, { unsupportedReason: 'development', client: null })

    expect(service.getState()).toMatchObject({
      phase: 'unsupported',
      currentVersion: '0.4.0',
      unsupportedReason: 'development'
    })
    await expect(service.check()).resolves.toMatchObject({ phase: 'unsupported' })
    expect(client.checkCalls).toBe(0)
    expect(client.handlers).toBeNull()
  })

  it('checks, downloads in the background, reports bounded progress, and waits for install confirmation', async () => {
    const client = new FakeUpdateClient()
    const service = createService(client)
    const states: string[] = []
    service.subscribe((state) => states.push(state.phase))

    const check = service.check()
    client.available({ version: '0.5.0', releaseDate: '2026-07-14T07:00:00Z' })
    await check
    await vi.waitFor(() => expect(client.downloadCalls).toBe(1))

    client.progress({ percent: 140, transferred: 900, total: 800, bytesPerSecond: -1 })
    expect(service.getState().progress).toEqual({
      percent: 100,
      transferred: 800,
      total: 800,
      bytesPerSecond: 0
    })

    expect(() => service.restartAndInstall()).toThrow('更新尚未下载完成')
    client.downloaded({ version: '0.5.0', releaseDate: '2026-07-14T07:00:00Z' })
    expect(service.getState()).toMatchObject({
      phase: 'downloaded',
      availableVersion: '0.5.0',
      releaseDate: '2026-07-14T07:00:00.000Z'
    })
    service.restartAndInstall()
    expect(client.installCalls).toBe(1)
    expect(states).toEqual(expect.arrayContaining(['checking', 'available', 'downloading', 'downloaded']))
  })

  it('deduplicates concurrent checks and schedules automatic checks without networking immediately', async () => {
    vi.useFakeTimers()
    const client = new FakeUpdateClient()
    let resolveCheck = (): void => undefined
    client.checkResult = () => new Promise<void>((resolve) => { resolveCheck = resolve })
    const service = createService(client, {
      automaticChecks: true,
      initialCheckDelayMs: 1_000,
      checkIntervalMs: 5_000
    })

    expect(client.checkCalls).toBe(0)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(client.checkCalls).toBe(1)
    const duplicate = service.check()
    expect(client.checkCalls).toBe(1)
    client.notAvailable()
    resolveCheck()
    await duplicate
    expect(service.getState().phase).toBe('up-to-date')

    service.setAutomaticChecks(false)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(client.checkCalls).toBe(1)
  })

  it('preserves the target version when a download fails so it can be retried', async () => {
    const client = new FakeUpdateClient()
    client.downloadResult = async () => { throw new Error('network timeout') }
    const service = createService(client)

    client.available({ version: '0.5.0' })
    await vi.waitFor(() => expect(service.getState().phase).toBe('error'))
    expect(service.getState()).toMatchObject({
      availableVersion: '0.5.0',
      error: '无法连接更新服务器，请检查网络后重试'
    })

    client.downloadResult = async () => undefined
    await service.download()
    expect(client.downloadCalls).toBe(2)
    expect(service.getState().phase).toBe('downloading')
  })

  it('rejects malformed release versions without exposing raw updater errors', () => {
    const client = new FakeUpdateClient()
    const service = createService(client)
    client.available({ version: '<script>alert(1)</script>' })

    expect(service.getState()).toMatchObject({
      phase: 'error',
      availableVersion: null,
      error: '检查更新失败，请稍后重试'
    })
    expect(updateErrorMessage(new Error('sha512 checksum mismatch'))).toBe('更新包校验未通过，已停止安装')
    expect(updateErrorMessage(new Error('GET latest.yml returned 404'))).toBe('更新服务暂不可用，请稍后重试')
  })
})
