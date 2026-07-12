import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SocialDatabase } from './database'
import { PluginService } from './plugin-service'
import { ImportService } from './services/import-service'
import { JobService } from './services/job-service'

describe('local file import integration', () => {
  let database: SocialDatabase

  beforeEach(() => {
    database = new SocialDatabase(':memory:')
    new PluginService(database).initialize()
  })

  afterEach(() => database.close())

  it('previews, persists and idempotently reimports through the real repositories', async () => {
    const account = database.createAccount({
      platformId: 'weibo', alias: '本人账号', syncMode: 'profile_only'
    })
    const source = JSON.stringify({
      account: {
        remoteId: 'owner-1', remoteName: '我的微博', followers: 100,
        following: 10, contentCount: 1, viewsTotal: 500
      },
      contents: [{
        remoteId: 'post-1', type: 'post', title: '第一条内容',
        url: 'https://weibo.com/example/post-1',
        publishedAt: '2026-07-01T00:00:00.000Z',
        views: 500, likes: 20, comments: 3, shares: 2, favorites: 1
      }]
    })
    let tokenNumber = 0
    const jobs = new JobService(database)
    const imports = new ImportService({
      dialog: {
        showOpenDialog: async () => ({ canceled: false, filePaths: ['C:/private/official.json'] })
      },
      repository: database,
      jobs,
      fileSystem: {
        stat: async () => ({ size: source.length, isFile: () => true }),
        readFile: async () => new TextEncoder().encode(source)
      },
      clock: () => new Date('2026-07-13T08:00:00.000Z'),
      createToken: () => `preview-token-${++tokenNumber}`
    })

    const firstPreview = await imports.preview(account.id)
    expect(firstPreview?.fileName).toBe('official.json')
    expect(JSON.stringify(firstPreview)).not.toContain('C:/private')
    const first = await imports.commit({
      token: firstPreview!.token, accountId: account.id, confirmOwnership: true
    })
    expect(first).toMatchObject({ newContentCount: 1, snapshotCount: 1 })
    expect(first.job.status).toBe('succeeded')
    expect(database.getJob(first.job.id)?.status).toBe('succeeded')

    const secondPreview = await imports.preview(account.id)
    const second = await imports.commit({
      token: secondPreview!.token, accountId: account.id, confirmOwnership: true
    })
    expect(second.newContentCount).toBe(0)
    expect(second.skippedSnapshotCount).toBe(1)
    expect(database.listContents({ accountId: account.id })).toHaveLength(1)
    expect(database.getContentDetail(database.listContents()[0]!.id).snapshots).toHaveLength(1)
    expect(database.listAccountSnapshots(account.id)).toHaveLength(1)
    const importedAccount = database.getAccount(account.id)
    expect(importedAccount).toMatchObject({
      remoteId: 'owner-1', remoteName: '我的微博', ownershipStatus: 'user_confirmed',
      connectionStatus: 'pending', identityVerifiedAt: null
    })
    expect(importedAccount?.ownershipConfirmedAt).toMatch(/^\d{4}-/)
    expect(await jobs.list()).toHaveLength(2)
    expect(database.getStorageCounts()).toMatchObject({ importCount: 2, jobCount: 2 })
    expect(database.getPluginState('generic-file-import')?.successCount).toBe(2)
  })
})
