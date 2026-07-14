import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SocialDatabase } from './database'
import { PluginService } from './plugin-service'
import { JobService } from './services/job-service'
import {
  ZhihuApiService,
  ZHIHU_API_PLUGIN_ID
} from './zhihu-api-service'
import {
  ZHIHU_API_ENDPOINTS,
  type ZhihuApiTransport,
  type ZhihuJsonResponse
} from './zhihu-api'

const origin = 'https://www.zhihu.com'
const ownerId = 'people-id-123'
const ownerHandle = 'test-owner'
const ownerName = '知乎测试本人账号'
const remoteAvatar = 'https://picx.zhimg.com/avatar-test.png'
const cachedAvatar = { cacheKey: `${'b'.repeat(64)}.png`, mime: 'image/png' as const }

describe('ZhihuApiService', () => {
  let database: SocialDatabase
  let plugins: PluginService
  let nowMs: number
  let jobSequence: number

  beforeEach(() => {
    database = new SocialDatabase(':memory:')
    plugins = new PluginService(database)
    plugins.initialize()
    nowMs = Date.parse('2026-07-13T09:00:00.000Z')
    jobSequence = 0
  })

  afterEach(() => database.close())

  it('requires a preview and a second matching API read before first binding', async () => {
    enablePlugin()
    const account = createAccount('profile_only')
    const transport = createTransport()
    const cacheAvatar = vi.fn(async () => cachedAvatar)
    const leaseHooks = { showForLogin: vi.fn(), release: vi.fn(), cacheAvatar }
    const service = createService(() => transport, () => 'zhihu-preview', leaseHooks)

    await expect(service.verifyIdentity(account.id)).resolves.toMatchObject({
      status: 'confirmation_required',
      remoteId: ownerId,
      remoteName: ownerName,
      confirmationToken: 'zhihu-preview',
      confirmationExpiresAt: '2026-07-13T09:05:00.000Z'
    })
    expect(database.getAccount(account.id)).toMatchObject({
      remoteId: null,
      ownershipStatus: 'unconfirmed'
    })
    expect(cacheAvatar).not.toHaveBeenCalled()

    await expect(service.confirmIdentity({
      accountId: account.id,
      token: 'zhihu-preview',
      confirmIdentity: true
    })).resolves.toMatchObject({ status: 'verified', remoteId: ownerId })

    expect(database.getAccount(account.id)).toMatchObject({
      remoteId: ownerId,
      remoteName: ownerName,
      ownershipStatus: 'plugin_verified',
      connectionStatus: 'ready',
      avatarUrl: `app://shell/media/avatars/${account.id}/${cachedAvatar.cacheKey}`,
      bio: '知乎测试账号简介'
    })
    expect(transport.getJson).toHaveBeenCalledTimes(4)
    expect(cacheAvatar).toHaveBeenCalledWith(account.id, remoteAvatar)
    expect(leaseHooks.release).toHaveBeenCalledTimes(2)
  })

  it('commits profile_only metrics without requesting content lists', async () => {
    enablePlugin()
    const account = createSyncableAccount('profile_only')
    const transport = createTransport()

    const result = await createService(() => transport).sync(account.id)

    expect(result).toMatchObject({
      accountId: account.id,
      mode: 'profile_only',
      contentCount: 0,
      profile: {
        followers: 12,
        following: 119,
        contentCount: 8,
        likes: 124,
        favorites: 23,
        likesAndFavorites: 147,
        thanks: 31
      },
      job: { status: 'succeeded', kind: 'managed_sync' },
      message: '已同步账号资料和账号指标。'
    })
    expect(transport.getJson.mock.calls.map(([endpoint]) => endpoint))
      .toEqual([
        ZHIHU_API_ENDPOINTS.identity,
        ZHIHU_API_ENDPOINTS.profile(ownerHandle),
        ZHIHU_API_ENDPOINTS.identity
      ])
    expect(database.listContents({ accountId: account.id })).toEqual([])
    expect(database.listAccountSnapshots(account.id)).toEqual([
      expect.objectContaining({
        followers: 12,
        following: 119,
        contentCount: 8,
        viewsTotal: null,
        likes: 124,
        favorites: 23,
        likesAndFavoritesTotal: 147
      })
    ])
  })

  it('does not fabricate a combined total when either source metric is missing', async () => {
    enablePlugin()
    const account = createSyncableAccount('profile_only')
    const transport = createTransport({ profileOverrides: { favorited_count: undefined } })

    const result = await createService(() => transport).sync(account.id)

    expect(result.profile).toMatchObject({
      likes: 124,
      favorites: null,
      likesAndFavorites: null
    })
    expect(database.listAccountSnapshots(account.id)).toEqual([
      expect.objectContaining({
        likes: 124,
        favorites: null,
        likesAndFavoritesTotal: null
      })
    ])
  })

  it('atomically commits creator-center answers and articles with owner-only metrics', async () => {
    enablePlugin()
    const account = createSyncableAccount('recent_20')
    const transport = createTransport({
      creatorRows: [{
        type: 'answer',
        data: {
          id: '9001',
          question_id: '8001',
          title: '回答对应的问题',
          excerpt: '回答摘要',
          created_time: 1_782_000_000,
          updated_time: 1_782_000_100
        },
        reaction: {
          read_count: 10,
          vote_up_count: 18,
          comment_count: 3,
          collect_count: 4
        }
      }, {
        type: 'article',
        data: {
          id: '7001',
          title: '测试文章',
          excerpt: '文章摘要',
          created_time: 1_781_000_000,
          updated_time: 1_781_000_100
        },
        reaction: {
          read_count: 27,
          vote_up_count: 11,
          comment_count: 2,
          collect_count: 6
        }
      }]
    })

    const result = await createService(() => transport).sync(account.id)

    expect(result).toMatchObject({
      mode: 'recent_20',
      contentCount: 2,
      stats: { newContentCount: 2, snapshotCount: 2 },
      job: { status: 'succeeded', progress: 100 },
      message: '已同步账号资料和 2 条可见内容；平台资料统计为 8 条，列表接口本次返回 2 条可见内容。'
    })
    const contents = database.listContents({ accountId: account.id, limit: 20 })
    expect(contents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        remoteId: 'answer:8001:9001',
        type: 'answer',
        url: 'https://www.zhihu.com/question/8001/answer/9001',
        bodyExcerpt: '回答摘要',
        latestSnapshot: expect.objectContaining({ views: 10, likes: 18, comments: 3, favorites: 4 })
      }),
      expect.objectContaining({
        remoteId: 'article:7001',
        type: 'article',
        url: 'https://zhuanlan.zhihu.com/p/7001',
        latestSnapshot: expect.objectContaining({ views: 27, likes: 11, comments: 2, favorites: 6 })
      })
    ]))
    expect(transport.getJson.mock.calls.map(([endpoint]) => endpoint)).toEqual([
      ZHIHU_API_ENDPOINTS.identity,
      ZHIHU_API_ENDPOINTS.profile(ownerHandle),
      ZHIHU_API_ENDPOINTS.creatorContents(),
      ZHIHU_API_ENDPOINTS.identity
    ])
    expect(database.getStorageCounts()).toMatchObject({
      accountSnapshotCount: 1,
      contentCount: 2,
      contentSnapshotCount: 2,
      jobCount: 1
    })
  })

  it('marks login expiry and opens the account workspace before releasing it', async () => {
    enablePlugin()
    const account = createAccount('profile_only')
    const transport = createTransport({ identityStatus: 401 })
    const leaseHooks = { showForLogin: vi.fn(), release: vi.fn() }

    await expect(createService(() => transport, () => 'token', leaseHooks).verifyIdentity(account.id))
      .resolves.toMatchObject({ status: 'login_required', remoteId: null })
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

  it('moves a rate-limited sync into cooldown without committing partial data', async () => {
    enablePlugin()
    const account = createSyncableAccount('recent_20')
    const transport = createTransport({ listStatus: 429 })

    await expect(createService(() => transport).sync(account.id)).rejects.toMatchObject({
      code: 'RATE_LIMITED'
    })
    expect(database.getAccount(account.id)).toMatchObject({
      status: 'cooldown',
      syncStatus: 'cooldown',
      syncEnabled: false,
      cooldownUntil: '2026-07-13T09:30:00.000Z'
    })
    expect(database.listAccountSnapshots(account.id)).toEqual([])
    expect(database.listContents({ accountId: account.id })).toEqual([])
    expect(database.listJobs()[0]).toMatchObject({ status: 'failed', errorCode: 'RATE_LIMITED' })
  })

  it('fails clearly when the owner creator-content endpoint is unavailable instead of using public lists', async () => {
    enablePlugin()
    const account = createSyncableAccount('recent_20')
    const transport = createTransport({ listStatus: 404 })

    await expect(createService(() => transport).sync(account.id)).rejects.toMatchObject({
      code: 'NOT_FOUND'
    })
    expect(transport.getJson.mock.calls.map(([endpoint]) => endpoint)).toEqual([
      ZHIHU_API_ENDPOINTS.identity,
      ZHIHU_API_ENDPOINTS.profile(ownerHandle),
      ZHIHU_API_ENDPOINTS.creatorContents()
    ])
    expect(database.getAccount(account.id)).toMatchObject({
      connectionStatus: 'ready',
      syncStatus: 'failed',
      syncEnabled: true
    })
    expect(database.listAccountSnapshots(account.id)).toEqual([])
    expect(database.listContents({ accountId: account.id })).toEqual([])
    expect(database.listJobs()[0]).toMatchObject({ status: 'failed', errorCode: 'NOT_FOUND' })
  })

  it('rejects all collected rows when the logged-in identity changes before commit', async () => {
    enablePlugin()
    const account = createSyncableAccount('recent_20')
    const transport = createTransport({
      identities: [
        { id: ownerId, handle: ownerHandle, name: ownerName },
        { id: 'other-person-id', handle: 'other-person', name: '另一个知乎账号' }
      ],
      creatorRows: [{
        type: 'answer',
        data: {
          id: '9001',
          question_id: '8001',
          title: '不应写入的问题',
          excerpt: '不应写入的回答',
          created_time: 1_782_000_000
        },
        reaction: { read_count: 10, vote_up_count: 18, comment_count: 3, collect_count: 4 }
      }]
    })

    await expect(createService(() => transport).sync(account.id)).rejects.toMatchObject({
      code: 'IDENTITY_MISMATCH'
    })
    expect(database.getAccount(account.id)).toMatchObject({
      status: 'mismatch',
      connectionStatus: 'mismatch',
      syncEnabled: false
    })
    expect(database.listAccountSnapshots(account.id)).toEqual([])
    expect(database.listContents({ accountId: account.id })).toEqual([])
    expect(database.listJobs()[0]).toMatchObject({ status: 'failed', errorCode: 'IDENTITY_MISMATCH' })
  })

  function enablePlugin(): void {
    plugins.setEnabled(ZHIHU_API_PLUGIN_ID, true)
  }

  function createAccount(syncMode: 'profile_only' | 'recent_20' | 'recent_100') {
    return database.createAccount({ platformId: 'zhihu', alias: '知乎测试账号', syncMode })
  }

  function createSyncableAccount(syncMode: 'profile_only' | 'recent_20' | 'recent_100') {
    const account = createAccount(syncMode)
    database.applyManagedIdentity(account.id, { remoteId: ownerId, remoteName: ownerName }, isoNow())
    return database.updateAccount({ id: account.id, syncEnabled: true })
  }

  function createService(
    transportForAccount: (accountId: string) => ZhihuApiTransport,
    createToken: () => string = () => 'token',
    leaseHooks: {
      showForLogin: () => void
      release: () => void
      cacheAvatar?: (accountId: string, sourceUrl: string) => Promise<typeof cachedAvatar | null>
      pruneAvatar?: (accountId: string, keepCacheKey: string) => Promise<void>
    } = { showForLogin: vi.fn(), release: vi.fn() }
  ): ZhihuApiService {
    const jobs = new JobService(database, {
      clock: () => new Date(nowMs),
      createId: () => `zhihu-job-${++jobSequence}`
    })
    return new ZhihuApiService({
      repository: database,
      browser: {
        acquireZhihuApiTransport: async (accountId) => ({
          transport: transportForAccount(accountId),
          showForLogin: leaseHooks.showForLogin,
          release: leaseHooks.release
        }),
        cacheZhihuAvatar: leaseHooks.cacheAvatar ?? (async () => null),
        pruneAccountAvatarMedia: leaseHooks.pruneAvatar ?? (async () => undefined)
      },
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
  identityStatus?: number
  listStatus?: number
  identities?: Array<{ id: string; handle: string; name: string }>
  profileOverrides?: Record<string, unknown>
  creatorRows?: Array<Record<string, unknown>>
} = {}) {
  const identities = options.identities ?? [{ id: ownerId, handle: ownerHandle, name: ownerName }]
  let identityIndex = 0
  const getJson = vi.fn(async (endpoint: string): Promise<ZhihuJsonResponse> => {
    if (endpoint === ZHIHU_API_ENDPOINTS.identity) {
      const identity = identities[Math.min(identityIndex, identities.length - 1)]!
      identityIndex += 1
      return response(endpoint, {
        id: identity.id,
        url_token: identity.handle,
        name: identity.name
      }, options.identityStatus ?? 200)
    }
    if (endpoint === ZHIHU_API_ENDPOINTS.profile(ownerHandle)) {
      return response(endpoint, profile(options.profileOverrides))
    }
    if (endpoint === ZHIHU_API_ENDPOINTS.creatorContents()) {
      return response(endpoint, list(options.creatorRows ?? []), options.listStatus ?? 200)
    }
    throw new Error(`unexpected endpoint: ${endpoint}`)
  })
  return { getJson }
}

function response(endpoint: string, json: unknown, status = 200): ZhihuJsonResponse {
  return { status, url: `${origin}${endpoint}`, json }
}

function list(data: Array<Record<string, unknown>>): Record<string, unknown> {
  return {
    data,
    paging: {
      is_end: true,
      next: null,
      totals: data.length,
      totals_real: data.length
    }
  }
}

function profile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ownerId,
    url_token: ownerHandle,
    name: ownerName,
    avatar_url: remoteAvatar,
    headline: '知乎测试账号简介',
    follower_count: 12,
    following_count: 119,
    answer_count: 3,
    articles_count: 2,
    pins_count: 3,
    question_count: 1,
    voteup_count: 124,
    thanked_count: 31,
    favorited_count: 23,
    ...overrides
  }
}
