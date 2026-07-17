import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SocialDatabase } from './database'
import { TestSessionApiPluginGate } from './plugins/session-api-plugin-gate.test-fixture'
import { JobService } from './services/job-service'
import { setErrorReporter } from './error-reporting'
import {
  XiaohongshuApiService,
  XIAOHONGSHU_API_PLUGIN_ID,
  XIAOHONGSHU_CONTENT_METRIC_DEFINITIONS
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
const remoteAvatar = 'https://sns-avatar-qc.xhscdn.com/avatar/test.png'
const cachedAvatar = { cacheKey: `${'a'.repeat(64)}.png`, mime: 'image/png' as const }

describe('XiaohongshuApiService', () => {
  let database: SocialDatabase
  let plugins: TestSessionApiPluginGate
  let nowMs: number
  let jobSequence: number

  beforeEach(() => {
    database = new SocialDatabase(':memory:')
    plugins = new TestSessionApiPluginGate(database, XIAOHONGSHU_API_PLUGIN_ID)
    nowMs = Date.parse('2026-07-13T08:00:00.000Z')
    jobSequence = 0
  })

  afterEach(() => {
    setErrorReporter(null)
    database.close()
  })

  it('declares cumulative, gauge and cross-platform semantics for every content metric', () => {
    expect(XIAOHONGSHU_CONTENT_METRIC_DEFINITIONS.every((definition) => (
      definition.measurementKind !== undefined &&
      Object.prototype.hasOwnProperty.call(definition, 'standardMetricId')
    ))).toBe(true)
    expect(XIAOHONGSHU_CONTENT_METRIC_DEFINITIONS
      .filter(({ measurementKind }) => measurementKind === 'cumulative')
      .map(({ id }) => id)).toEqual([
        'impressions', 'views', 'likes', 'comments', 'favorites',
        'followers_gained', 'shares', 'danmaku'
      ])
    expect(XIAOHONGSHU_CONTENT_METRIC_DEFINITIONS
      .filter(({ measurementKind }) => measurementKind === 'gauge')
      .map(({ id }) => id)).toEqual(['cover_click_rate', 'average_view_duration'])
    expect(XIAOHONGSHU_CONTENT_METRIC_DEFINITIONS
      .filter(({ standardMetricId }) => standardMetricId !== null)
      .map(({ id, standardMetricId }) => [id, standardMetricId])).toEqual([
        ['views', 'views'],
        ['likes', 'likes'],
        ['comments', 'comments'],
        ['favorites', 'favorites'],
        ['shares', 'shares']
      ])
  })

  it('revalidates an existing remoteId through the API', async () => {
    enablePlugin()
    const account = createAccount('profile_only')
    database.applyManagedIdentity(account.id, {
      remoteId: ownerId, remoteName: '旧的本地名称'
    }, isoNow())
    expect(database.getAccount(account.id)).toMatchObject({
      remoteId: ownerId,
      ownershipStatus: 'plugin_verified',
      connectionStatus: 'ready'
    })

    const transport = createTransport()
    const cacheAvatar = vi.fn(async () => cachedAvatar)
    const pruneAvatar = vi.fn(async () => undefined)
    const leaseHooks = { showForLogin: vi.fn(), release: vi.fn(), cacheAvatar, pruneAvatar }
    const result = await createService(() => transport, () => 'token', leaseHooks).verifyIdentity(account.id)

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
      connectionStatus: 'ready',
      avatarUrl: `app://shell/media/avatars/${account.id}/${cachedAvatar.cacheKey}`,
      bio: '本人账号简介',
      creatorLevel: 3
    })
    expect(cacheAvatar).toHaveBeenCalledWith(account.id, remoteAvatar)
    expect(pruneAvatar).toHaveBeenCalledWith(account.id, cachedAvatar.cacheKey)
    expect(leaseHooks.showForLogin).not.toHaveBeenCalled()
    expect(leaseHooks.release).toHaveBeenCalledOnce()
  })

  it('requires a preview and a second matching API read before first binding', async () => {
    enablePlugin()
    const account = createAccount('profile_only')
    const transport = createTransport()
    const cacheAvatar = vi.fn(async () => cachedAvatar)
    const leaseHooks = { showForLogin: vi.fn(), release: vi.fn(), cacheAvatar }
    const service = createService(() => transport, () => 'preview-token', leaseHooks)

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
    expect(cacheAvatar).not.toHaveBeenCalled()

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
    expect(transport.directJson).toHaveBeenCalledTimes(4)
    expect(cacheAvatar).toHaveBeenCalledOnce()
    expect(leaseHooks.release).toHaveBeenCalledTimes(2)
  })

  it('marks the account expired when the profile API reports login expiry', async () => {
    enablePlugin()
    const account = createAccount('profile_only')
    const transport = createTransport({ profileStatus: 401 })
    const leaseHooks = { showForLogin: vi.fn(), release: vi.fn() }

    await expect(createService(() => transport, () => 'token', leaseHooks).verifyIdentity(account.id)).resolves.toMatchObject({
      status: 'login_required',
      remoteId: null
    })
    expect(database.getAccount(account.id)).toMatchObject({
      connectionStatus: 'expired',
      status: 'expired',
      syncEnabled: false
    })
    expect(leaseHooks.showForLogin).toHaveBeenCalledOnce()
    expect(leaseHooks.release).toHaveBeenCalledOnce()
    expect(leaseHooks.showForLogin.mock.invocationCallOrder[0])
      .toBeLessThan(leaseHooks.release.mock.invocationCallOrder[0]!)
  })

  it('stops a previously bound account when the API identity mismatches', async () => {
    enablePlugin()
    const account = createAccount('profile_only')
    database.applyManagedIdentity(account.id, { remoteId: ownerId, remoteName: ownerName }, isoNow())
    const transport = createTransport({ profiles: [['other-account', '另一个账号']] })
    const cacheAvatar = vi.fn(async () => cachedAvatar)
    const leaseHooks = { showForLogin: vi.fn(), release: vi.fn(), cacheAvatar }

    await expect(createService(() => transport, () => 'token', leaseHooks).verifyIdentity(account.id)).resolves.toMatchObject({
      status: 'identity_mismatch',
      remoteId: 'other-account'
    })
    expect(database.getAccount(account.id)).toMatchObject({
      remoteId: ownerId,
      connectionStatus: 'mismatch',
      status: 'mismatch',
      syncEnabled: false
    })
    expect(leaseHooks.showForLogin).not.toHaveBeenCalled()
    expect(leaseHooks.release).toHaveBeenCalledOnce()
    expect(cacheAvatar).not.toHaveBeenCalled()
  })

  it('commits profile_only profile and account metrics without requesting contents', async () => {
    enablePlugin()
    const account = createSyncableAccount('profile_only')
    const transport = createTransport()
    const cacheAvatar = vi.fn(async () => { throw new Error('CDN 暂时不可用') })

    const result = await createService(
      () => transport,
      () => 'token',
      { showForLogin: vi.fn(), release: vi.fn(), cacheAvatar }
    ).sync(account.id)

    expect(result).toMatchObject({
      accountId: account.id,
      mode: 'profile_only',
      contentCount: 0,
      profile: { avatarAvailable: true, bio: '本人账号简介', creatorLevel: 3 },
      job: { status: 'succeeded', kind: 'managed_sync' }
    })
    expect(result.profile).not.toHaveProperty('avatarUrl')
    expect(cacheAvatar).toHaveBeenCalledWith(account.id, remoteAvatar)
    expect(transport.captureSignedJson).not.toHaveBeenCalled()
    expect(database.listAccountSnapshots(account.id)).toHaveLength(1)
    expect(database.listContents({ accountId: account.id })).toEqual([])
    expect(database.getStorageCounts()).toMatchObject({
      accountSnapshotCount: 1,
      contentCount: 0,
      contentSnapshotCount: 0,
      jobCount: 1
    })
    expect(database.getAccount(account.id)).toMatchObject({
      syncStatus: 'idle',
      lastSyncedAt: '2026-07-13T08:00:00.000Z',
      bio: '本人账号简介',
      creatorLevel: 3
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
    expect(result.message).toBe('已同步账号资料和 2 条作品。其中 2 条包含正文摘要。')
    expect(database.listContents({ accountId: account.id }).map((item) => item.remoteId).sort())
      .toEqual(['aaaaaaaaaaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbbbbbbbbbb'])
    expect(database.listContents({ accountId: account.id }).map((item) => item.bodyExcerpt).sort())
      .toEqual(['正文：第一篇', '正文：第二篇'])
    const firstContent = database.listContents({ accountId: account.id })
      .find((item) => item.remoteId === 'aaaaaaaaaaaaaaaaaaaaaaaa')!
    expect(database.getContentDetail(firstContent.id)).toMatchObject({
      metricDefinitions: XIAOHONGSHU_CONTENT_METRIC_DEFINITIONS,
      latestSnapshot: {
        metrics: {
          impressions: 2_888,
          cover_click_rate: 0.174,
          followers_gained: 3,
          average_view_duration: 16,
          danmaku: 0
        }
      }
    })
    expect(database.getStorageCounts()).toMatchObject({
      accountSnapshotCount: 1,
      contentCount: 2,
      contentSnapshotCount: 2,
      jobCount: 1
    })
    expect(database.listJobs()[0]).toMatchObject({ status: 'succeeded', kind: 'managed_sync' })
    expect(database.getPluginState(XIAOHONGSHU_API_PLUGIN_ID))
      .toMatchObject({ successCount: 1, failureCount: 0 })
  })

  it('rejects an incomplete analyze capture without committing any partial metrics', async () => {
    enablePlugin()
    const account = createSyncableAccount('recent_20')
    const transport = createTransport({ analyzeTotal: 2, notes: [note()] })
    const reporter = vi.fn()
    setErrorReporter(reporter)

    await expect(createService(() => transport).sync(account.id)).rejects.toMatchObject({
      code: 'INCOMPLETE_CAPTURE'
    })

    expect(database.listContents({ accountId: account.id })).toEqual([])
    expect(database.listAccountSnapshots(account.id)).toEqual([])
    expect(database.listJobs()[0]).toMatchObject({ status: 'failed', errorCode: 'INCOMPLETE_CAPTURE' })
    expect(reporter).toHaveBeenCalledOnce()
    expect(reporter.mock.calls[0]?.[0]).toMatchObject({ code: 'INCOMPLETE_CAPTURE' })
    expect(reporter.mock.calls[0]?.[1]).toMatchObject({
      scope: 'sync',
      context: { accountId: account.id, pluginId: XIAOHONGSHU_API_PLUGIN_ID }
    })
  })

  it('does not request an existing excerpt again and preserves it on later syncs', async () => {
    enablePlugin()
    const account = createSyncableAccount('recent_20')
    const transport = createTransport({ notes: [note()] })
    const service = createService(() => transport)

    await service.sync(account.id)
    const firstDetailCalls = transport.captureSignedJson.mock.calls.filter((call) => call[1] === 'note_detail')
    expect(firstDetailCalls).toHaveLength(1)
    expect(database.listContents({ accountId: account.id })[0]?.bodyExcerpt).toBe('正文：API 返回的测试笔记')

    nowMs += 61_000
    await service.sync(account.id)
    const allDetailCalls = transport.captureSignedJson.mock.calls.filter((call) => call[1] === 'note_detail')
    expect(allDetailCalls).toHaveLength(1)
    expect(database.listContents({ accountId: account.id })[0]?.bodyExcerpt).toBe('正文：API 返回的测试笔记')
  })

  it('commits core data with a warning when optional detail enrichment fails', async () => {
    enablePlugin()
    const account = createSyncableAccount('recent_20')
    const transport = createTransport({ detailFailure: new Error('temporary detail failure') })

    const result = await createService(() => transport).sync(account.id)

    expect(result).toMatchObject({ contentCount: 1, job: { status: 'succeeded' } })
    expect(result.message).toContain('后续同步')
    expect(result.message).toContain('1 条摘要')
    expect(result.job.result?.warnings).toEqual(['部分作品摘要暂未补齐，将在后续同步中继续处理。'])
    expect(database.listContents({ accountId: account.id })[0]?.bodyExcerpt).toBe('')
  })

  it('reports official empty descriptions accurately instead of calling them deferred', async () => {
    enablePlugin()
    const account = createSyncableAccount('recent_20')
    const firstId = 'aaaaaaaaaaaaaaaaaaaaaaaa'
    const secondId = 'bbbbbbbbbbbbbbbbbbbbbbbb'
    const transport = createTransport({
      notes: [note(firstId, '第一篇'), note(secondId, '第二篇')],
      descriptions: { [firstId]: '', [secondId]: '第二篇正文' }
    })

    const result = await createService(() => transport).sync(account.id)

    expect(result.message).toBe(
      '已同步账号资料和 2 条作品。其中 1 条包含正文摘要。1 条作品的平台详情未提供摘要。'
    )
    expect(result.message).not.toContain('后续同步')
    expect(result.job.result?.warnings).toEqual([])
    expect(database.listContents({ accountId: account.id }).map((item) => item.bodyExcerpt).sort())
      .toEqual(['', '第二篇正文'])
  })

  it('stops immediately and places the account in cooldown on detail risk control', async () => {
    enablePlugin()
    const account = createSyncableAccount('recent_20')
    const transport = createTransport({
      notes: [note(), note('bbbbbbbbbbbbbbbbbbbbbbbb', '第二篇')],
      detailStatus: 429
    })

    await expect(createService(() => transport).sync(account.id)).rejects.toMatchObject({
      code: 'RISK_CONTROL'
    })

    expect(transport.captureSignedJson.mock.calls.filter((call) => call[1] === 'note_detail')).toHaveLength(1)
    expect(database.listContents({ accountId: account.id })).toEqual([])
    expect(database.getAccount(account.id)).toMatchObject({ syncStatus: 'cooldown' })
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
    const leaseHooks = { showForLogin: vi.fn(), release: vi.fn() }

    await expect(createService(() => transport, () => 'token', leaseHooks).sync(account.id)).rejects.toMatchObject({
      code: 'AUTH_REQUIRED'
    })
    expect(database.getAccount(account.id)).toMatchObject({
      connectionStatus: 'expired',
      status: 'expired',
      syncEnabled: false,
      syncStatus: 'idle'
    })
    expect(leaseHooks.showForLogin).toHaveBeenCalledOnce()
    expect(leaseHooks.release).toHaveBeenCalledOnce()
  })

  it('rejects a disabled plugin before opening the browser transport', async () => {
    const account = createAccount('profile_only')
    const transportFactory = vi.fn(() => createTransport())

    await expect(createService(transportFactory).verifyIdentity(account.id))
      .rejects.toThrow('请先在插件中心启用')
    expect(transportFactory).not.toHaveBeenCalled()
    expect(database.getAccount(account.id)?.remoteId).toBeNull()
  })

  it('reports a background workspace startup failure without writing identity data', async () => {
    enablePlugin()
    const account = createAccount('profile_only')
    const service = createService(() => {
      throw new Error('账号浏览器工作区启动失败')
    })

    await expect(service.verifyIdentity(account.id)).rejects.toThrow('账号浏览器工作区启动失败')
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
    expect(transport.directJson).toHaveBeenCalledTimes(2)
  })

  it('uses the persisted plugin interval for manual collection', async () => {
    enablePlugin()
    plugins.configureManualCollectionInterval(10)
    const account = createSyncableAccount('profile_only')
    const service = createService(() => createTransport())

    await expect(service.sync(account.id)).resolves.toMatchObject({ job: { status: 'succeeded' } })
    nowMs += 9 * 60_000
    await expect(service.sync(account.id)).rejects.toThrow('60 秒后重试')
    nowMs += 61_000
    await expect(service.sync(account.id)).resolves.toMatchObject({ job: { status: 'succeeded' } })
    expect(database.listJobs()).toHaveLength(2)
  })

  it('keeps scheduled collection independent from the manual interval', async () => {
    enablePlugin()
    plugins.configureManualCollectionInterval(10)
    const account = createSyncableAccount('profile_only')
    const service = createService(() => createTransport())

    await expect(service.sync(account.id, 'schedule')).resolves.toMatchObject({ job: { status: 'succeeded' } })
    await expect(service.sync(account.id, 'schedule')).resolves.toMatchObject({ job: { status: 'succeeded' } })
    await expect(service.sync(account.id, 'manual')).resolves.toMatchObject({ job: { status: 'succeeded' } })
    await expect(service.sync(account.id, 'manual')).rejects.toThrow('600 秒后重试')
    expect(database.listJobs()).toHaveLength(3)
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
    expect(service.isAccountActive(first.id)).toBe(true)
    await expect(service.sync(second.id)).rejects.toThrow('已有一个同步任务正在运行')
    release.resolve()
    await expect(running).resolves.toMatchObject({ job: { status: 'succeeded' } })
    expect(service.isAccountActive(first.id)).toBe(false)
    expect(database.getStorageCounts().jobCount).toBe(1)
  })

  function enablePlugin(): void {
    plugins.enable()
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

  function createService(
    transportForAccount: (accountId: string) => XiaohongshuApiTransport,
    createToken: () => string = () => 'token',
    leaseHooks: {
      showForLogin: () => void
      release: () => void
      cacheAvatar?: (accountId: string, sourceUrl: string) => Promise<typeof cachedAvatar | null>
      pruneAvatar?: (accountId: string, keepCacheKey: string) => Promise<void>
    } = { showForLogin: vi.fn(), release: vi.fn() }
  ): XiaohongshuApiService {
    const jobs = new JobService(database, {
      clock: () => new Date(nowMs),
      createId: () => `job-${++jobSequence}`
    })
    return new XiaohongshuApiService({
      repository: database,
      browser: {
        acquireXiaohongshuApiTransport: async (accountId) => ({
          transport: transportForAccount(accountId),
          showForLogin: leaseHooks.showForLogin,
          release: leaseHooks.release
        }),
        cacheXiaohongshuAvatar: leaseHooks.cacheAvatar ?? (async () => null),
        pruneAccountAvatarMedia: leaseHooks.pruneAvatar ?? (async () => undefined)
      },
      plugins,
      jobs,
      clock: () => new Date(nowMs),
      createToken,
      detailWait: async () => undefined
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
  descriptions?: Record<string, string>
  detailFailure?: Error
  detailStatus?: number
  analyzeTotal?: number
} = {}) {
  const profiles = [...(options.profiles ?? [[ownerId, ownerName] as [string, string]])]
  let currentIdentity = profiles[0]!
  const notes = options.notes ?? [note()]
  const directJson = vi.fn(async (endpoint: string): Promise<XiaohongshuJsonResponse> => {
    if (endpoint === XIAOHONGSHU_API_ENDPOINTS.personalInfo) {
      currentIdentity = profiles.length > 1 ? profiles.shift()! : profiles[0]!
      return profileResponse(currentIdentity[0], currentIdentity[1], options.profileStatus ?? 200)
    }
    if (endpoint === XIAOHONGSHU_API_ENDPOINTS.userInfo) {
      return userInfoResponse(currentIdentity[0], currentIdentity[1])
    }
    if (endpoint === XIAOHONGSHU_API_ENDPOINTS.accountStats) return metricsResponse()
    throw new Error(`unexpected endpoint: ${endpoint}`)
  })
  const captureSignedJson = vi.fn(async (
    route: string,
    kind: string
  ): Promise<readonly XiaohongshuJsonResponse[]> => {
    if (kind === 'posted_notes') {
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
              type: item.type,
              xsec_token: `signed_${String(item.id)}`,
              xsec_source: 'pc_creatormng'
            }))
          }
        }
      )]
    }
    if (kind === 'note_analyze_list') return [response(
      `${XIAOHONGSHU_API_ENDPOINTS.noteAnalyzeList}?type=0&page_size=20&page_num=1`,
      { code: 0, data: { total: options.analyzeTotal ?? notes.length, note_infos: notes } }
    )]
    if (options.detailFailure) throw options.detailFailure
    const id = new URL(route).searchParams.get('id')!
    const source = notes.find((item) => item.id === id)
    const detailUrl = new URL(XIAOHONGSHU_API_ENDPOINTS.noteDetail, 'https://edith.xiaohongshu.com')
    detailUrl.searchParams.set('edit_mode', '1')
    detailUrl.searchParams.set('note_id', id)
    detailUrl.searchParams.set('source', 'pc_creatormng')
    return [{
      status: options.detailStatus ?? 200,
      url: detailUrl.toString(),
      json: {
        code: 0,
        success: true,
        data: {
          id,
          desc: options.descriptions?.[id] ?? `正文：${String(source?.title ?? '')}`
        }
      }
    }]
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

function userInfoResponse(id: string, name: string): XiaohongshuJsonResponse {
  return response(XIAOHONGSHU_API_ENDPOINTS.userInfo, {
    code: 0,
    data: {
      redId: id,
      userName: name,
      userAvatar: remoteAvatar,
      userDesc: '本人账号简介'
    }
  })
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
    imp_count: 2_888,
    read_count: 521,
    coverClickRate: 0.174,
    like_count: 18,
    fav_count: 10,
    comment_count: 7,
    increase_fans_count: 3,
    share_count: 2,
    view_time_avg: 16,
    danmaku_count: 0,
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
