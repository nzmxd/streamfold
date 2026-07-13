import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SocialDatabase } from './database'
import { PluginService } from './plugin-service'
import { JobService } from './services/job-service'
import {
  XiaohongshuApiService,
  XIAOHONGSHU_API_PLUGIN_ID
} from './xiaohongshu-api-service'
import {
  XIAOHONGSHU_API_ENDPOINTS,
  XIAOHONGSHU_API_ROUTES,
  type XiaohongshuApiTransport,
  type XiaohongshuJsonResponse
} from './xiaohongshu-api'

const origin = 'https://creator.xiaohongshu.com'
const ownerId = '5605904194'
const ownerName = '测试本人账号'

describe('XiaohongshuApiService', () => {
  let database: SocialDatabase
  let plugins: PluginService
  let nowMs: number
  let jobSequence: number

  beforeEach(() => {
    database = new SocialDatabase(':memory:')
    plugins = new PluginService(database)
    plugins.initialize()
    nowMs = Date.parse('2026-07-13T08:00:00.000Z')
    jobSequence = 0
  })

  afterEach(() => database.close())

  it('upgrades an existing user-confirmed remoteId through the API', async () => {
    enablePlugin()
    const account = createAccount('profile_only')
    bindLegacyIdentity(account.id, ownerId, '旧的本地名称')
    expect(database.getAccount(account.id)).toMatchObject({
      remoteId: ownerId,
      ownershipStatus: 'user_confirmed',
      connectionStatus: 'pending'
    })

    const transport = createTransport()
    const result = await createService(() => transport).verifyIdentity(account.id)

    expect(result).toMatchObject({
      status: 'verified',
      remoteId: ownerId,
      remoteName: ownerName,
      confirmationToken: null
    })
    expect(database.getAccount(account.id)).toMatchObject({
      remoteId: ownerId,
      remoteName: ownerName,
      ownershipStatus: 'plugin_verified',
      connectionStatus: 'ready'
    })
  })

  it('requires a preview and a second matching API read before first binding', async () => {
    enablePlugin()
    const account = createAccount('profile_only')
    const transport = createTransport()
    const service = createService(() => transport, () => 'preview-token')

    const preview = await service.verifyIdentity(account.id)
    expect(preview).toMatchObject({
      status: 'confirmation_required',
      remoteId: ownerId,
      remoteName: ownerName,
      confirmationToken: 'preview-token',
      confirmationExpiresAt: '2026-07-13T08:05:00.000Z'
    })
    expect(database.getAccount(account.id)).toMatchObject({
      remoteId: null,
      ownershipStatus: 'unconfirmed'
    })

    const confirmed = await service.confirmIdentity({
      accountId: account.id,
      token: 'preview-token',
      confirmIdentity: true
    })
    expect(confirmed).toMatchObject({ status: 'verified', remoteId: ownerId })
    expect(database.getAccount(account.id)).toMatchObject({
      remoteId: ownerId,
      ownershipStatus: 'plugin_verified',
      connectionStatus: 'ready'
    })
    expect(transport.directJson).toHaveBeenCalledTimes(2)
  })

  it('marks the account expired when the profile API reports login expiry', async () => {
    enablePlugin()
    const account = createAccount('profile_only')
    const transport = createTransport({ profileStatus: 401 })

    await expect(createService(() => transport).verifyIdentity(account.id)).resolves.toMatchObject({
      status: 'login_required',
      remoteId: null
    })
    expect(database.getAccount(account.id)).toMatchObject({
      connectionStatus: 'expired',
      status: 'expired',
      syncEnabled: false
    })
  })

  it('stops a previously bound account when the API identity mismatches', async () => {
    enablePlugin()
    const account = createAccount('profile_only')
    bindLegacyIdentity(account.id, ownerId, ownerName)
    const transport = createTransport({ profiles: [['other-account', '另一个账号']] })

    await expect(createService(() => transport).verifyIdentity(account.id)).resolves.toMatchObject({
      status: 'identity_mismatch',
      remoteId: 'other-account'
    })
    expect(database.getAccount(account.id)).toMatchObject({
      remoteId: ownerId,
      connectionStatus: 'mismatch',
      status: 'mismatch',
      syncEnabled: false
    })
  })

  it('commits profile_only profile and account metrics without requesting contents', async () => {
    enablePlugin()
    const account = createSyncableAccount('profile_only')
    const transport = createTransport()

    const result = await createService(() => transport).sync(account.id)

    expect(result).toMatchObject({
      accountId: account.id,
      mode: 'profile_only',
      contentCount: 0,
      job: { status: 'succeeded', kind: 'managed_sync' }
    })
    expect(transport.captureSignedJson).not.toHaveBeenCalled()
    expect(database.listAccountSnapshots(account.id)).toHaveLength(1)
    expect(database.listContents({ accountId: account.id })).toEqual([])
    expect(database.getStorageCounts()).toMatchObject({
      accountSnapshotCount: 1,
      contentCount: 0,
      contentSnapshotCount: 0,
      jobCount: 1,
      importCount: 0
    })
    expect(database.getAccount(account.id)).toMatchObject({
      syncStatus: 'idle',
      lastSyncedAt: '2026-07-13T08:00:00.000Z'
    })
  })

  it('atomically commits recent_20 contents, snapshots and the successful job', async () => {
    enablePlugin()
    const account = createSyncableAccount('recent_20')
    const transport = createTransport({
      notes: [
        note('aaaaaaaaaaaaaaaaaaaaaaaa', '第一篇'),
        note('bbbbbbbbbbbbbbbbbbbbbbbb', '第二篇', { read_count: 88 })
      ]
    })

    const result = await createService(() => transport).sync(account.id)

    expect(result).toMatchObject({
      mode: 'recent_20',
      contentCount: 2,
      stats: { newContentCount: 2, snapshotCount: 2 },
      job: { status: 'succeeded', progress: 100 }
    })
    expect(database.listContents({ accountId: account.id }).map((item) => item.remoteId).sort())
      .toEqual(['aaaaaaaaaaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbbbbbbbbbb'])
    expect(database.getStorageCounts()).toMatchObject({
      accountSnapshotCount: 1,
      contentCount: 2,
      contentSnapshotCount: 2,
      jobCount: 1,
      importCount: 0
    })
    expect(database.listJobs()[0]).toMatchObject({ status: 'succeeded', kind: 'managed_sync' })
    expect(plugins.list().find((item) => item.manifest.id === XIAOHONGSHU_API_PLUGIN_ID))
      .toMatchObject({ successCount: 1, failureCount: 0 })
  })

  it('does not persist partial recent_20 data when identity changes during collection', async () => {
    enablePlugin()
    const account = createSyncableAccount('recent_20')
    const transport = createTransport({
      profiles: [[ownerId, ownerName], ['other-account', '另一个账号']],
      notes: [note()]
    })

    await expect(createService(() => transport).sync(account.id)).rejects.toMatchObject({
      code: 'IDENTITY_MISMATCH'
    })
    expect(database.listAccountSnapshots(account.id)).toEqual([])
    expect(database.listContents({ accountId: account.id })).toEqual([])
    expect(database.listJobs()[0]).toMatchObject({
      status: 'failed',
      errorCode: 'IDENTITY_MISMATCH'
    })
    expect(database.getAccount(account.id)).toMatchObject({
      connectionStatus: 'mismatch',
      status: 'mismatch',
      syncEnabled: false,
      syncStatus: 'idle'
    })
  })

  it('expires and pauses an account when login ends during synchronization', async () => {
    enablePlugin()
    const account = createSyncableAccount('profile_only')
    const transport = createTransport({ profileStatus: 401 })

    await expect(createService(() => transport).sync(account.id)).rejects.toMatchObject({
      code: 'AUTH_REQUIRED'
    })
    expect(database.getAccount(account.id)).toMatchObject({
      connectionStatus: 'expired',
      status: 'expired',
      syncEnabled: false,
      syncStatus: 'idle'
    })
  })

  it('rejects a disabled plugin before opening the browser transport', async () => {
    const account = createAccount('profile_only')
    const transportFactory = vi.fn(() => createTransport())

    await expect(createService(transportFactory).verifyIdentity(account.id))
      .rejects.toThrow('请先在插件中心启用')
    expect(transportFactory).not.toHaveBeenCalled()
    expect(database.getAccount(account.id)?.remoteId).toBeNull()
  })

  it('reports a missing browser workspace without writing identity data', async () => {
    enablePlugin()
    const account = createAccount('profile_only')
    const service = createService(() => {
      throw new Error('请先打开该账号的内置浏览器并完成登录')
    })

    await expect(service.verifyIdentity(account.id)).rejects.toThrow('请先打开该账号的内置浏览器')
    expect(database.getAccount(account.id)).toMatchObject({
      remoteId: null,
      ownershipStatus: 'unconfirmed'
    })
  })

  it('enforces the per-account API interval', async () => {
    enablePlugin()
    const account = createAccount('profile_only')
    const transport = createTransport()
    const service = createService(() => transport)

    await expect(service.verifyIdentity(account.id)).resolves.toMatchObject({
      status: 'confirmation_required'
    })
    await expect(service.verifyIdentity(account.id)).rejects.toThrow('60 秒后重试')
    expect(transport.directJson).toHaveBeenCalledTimes(1)
  })

  it('serializes platform syncs and rejects concurrent work on another account', async () => {
    enablePlugin()
    const first = createSyncableAccount('profile_only', '账号一')
    const second = createSyncableAccount('profile_only', '账号二', '6605904194')
    const entered = deferred<void>()
    const release = deferred<void>()
    const firstTransport = createTransport()
    const originalFirstDirect = firstTransport.directJson
    let firstProfileRead = true
    firstTransport.directJson = vi.fn(async (endpoint) => {
      if (endpoint === XIAOHONGSHU_API_ENDPOINTS.personalInfo && firstProfileRead) {
        firstProfileRead = false
        entered.resolve()
        await release.promise
      }
      return originalFirstDirect(endpoint)
    })
    const secondTransport = createTransport({ profiles: [['6605904194', '账号二']] })
    const service = createService((accountId) => accountId === first.id ? firstTransport : secondTransport)

    const running = service.sync(first.id)
    await entered.promise
    await expect(service.sync(second.id)).rejects.toThrow('已有一个同步任务正在运行')
    release.resolve()
    await expect(running).resolves.toMatchObject({ job: { status: 'succeeded' } })
    expect(database.getStorageCounts().jobCount).toBe(1)
  })

  function enablePlugin(): void {
    plugins.setEnabled(XIAOHONGSHU_API_PLUGIN_ID, true)
  }

  function createAccount(syncMode: 'profile_only' | 'recent_20' | 'recent_100') {
    return database.createAccount({ platformId: 'xiaohongshu', alias: '测试账号', syncMode })
  }

  function createSyncableAccount(
    syncMode: 'profile_only' | 'recent_20' | 'recent_100',
    remoteName = ownerName,
    remoteId = ownerId
  ) {
    const account = createAccount(syncMode)
    database.applyManagedIdentity(account.id, { remoteId, remoteName }, isoNow())
    return database.updateAccount({ id: account.id, syncEnabled: true })
  }

  function bindLegacyIdentity(accountId: string, remoteId: string, remoteName: string): void {
    database.commitImport({
      capturedAt: isoNow(),
      profile: {
        remoteId,
        remoteName,
        followers: 0,
        following: 0,
        contentCount: 0,
        viewsTotal: 0
      },
      contents: [],
      warnings: []
    }, {
      accountId,
      pluginId: 'legacy-local-import',
      fileName: 'legacy.json',
      fileHash: `legacy-${accountId}`,
      confirmOwnership: true
    })
  }

  function createService(
    transportForAccount: (accountId: string) => XiaohongshuApiTransport,
    createToken: () => string = () => 'token'
  ): XiaohongshuApiService {
    const jobs = new JobService(database, {
      clock: () => new Date(nowMs),
      createId: () => `job-${++jobSequence}`
    })
    return new XiaohongshuApiService({
      repository: database,
      browser: { createXiaohongshuApiTransport: transportForAccount },
      plugins,
      jobs,
      clock: () => new Date(nowMs),
      createToken
    })
  }

  function isoNow(): string {
    return new Date(nowMs).toISOString()
  }
})

function createTransport(options: {
  profiles?: Array<[string, string]>
  profileStatus?: number
  notes?: Array<Record<string, unknown>>
} = {}) {
  const profiles = [...(options.profiles ?? [[ownerId, ownerName] as [string, string]])]
  const notes = options.notes ?? [note()]
  const directJson = vi.fn(async (endpoint: string): Promise<XiaohongshuJsonResponse> => {
    if (endpoint === XIAOHONGSHU_API_ENDPOINTS.personalInfo) {
      const identity = profiles.length > 1 ? profiles.shift()! : profiles[0]!
      return profileResponse(identity[0], identity[1], options.profileStatus ?? 200)
    }
    if (endpoint === XIAOHONGSHU_API_ENDPOINTS.accountStats) return metricsResponse()
    throw new Error(`unexpected endpoint: ${endpoint}`)
  })
  const captureSignedJson = vi.fn(async (route: string): Promise<readonly XiaohongshuJsonResponse[]> => {
    if (route === XIAOHONGSHU_API_ROUTES.noteManager) {
      return [response(
        `${XIAOHONGSHU_API_ENDPOINTS.postedNotes}?tab=0&page=0`,
        {
          code: 0,
          success: true,
          data: {
            total: notes.length,
            has_more: false,
            notes: notes.map((item) => ({
              note_id: item.id,
              display_title: item.title,
              publish_time: item.post_time,
              type: item.type
            }))
          }
        }
      )]
    }
    return [response(
      `${XIAOHONGSHU_API_ENDPOINTS.noteAnalyzeList}?type=0&page_size=20&page_num=1`,
      { code: 0, data: { total: notes.length, note_infos: notes } }
    )]
  })
  return { directJson, captureSignedJson }
}

function response(path: string, json: unknown, status = 200): XiaohongshuJsonResponse {
  return { status, url: `${origin}${path}`, json }
}

function profileResponse(id: string, name: string, status = 200): XiaohongshuJsonResponse {
  return response(XIAOHONGSHU_API_ENDPOINTS.personalInfo, {
    code: 0,
    data: {
      user_id: id,
      name,
      fans_count: 12,
      follow_count: 119,
      faved_count: 122,
      personal_desc: '本人账号简介',
      grow_info: { level: 3 }
    }
  }, status)
}

function metricsResponse(): XiaohongshuJsonResponse {
  return response(XIAOHONGSHU_API_ENDPOINTS.accountStats, {
    code: 0,
    data: { seven: period(0), thirty: period(100) }
  })
}

function period(seed: number): Record<string, number> {
  return {
    view_count: seed + 1,
    view_time_avg: seed + 2,
    home_view_count: seed + 3,
    like_count: seed + 4,
    collect_count: seed + 5,
    comment_count: seed + 6,
    danmaku_count: seed + 7,
    share_count: seed + 8,
    rise_fans_count: seed + 9
  }
}

function note(
  id = 'aaaaaaaaaaaaaaaaaaaaaaaa',
  title = 'API 返回的测试笔记',
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id,
    title,
    post_time: Date.parse('2026-03-18T12:01:00.000Z'),
    read_count: 521,
    like_count: 18,
    fav_count: 10,
    comment_count: 7,
    share_count: 2,
    type: 1,
    ...overrides
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}
