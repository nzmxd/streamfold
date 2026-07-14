import { describe, expect, it, vi } from 'vitest'
import type { Account, PlatformId } from '../shared/contracts'
import type {
  ConfirmSessionApiIdentityInput,
  SessionApiIdentityCheckResult,
  SessionApiSyncResult
} from '../shared/session-api-contracts'
import {
  PlatformSyncService,
  type PlatformSyncAccountRepository,
  type SessionApiPlatformService
} from './platform-sync-service'

describe('PlatformSyncService', () => {
  it('routes identity verification, confirmation and sync by account platform', async () => {
    const repository = createRepository([
      { id: 'xhs-account', platformId: 'xiaohongshu' },
      { id: 'zhihu-account', platformId: 'zhihu' }
    ])
    const xiaohongshu = createAdapter('小红书')
    const zhihu = createAdapter('知乎')
    const service = new PlatformSyncService({
      repository,
      adapters: { xiaohongshu, zhihu }
    })

    await expect(service.verifyIdentity('zhihu-account')).resolves.toMatchObject({
      accountId: 'zhihu-account',
      remoteName: '知乎'
    })
    const confirmation = {
      accountId: 'xhs-account',
      token: 'preview-token',
      confirmIdentity: true
    }
    await expect(service.confirmIdentity(confirmation)).resolves.toMatchObject({
      accountId: 'xhs-account',
      remoteName: '小红书'
    })
    await expect(service.sync('zhihu-account')).resolves.toMatchObject({
      accountId: 'zhihu-account',
      profile: { remoteName: '知乎' }
    })

    expect(zhihu.verifyIdentity).toHaveBeenCalledWith('zhihu-account')
    expect(xiaohongshu.confirmIdentity).toHaveBeenCalledWith(confirmation)
    expect(zhihu.sync).toHaveBeenCalledWith('zhihu-account')
    expect(xiaohongshu.verifyIdentity).not.toHaveBeenCalled()
    expect(xiaohongshu.sync).not.toHaveBeenCalled()
  })

  it('reports missing accounts and platforms without an adapter', async () => {
    const repository = createRepository([{ id: 'weibo-account', platformId: 'weibo' }])
    const service = new PlatformSyncService({ repository, adapters: {} })

    await expect(service.verifyIdentity('missing')).rejects.toThrow('账号不存在')
    await expect(service.sync('weibo-account')).rejects.toThrow('该平台的数据同步功能尚未开放')
    expect(service.isAccountActive('missing')).toBe(false)
    expect(service.isAccountActive('weibo-account')).toBe(false)
  })

  it('delegates active state only to the matching platform adapter', () => {
    const repository = createRepository([
      { id: 'xhs-account', platformId: 'xiaohongshu' },
      { id: 'zhihu-account', platformId: 'zhihu' }
    ])
    const xiaohongshu = createAdapter('小红书', false)
    const zhihu = createAdapter('知乎', true)
    const service = new PlatformSyncService({
      repository,
      adapters: { xiaohongshu, zhihu }
    })

    expect(service.isAccountActive('xhs-account')).toBe(false)
    expect(service.isAccountActive('zhihu-account')).toBe(true)
    expect(xiaohongshu.isAccountActive).toHaveBeenCalledOnce()
    expect(zhihu.isAccountActive).toHaveBeenCalledOnce()
  })

  it('invalidates every distinct adapter exactly once', () => {
    const repository = createRepository([])
    const shared = createAdapter('共享适配器')
    const zhihu = createAdapter('知乎')
    const service = new PlatformSyncService({
      repository,
      adapters: { xiaohongshu: shared, weibo: shared, zhihu }
    })

    service.invalidatePreviews()

    expect(shared.invalidatePreviews).toHaveBeenCalledOnce()
    expect(zhihu.invalidatePreviews).toHaveBeenCalledOnce()
  })

  it('preserves adapter errors for the caller', async () => {
    const repository = createRepository([{ id: 'zhihu-account', platformId: 'zhihu' }])
    const zhihu = createAdapter('知乎')
    vi.mocked(zhihu.sync).mockRejectedValueOnce(new Error('同步进入冷却'))
    const service = new PlatformSyncService({ repository, adapters: { zhihu } })

    await expect(service.sync('zhihu-account')).rejects.toThrow('同步进入冷却')
  })
})

function createRepository(
  accounts: Array<Pick<Account, 'id' | 'platformId'>>
): PlatformSyncAccountRepository {
  const byId = new Map(accounts.map((account) => [account.id, account]))
  return { getAccount: (id) => byId.get(id) ?? null }
}

function createAdapter(name: string, active = false): SessionApiPlatformService & {
  verifyIdentity: ReturnType<typeof vi.fn<(accountId: string) => Promise<SessionApiIdentityCheckResult>>>
  confirmIdentity: ReturnType<typeof vi.fn<(input: ConfirmSessionApiIdentityInput) => Promise<SessionApiIdentityCheckResult>>>
  sync: ReturnType<typeof vi.fn<(accountId: string) => Promise<SessionApiSyncResult>>>
  isAccountActive: ReturnType<typeof vi.fn<(accountId: string) => boolean>>
  invalidatePreviews: ReturnType<typeof vi.fn<() => void>>
} {
  return {
    verifyIdentity: vi.fn(async (accountId) => identityResult(accountId, name)),
    confirmIdentity: vi.fn(async (input) => identityResult(input.accountId, name)),
    sync: vi.fn(async (accountId) => syncResult(accountId, name)),
    isAccountActive: vi.fn(() => active),
    invalidatePreviews: vi.fn()
  }
}

function identityResult(accountId: string, remoteName: string): SessionApiIdentityCheckResult {
  return {
    accountId,
    status: 'verified',
    remoteId: `${accountId}-remote`,
    remoteName,
    confirmationToken: null,
    confirmationExpiresAt: null,
    verifiedAt: '2026-07-13T08:00:00.000Z',
    message: '当前账号已核验。'
  }
}

function syncResult(accountId: string, remoteName: string): SessionApiSyncResult {
  return {
    accountId,
    mode: 'profile_only',
    capturedAt: '2026-07-13T08:00:00.000Z',
    profile: {
      remoteId: `${accountId}-remote`,
      remoteName,
      avatarAvailable: false,
      followers: 0,
      following: 0,
      bio: ''
    },
    contentCount: 0,
    stats: {
      newContentCount: 0,
      updatedContentCount: 0,
      snapshotCount: 1,
      skippedSnapshotCount: 0
    },
    job: {
      id: 'job-1',
      accountId,
      pluginId: 'test-session-api',
      kind: 'managed_sync',
      status: 'succeeded',
      progress: 100,
      stage: '同步完成',
      result: null,
      errorCode: '',
      errorMessage: '',
      startedAt: '2026-07-13T08:00:00.000Z',
      finishedAt: '2026-07-13T08:00:01.000Z',
      createdAt: '2026-07-13T08:00:00.000Z'
    },
    message: '同步完成'
  }
}
