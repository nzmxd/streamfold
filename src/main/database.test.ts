import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { StandardDataset } from './plugins/types'
import type { PluginManifestV2 } from '../shared/plugin-host-contracts'
import { CURRENT_SCHEMA_VERSION, SocialDatabase } from './database'
import {
  XIAOHONGSHU_PLATFORM_CONTRIBUTION_ID,
  xiaohongshuPluginManifestV2
} from './plugins/builtin-manifests'

describe('SocialDatabase', () => {
  let database: SocialDatabase

  beforeEach(() => {
    database = new SocialDatabase(':memory:')
  })

  afterEach(() => {
    database.close()
  })

  it('persists accounts, groups, tags and local notes', () => {
    const group = database.createGroup({ name: '重点账号', color: '#339cff' })
    const account = database.createAccount({
      platformId: 'xiaohongshu',
      alias: '个人品牌号',
      syncMode: 'profile_only'
    })

    const updated = database.updateAccount({
      id: account.id,
      note: '只保存在本机',
      tags: ['重点', '图文'],
      groupIds: [group.id, group.id],
      isDefault: true
    })

    expect(updated.sessionPartition).toBe(`persist:social:${account.id}`)
    expect(updated.note).toBe('只保存在本机')
    expect(updated.tags).toEqual(['重点', '图文'])
    expect(updated.groupIds).toEqual([group.id])
    expect(updated.isDefault).toBe(true)
    expect(database.listGroups()[0]?.accountCount).toBe(1)
  })

  it('uses the verified profile name until the user customizes a local alias', () => {
    const account = database.createAccount({
      platformId: 'xiaohongshu',
      syncMode: 'profile_only'
    })
    expect(account).toMatchObject({ alias: '', aliasCustomized: false, avatarUrl: '' })

    const verified = database.applyManagedIdentity(account.id, {
      remoteId: '5605904194',
      remoteName: '平台昵称',
      avatarCacheKey: 'abc123.webp',
      avatarMime: 'image/webp',
      bio: '本人简介',
      creatorLevel: 3
    }, '2026-07-13T07:00:00.000Z')
    expect(verified).toMatchObject({
      alias: '平台昵称',
      aliasCustomized: false,
      bio: '本人简介',
      creatorLevel: 3,
      avatarUrl: `app://shell/media/avatars/${account.id}/abc123.webp`
    })

    expect(database.updateAccount({ id: account.id, alias: verified.alias, note: '只改备注' }))
      .toMatchObject({ alias: '平台昵称', aliasCustomized: false, note: '只改备注' })
    expect(database.updateAccount({ id: account.id, alias: '' }))
      .toMatchObject({ alias: '', aliasCustomized: false })
    expect(database.applyManagedIdentity(account.id, {
      remoteId: '5605904194', remoteName: '新平台昵称'
    }, '2026-07-13T07:01:00.000Z')).toMatchObject({
      alias: '新平台昵称', aliasCustomized: false, remoteName: '新平台昵称'
    })

    expect(database.updateAccount({ id: account.id, alias: '我的运营号' }))
      .toMatchObject({ alias: '我的运营号', aliasCustomized: true })
    expect(database.applyManagedIdentity(account.id, {
      remoteId: '5605904194', remoteName: '平台再次改名'
    }, '2026-07-13T07:02:00.000Z')).toMatchObject({
      alias: '我的运营号', aliasCustomized: true, remoteName: '平台再次改名'
    })
  })

  it('deleting a group does not delete its account', () => {
    const group = database.createGroup({ name: '工作账号', color: '#36a76c' })
    const account = createManagedAccount(database, 'remote-grouped', '资讯号')
    database.updateAccount({ id: account.id, groupIds: [group.id] })
    commitManagedDataset(database, account.id, standardDataset('remote-grouped', 'content-grouped'))

    database.removeGroup(group.id)

    expect(database.getAccount(account.id)?.groupIds).toEqual([])
    expect(database.listAccounts()).toHaveLength(1)
    expect(database.listContents({ accountId: account.id })).toHaveLength(1)
    expect(database.getStorageCounts()).toMatchObject({ contentSnapshotCount: 1, accountSnapshotCount: 1 })
  })

  it('renames, recolors and safely reorders groups', () => {
    const first = database.createGroup({ name: '第一组', color: '#111111' })
    const second = database.createGroup({ name: '第二组', color: '#222222' })
    const third = database.createGroup({ name: '第三组', color: '#333333' })

    expect(database.updateGroup({ id: second.id, name: '重点组', color: '#339cff' }))
      .toMatchObject({ id: second.id, name: '重点组', color: '#339cff' })
    expect(database.moveGroup({ id: third.id, direction: 'up' }).map((group) => group.id))
      .toEqual([first.id, third.id, second.id])
    expect(database.moveGroup({ id: first.id, direction: 'up' }).map((group) => group.id))
      .toEqual([first.id, third.id, second.id])
    expect(database.moveGroup({ id: first.id, direction: 'down' }).map((group) => group.id))
      .toEqual([third.id, first.id, second.id])
  })

  it('batch assigns and removes groups atomically with deduplicated account ids', () => {
    const group = database.createGroup({ name: '批量分组', color: '#339cff' })
    const first = createAccount(database, '账号 A')
    const second = createAccount(database, '账号 B')

    const assigned = database.bulkUpdateAccounts({
      accountIds: [first.id, first.id, second.id],
      groupChange: { groupId: group.id, action: 'add' }
    })
    expect(assigned).toHaveLength(2)
    expect(database.listGroups()[0]?.accountCount).toBe(2)

    database.bulkUpdateAccounts({
      accountIds: [first.id],
      groupChange: { groupId: group.id, action: 'remove' }
    })
    expect(database.getAccount(first.id)?.groupIds).toEqual([])
    expect(database.getAccount(second.id)?.groupIds).toEqual([group.id])

    expect(() => database.bulkUpdateAccounts({
      accountIds: [first.id, 'missing-account'],
      groupChange: { groupId: group.id, action: 'add' }
    })).toThrow('账号不存在')
    expect(database.getAccount(first.id)?.groupIds).toEqual([])
    expect(database.getAccount(second.id)?.groupIds).toEqual([group.id])
  })

  it('batch pauses accounts but resumes only identity-verified ready accounts', () => {
    const regular = createAccount(database, '可同步账号')
    database.applyManagedIdentity(regular.id, {
      remoteId: 'ready-account', remoteName: '已核验账号'
    }, '2026-07-13T08:00:00.000Z')
    const disconnected = createAccount(database, '已断开账号')
    const pending = createAccount(database, '待核验账号')
    const disabled = database.createAccount({
      platformId: 'weibo', alias: '禁用账号', syncMode: 'disabled'
    })
    database.disconnectAccount(disconnected.id)

    database.bulkUpdateAccounts({
      accountIds: [regular.id, disconnected.id, pending.id, disabled.id],
      syncEnabled: false
    })
    expect(database.getAccount(regular.id)?.syncEnabled).toBe(false)

    const resumed = database.bulkUpdateAccounts({
      accountIds: [regular.id, disconnected.id, pending.id, disabled.id],
      syncEnabled: true
    })
    expect(resumed.map((account) => [account.alias, account.syncEnabled])).toEqual([
      ['可同步账号', true],
      ['已断开账号', false],
      ['待核验账号', false],
      ['禁用账号', false]
    ])
    expect(database.getAccount(disconnected.id)?.connectionStatus).toBe('disconnected')
  })

  it('allows sync authorization only for a ready plugin-verified account', () => {
    const pending = createAccount(database, '待登录账号')
    expect(pending.syncEnabled).toBe(false)
    expect(database.updateAccount({ id: pending.id, syncEnabled: true }).syncEnabled).toBe(false)

    const ready = database.applyManagedIdentity(pending.id, {
      remoteId: 'verified-owner', remoteName: '已核验账号'
    }, '2026-07-13T08:00:00.000Z')
    expect(ready).toMatchObject({
      connectionStatus: 'ready', ownershipStatus: 'plugin_verified', syncEnabled: false
    })
    expect(database.updateAccount({ id: ready.id, syncEnabled: true }).syncEnabled).toBe(true)

    const expired = database.applyManagedProbeStatus(
      ready.id, 'login_required', '登录已过期', '2026-07-13T08:01:00.000Z'
    )
    expect(expired).toMatchObject({ connectionStatus: 'expired', syncEnabled: false })
    expect(database.updateAccount({ id: ready.id, syncEnabled: true }).syncEnabled).toBe(false)

    const mismatchCandidate = createAccount(database, '身份不一致账号')
    database.applyManagedIdentity(mismatchCandidate.id, {
      remoteId: 'bound-owner', remoteName: '原身份'
    }, '2026-07-13T08:02:00.000Z')
    database.updateAccount({ id: mismatchCandidate.id, syncEnabled: true })
    const mismatch = database.applyManagedIdentity(mismatchCandidate.id, {
      remoteId: 'other-owner', remoteName: '其他身份'
    }, '2026-07-13T08:03:00.000Z')
    expect(mismatch).toMatchObject({ connectionStatus: 'mismatch', syncEnabled: false })
    expect(database.updateAccount({ id: mismatch.id, syncEnabled: true }).syncEnabled).toBe(false)
  })

  it('removes only the selected local account record', () => {
    const first = database.createAccount({
      platformId: 'weibo',
      alias: '账号 A',
      syncMode: 'profile_only'
    })
    const second = database.createAccount({
      platformId: 'weibo',
      alias: '账号 B',
      syncMode: 'profile_only'
    })

    database.removeAccount(first.id)

    expect(database.getAccount(first.id)).toBeNull()
    expect(database.getAccount(second.id)?.alias).toBe('账号 B')
  })

  it('keeps content and snapshots idempotent across repeated managed syncs', () => {
    const account = createManagedAccount(database, 'remote-account-a', '账号 A')
    const payload = standardDataset('remote-account-a', 'content-a')

    expect(commitManagedDataset(database, account.id, payload, '2026-07-13T08:00:01.000Z')).toEqual({
      newContentCount: 1,
      updatedContentCount: 0,
      snapshotCount: 1,
      skippedSnapshotCount: 0
    })
    expect(commitManagedDataset(database, account.id, payload, '2026-07-13T08:01:01.000Z')).toEqual({
      newContentCount: 0,
      updatedContentCount: 1,
      snapshotCount: 0,
      skippedSnapshotCount: 1
    })

    expect(database.getStorageCounts()).toMatchObject({
      contentCount: 1,
      contentSnapshotCount: 1,
      accountSnapshotCount: 1
    })
    const content = database.listContents({ accountId: account.id })[0]
    expect(content?.remoteId).toBe('content-a')
    expect(content?.latestSnapshot?.views).toBe(120)
    expect(database.getAccount(account.id)?.latestSnapshot).toMatchObject({
      accountId: account.id,
      followers: 12,
      following: 3,
      capturedAt: payload.capturedAt
    })
  })

  it('skips a later content snapshot when every metric is unchanged', () => {
    const account = createManagedAccount(database, 'remote-account-a', '账号 A')
    const first = standardDataset('remote-account-a', 'content-a')
    commitManagedDataset(database, account.id, first, '2026-07-13T08:00:01.000Z')
    const capturedAt = '2026-07-14T09:00:00.000Z'
    const unchanged: StandardDataset = {
      ...first,
      capturedAt,
      contents: first.contents.map((content) => ({
        ...content,
        snapshots: content.snapshots.map((snapshot) => ({ ...snapshot, capturedAt }))
      }))
    }

    expect(commitManagedDataset(database, account.id, unchanged, '2026-07-14T09:00:01.000Z')).toEqual({
      newContentCount: 0,
      updatedContentCount: 1,
      snapshotCount: 0,
      skippedSnapshotCount: 1
    })
    const content = database.listContents({ accountId: account.id })[0]!
    expect(database.getContentDetail(content.id).snapshots).toHaveLength(1)
  })

  it('attaches only the newest account snapshot when listing accounts', () => {
    const account = createManagedAccount(database, 'snapshot-owner', '账号快照')
    const first = standardDataset('snapshot-owner', 'snapshot-content')
    commitManagedDataset(database, account.id, first, '2026-07-13T08:00:01.000Z')
    const second: StandardDataset = {
      ...first,
      capturedAt: '2026-07-14T08:00:00.000Z',
      profile: { ...first.profile!, followers: 99 },
      contents: []
    }
    commitManagedDataset(database, account.id, second, '2026-07-14T08:00:01.000Z')

    expect(database.listAccounts().find((item) => item.id === account.id)?.latestSnapshot)
      .toMatchObject({ followers: 99, capturedAt: second.capturedAt })
  })

  it('commits managed sync data idempotently', () => {
    const account = createManagedAccount(database, 'managed-owner', '本人账号')
    const payload = standardDataset('managed-owner', 'managed-note-1')
    const metadata = managedSyncMetadata(database, account.id, '2026-07-13T08:00:01.000Z')

    expect(database.markManagedSyncStarted(account.id, '2026-07-13T07:59:59.000Z')).toMatchObject({
      syncStatus: 'running', lastSyncError: ''
    })
    expect(database.commitManagedSync(payload, metadata)).toMatchObject({
      stats: {
        newContentCount: 1,
        updatedContentCount: 0,
        snapshotCount: 1,
        skippedSnapshotCount: 0
      },
      job: { id: metadata.jobId, status: 'succeeded', kind: 'managed_sync' }
    })
    expect(database.getAccount(account.id)).toMatchObject({
      remoteId: 'managed-owner',
      remoteName: 'managed-owner',
      ownershipStatus: 'plugin_verified',
      syncStatus: 'idle',
      lastSyncError: '',
      lastSyncedAt: payload.capturedAt,
      identityVerifiedAt: metadata.finishedAt
    })
    expect(database.getStorageCounts()).toMatchObject({
      contentCount: 1,
      contentSnapshotCount: 1,
      accountSnapshotCount: 1,
      jobCount: 1
    })

    database.markManagedSyncStarted(account.id, '2026-07-13T08:01:00.000Z')
    const secondMetadata = managedSyncMetadata(database, account.id, '2026-07-13T08:01:01.000Z')
    expect(database.commitManagedSync(payload, secondMetadata)).toMatchObject({
      stats: {
        newContentCount: 0,
        updatedContentCount: 1,
        snapshotCount: 0,
        skippedSnapshotCount: 1
      },
      job: { id: secondMetadata.jobId, status: 'succeeded' }
    })
    expect(database.getStorageCounts()).toMatchObject({
      contentCount: 1,
      contentSnapshotCount: 1,
      accountSnapshotCount: 1,
      jobCount: 2
    })
    expect(database.getPluginState('xiaohongshu-session-api')).toMatchObject({ successCount: 2 })
  })

  it('keeps an automatic alias and current profile fields in sync with managed profile data', () => {
    const created = database.createAccount({ platformId: 'xiaohongshu', syncMode: 'recent_20' })
    database.applyManagedIdentity(created.id, {
      remoteId: 'auto-owner', remoteName: '初始昵称'
    }, '2026-07-13T07:00:00.000Z')
    const account = database.updateAccount({ id: created.id, syncEnabled: true })
    const payload = standardDataset('auto-owner', 'auto-note')
    payload.profile = {
      ...payload.profile!,
      remoteName: '同步后的昵称',
      avatarCacheKey: 'def456.png',
      avatarMime: 'image/png',
      bio: '同步后的简介',
      creatorLevel: 5
    }
    const metadata = managedSyncMetadata(database, account.id, '2026-07-13T08:00:01.000Z')
    database.markManagedSyncStarted(account.id, '2026-07-13T08:00:00.000Z')
    database.commitManagedSync(payload, metadata)

    expect(database.getAccount(account.id)).toMatchObject({
      alias: '同步后的昵称',
      aliasCustomized: false,
      remoteName: '同步后的昵称',
      avatarUrl: `app://shell/media/avatars/${account.id}/def456.png`,
      bio: '同步后的简介',
      creatorLevel: 5,
      latestSnapshot: { followers: 12, following: 3 }
    })
  })

  it('rejects a managed identity mismatch atomically and records a sanitized failure state', () => {
    const account = createManagedAccount(database, 'bound-owner', '已绑定账号')
    const payload = standardDataset('different-owner', 'must-not-be-written')
    database.markManagedSyncStarted(account.id, '2026-07-13T08:00:00.000Z')
    const metadata = managedSyncMetadata(database, account.id, '2026-07-13T08:00:01.000Z')
    const before = database.getStorageCounts()

    expect(() => database.commitManagedSync(payload, metadata)).toThrow('身份与已绑定账号不一致')

    expect(database.getStorageCounts()).toEqual(before)
    expect(database.listContents({ accountId: account.id })).toEqual([])
    expect(database.listAccountSnapshots(account.id)).toEqual([])
    expect(database.getAccount(account.id)).toMatchObject({
      remoteId: 'bound-owner',
      remoteName: '已绑定账号',
      syncStatus: 'running',
      lastSyncedAt: null
    })

    const failed = database.markManagedSyncFailed(
      account.id,
      `  页面\u0000读取失败\n${'x'.repeat(600)}  `,
      '2026-07-13T08:00:01.000Z'
    )
    expect(failed.syncStatus).toBe('failed')
    expect(failed.lastSyncError).not.toMatch(/[\u0000-\u001f\u007f]/)
    expect(failed.lastSyncError.length).toBeLessThanOrEqual(500)
    expect(failed.lastSyncedAt).toBeNull()
  })

  it('does not start managed sync before plugin ownership verification', () => {
    const account = database.createAccount({
      platformId: 'xiaohongshu', alias: '尚未核验', syncMode: 'profile_only'
    })
    expect(() => database.markManagedSyncStarted(
      account.id,
      '2026-07-13T08:00:00.000Z'
    )).toThrow('已核验的本人账号身份')
  })

  it('isolates account data when clearing one account', () => {
    const first = createManagedAccount(database, 'remote-a', '账号 A')
    const second = createManagedAccount(database, 'remote-b', '账号 B')
    commitManagedDataset(database, first.id, standardDataset('remote-a', 'content-a'))
    commitManagedDataset(database, second.id, standardDataset('remote-b', 'content-b'))

    database.clearAccountData(first.id)

    expect(database.listContents({ accountId: first.id })).toEqual([])
    expect(database.listContents({ accountId: second.id }).map((item) => item.remoteId)).toEqual(['content-b'])
    expect(database.getAccount(first.id)).not.toBeNull()
    expect(database.getStorageCounts()).toMatchObject({
      accountCount: 2,
      contentCount: 1,
      contentSnapshotCount: 1,
      accountSnapshotCount: 1
    })
  })

  it('disconnects without deleting history and purges only on explicit removal', () => {
    const account = createManagedAccount(database, 'remote-a', '账号 A')
    commitManagedDataset(database, account.id, standardDataset('remote-a', 'content-a'))

    const disconnected = database.disconnectAccount(account.id)
    expect(disconnected.connectionStatus).toBe('disconnected')
    expect(disconnected.syncEnabled).toBe(false)
    expect(disconnected.status).toBe('paused')
    expect(database.listContents({ accountId: account.id })).toHaveLength(1)

    const reconnecting = database.beginReconnect(account.id)
    expect(reconnecting).toMatchObject({
      connectionStatus: 'pending',
      syncEnabled: false,
      status: 'paused'
    })
    expect(database.listContents({ accountId: account.id })).toHaveLength(1)

    database.removeAccount(account.id)
    expect(database.getAccount(account.id)).toBeNull()
    expect(database.getStorageCounts()).toMatchObject({
      accountCount: 0,
      contentCount: 0,
      contentSnapshotCount: 0,
      accountSnapshotCount: 0
    })
  })

  it('recovers active jobs as interrupted while preserving queued and completed jobs', () => {
    const account = createAccount(database, '账号 A')
    const queued = database.createJob({
      id: 'job-queued',
      kind: 'managed_sync',
      accountId: account.id,
      pluginId: 'xiaohongshu-session-api',
      status: 'queued'
    })
    const validating = database.createJob({
      id: 'job-validating',
      kind: 'managed_sync',
      accountId: account.id,
      pluginId: 'xiaohongshu-session-api',
      status: 'validating'
    })
    const committing = database.createJob({
      id: 'job-committing',
      kind: 'managed_sync',
      accountId: account.id,
      pluginId: 'xiaohongshu-session-api',
      status: 'committing'
    })
    const completed = database.createJob({
      id: 'job-done',
      kind: 'managed_sync',
      accountId: account.id,
      pluginId: 'xiaohongshu-session-api',
      status: 'succeeded',
      progress: 100
    })

    expect(database.recoverInterruptedJobs().map((job) => job.id).sort()).toEqual([
      validating.id,
      committing.id
    ].sort())
    expect(database.getJob(queued.id)).toMatchObject({
      status: 'queued',
      errorCode: '',
      finishedAt: null
    })
    expect(database.getJob(validating.id)).toMatchObject({
      status: 'interrupted',
      errorCode: 'APP_RESTARTED'
    })
    expect(database.getJob(committing.id)).toMatchObject({
      status: 'interrupted',
      errorCode: 'APP_RESTARTED'
    })
    expect(database.getJob(completed.id)?.status).toBe('succeeded')
  })

  it('clears a stale running account state when an active job is interrupted', () => {
    const account = createManagedAccount(database, 'restart-owner', '重启恢复账号')
    database.markManagedSyncStarted(account.id, '2026-07-15T00:00:00.000Z')
    database.createJob({
      id: 'job-before-restart',
      kind: 'managed_sync',
      accountId: account.id,
      pluginId: 'xiaohongshu-session-api',
      status: 'validating'
    })

    database.recoverInterruptedJobs()

    expect(database.getAccount(account.id)).toMatchObject({
      syncStatus: 'failed',
      lastSyncError: '应用退出时同步尚未完成'
    })
  })

  it('round-trips sync batch and retry metadata', () => {
    const account = createAccount(database, '账号 A')
    const firstAttempt = database.createJob({
      id: 'job-first-attempt',
      kind: 'managed_sync',
      accountId: account.id,
      pluginId: 'example-plugin',
      contributionId: 'example-plugin.platform',
      trigger: 'manual',
      status: 'failed',
      requestedSyncMode: 'profile_only',
      errorCode: 'NETWORK_ERROR'
    })
    const result = database.createSyncBatch({
      id: 'batch-retry',
      trigger: 'retry',
      requestedScope: 'recent_20',
      createdAt: '2026-07-15T01:00:00.000Z'
    }, [{
      id: 'job-retry',
      kind: 'managed_sync',
      accountId: account.id,
      pluginId: 'example-plugin',
      contributionId: 'example-plugin.platform',
      trigger: 'retry',
      attempt: 2,
      retryOfJobId: firstAttempt.id,
      requestedSyncMode: 'recent_20',
      status: 'queued',
      stage: '等待重试',
      createdAt: '2026-07-15T01:00:01.000Z'
    }])

    expect(result.batch).toEqual({
      id: 'batch-retry',
      trigger: 'retry',
      requestedScope: 'recent_20',
      createdAt: '2026-07-15T01:00:00.000Z'
    })
    expect(result.jobs[0]).toMatchObject({
      id: 'job-retry',
      batchId: 'batch-retry',
      contributionId: 'example-plugin.platform',
      trigger: 'retry',
      attempt: 2,
      retryOfJobId: firstAttempt.id,
      requestedSyncMode: 'recent_20'
    })
    expect(database.listJobBatches()).toEqual([result.batch])
    expect(database.getJob('job-retry')).toEqual(result.jobs[0])

    expect(database.updateJob('job-retry', {
      requestedSyncMode: null,
      retryOfJobId: null,
      result: { recovered: true }
    })).toMatchObject({
      requestedSyncMode: null,
      retryOfJobId: null,
      result: { recovered: true }
    })
  })

  it('creates a sync batch and all account jobs atomically', () => {
    const account = createAccount(database, '账号 A')

    expect(() => database.createSyncBatch({
      id: 'batch-rollback',
      trigger: 'manual',
      requestedScope: 'account_default'
    }, [{
      id: 'job-before-rollback',
      kind: 'managed_sync',
      accountId: account.id,
      pluginId: 'example-plugin'
    }, {
      id: 'job-invalid-account',
      kind: 'managed_sync',
      accountId: 'missing-account',
      pluginId: 'example-plugin'
    }])).toThrow('账号不存在')

    expect(database.getJobBatch('batch-rollback')).toBeNull()
    expect(database.getJob('job-before-rollback')).toBeNull()
  })

  it('updates jobs with an atomic expected-status guard', () => {
    const account = createAccount(database, '账号 A')
    const job = database.createJob({
      id: 'job-cas',
      kind: 'managed_sync',
      accountId: account.id,
      pluginId: 'xiaohongshu-session-api',
      status: 'queued'
    })

    expect(database.updateJob(job.id, { status: 'validating' }, ['queued']).status).toBe('validating')
    expect(() => database.updateJob(job.id, { status: 'cancelled' }, ['queued']))
      .toThrow('任务状态已变更')
    expect(database.getJob(job.id)?.status).toBe('validating')
  })

  it('round-trips typed settings and supports a missing-value fallback', () => {
    expect(database.getSetting('rawRetentionDays', 30)).toBe(30)
    expect(database.setSetting('rawRetentionDays', 90)).toBe(90)
    expect(database.getSetting<number>('rawRetentionDays')).toBe(90)
    expect(database.getSetting('missing')).toBeNull()
  })

})

describe('SocialDatabase migrations', () => {
  let directory = ''
  let database: SocialDatabase | null = null

  afterEach(() => {
    database?.close()
    database = null
    if (directory) rmSync(directory, { recursive: true, force: true })
  })

  it('migrates an existing unversioned three-table database to the current schema', () => {
    directory = mkdtempSync(join(tmpdir(), 'social-vault-db-'))
    const path = join(directory, 'legacy.sqlite')
    const legacy = new DatabaseSync(path)
    legacy.exec(`
      PRAGMA user_version = 0;
      CREATE TABLE groups (
        id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, color TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE accounts (
        id TEXT PRIMARY KEY, platform_id TEXT NOT NULL, alias TEXT NOT NULL,
        remote_name TEXT NOT NULL DEFAULT '', remote_id TEXT, status TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '', tags_json TEXT NOT NULL DEFAULT '[]',
        session_partition TEXT NOT NULL UNIQUE, sync_mode TEXT NOT NULL DEFAULT 'profile_only',
        is_default INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL, last_synced_at TEXT
      ) STRICT;
      CREATE TABLE account_groups (
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        PRIMARY KEY (account_id, group_id)
      ) STRICT;
      INSERT INTO accounts (
        id, platform_id, alias, remote_name, remote_id, status, note, tags_json,
        session_partition, sync_mode, is_default, created_at, updated_at, last_synced_at
      ) VALUES (
        'legacy-account', 'weibo', '旧账号', '', NULL, 'paused', '', '[]',
        'persist:social:legacy-account', 'profile_only', 0,
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL
      );
    `)
    legacy.close()

    database = new SocialDatabase(path)

    expect(database.getSchemaVersion()).toBe(CURRENT_SCHEMA_VERSION)
    expect(database.getAccount('legacy-account')).toMatchObject({
      status: 'paused',
      connectionStatus: 'pending',
      ownershipStatus: 'unconfirmed',
      syncEnabled: false,
      syncStatus: 'idle',
      aliasCustomized: true,
      avatarUrl: '',
      bio: '',
      creatorLevel: null,
      latestSnapshot: null
    })
    expect(database.getStorageCounts()).toMatchObject({
      accountCount: 1,
      contentCount: 0,
      jobCount: 0
    })
  })

  it('separates user confirmation time from plugin identity verification in v3', () => {
    directory = mkdtempSync(join(tmpdir(), 'social-vault-db-'))
    const path = join(directory, 'v2.sqlite')
    database = new SocialDatabase(path)
    const account = createAccount(database, '已确认账号')
    database.close()
    database = null

    const previous = new DatabaseSync(path)
    previous.prepare(`
      UPDATE accounts SET ownership_status = 'user_confirmed',
        identity_verified_at = '2026-07-01T00:00:00.000Z', ownership_confirmed_at = NULL
      WHERE id = ?
    `).run(account.id)
    previous.exec('PRAGMA user_version = 2')
    previous.close()

    database = new SocialDatabase(path)
    expect(database.getSchemaVersion()).toBe(CURRENT_SCHEMA_VERSION)
    expect(database.getAccount(account.id)).toMatchObject({
      ownershipStatus: 'user_confirmed',
      ownershipConfirmedAt: '2026-07-01T00:00:00.000Z',
      identityVerifiedAt: null
    })
  })

  it('revokes invalid persisted sync authorization when migrating v3 to v4', () => {
    directory = mkdtempSync(join(tmpdir(), 'social-vault-db-'))
    const path = join(directory, 'v3.sqlite')
    database = new SocialDatabase(path)
    const account = createAccount(database, '旧授权账号')
    database.close()
    database = null

    const previous = new DatabaseSync(path)
    previous.exec(`
      DROP TRIGGER accounts_sync_authorization_insert;
      DROP TRIGGER accounts_sync_authorization_update;
    `)
    previous.prepare(`
      UPDATE accounts SET connection_status = 'ready', ownership_status = 'user_confirmed',
        sync_enabled = 1 WHERE id = ?
    `).run(account.id)
    previous.exec('PRAGMA user_version = 3')
    previous.close()

    database = new SocialDatabase(path)
    expect(database.getSchemaVersion()).toBe(CURRENT_SCHEMA_VERSION)
    expect(database.getAccount(account.id)).toMatchObject({
      connectionStatus: 'ready', ownershipStatus: 'user_confirmed', syncEnabled: false
    })

    database.close()
    database = null
    const constrained = new DatabaseSync(path)
    expect(() => constrained.prepare(`
      UPDATE accounts SET sync_enabled = 1 WHERE id = ?
    `).run(account.id)).toThrow('invalid sync authorization')
    constrained.close()
  })

  it('retires old DOM and file-import plugin state without clearing the account session', () => {
    directory = mkdtempSync(join(tmpdir(), 'social-vault-db-'))
    const path = join(directory, 'v4.sqlite')
    database = new SocialDatabase(path)
    const account = database.createAccount({
      platformId: 'xiaohongshu', alias: '旧版账号', syncMode: 'recent_20'
    })
    database.applyManagedIdentity(account.id, {
      remoteId: '5605904194', remoteName: '本人账号'
    }, '2026-07-13T08:00:00.000Z')
    database.updateAccount({ id: account.id, syncEnabled: true })
    database.close()
    database = null

    const previous = new DatabaseSync(path)
    const at = '2026-07-13T08:00:00.000Z'
    const insertPlugin = previous.prepare(`
      INSERT OR REPLACE INTO plugin_installations (
        plugin_id, manifest_json, enabled, availability, installed_at,
        last_run_at, success_count, failure_count, last_error, updated_at
      ) VALUES (?, '{}', 1, 'available', ?, ?, 1, 0, '', ?)
    `)
    insertPlugin.run('xiaohongshu-managed-browser', at, at, at)
    insertPlugin.run('generic-file-import', at, at, at)
    previous.prepare(`
      INSERT INTO sync_cursors (account_id, plugin_id, cursor_json, updated_at)
      VALUES (?, 'xiaohongshu-managed-browser', '{}', ?)
    `).run(account.id, at)
    previous.exec('PRAGMA user_version = 4')
    previous.close()

    database = new SocialDatabase(path)
    expect(database.getAccount(account.id)).toMatchObject({
      remoteId: '5605904194',
      remoteName: '本人账号',
      sessionPartition: account.sessionPartition,
      ownershipStatus: 'user_confirmed',
      connectionStatus: 'pending',
      syncEnabled: false,
      identityVerifiedAt: null
    })
    expect(database.getPluginState('xiaohongshu-managed-browser')).toBeNull()
    expect(database.getPluginState('generic-file-import')).toBeNull()
  })

  it('preserves existing aliases and adds empty profile fields when migrating v5 to v6', () => {
    directory = mkdtempSync(join(tmpdir(), 'social-vault-db-'))
    const path = join(directory, 'v5.sqlite')
    database = new SocialDatabase(path)
    const account = createAccount(database, '历史本地别名')
    database.close()
    database = null

    const previous = new DatabaseSync(path)
    previous.exec(`
      ALTER TABLE accounts DROP COLUMN creator_level;
      ALTER TABLE accounts DROP COLUMN bio;
      ALTER TABLE accounts DROP COLUMN avatar_mime;
      ALTER TABLE accounts DROP COLUMN avatar_cache_key;
      ALTER TABLE accounts DROP COLUMN alias_customized;
      PRAGMA user_version = 5;
    `)
    previous.close()

    database = new SocialDatabase(path)
    expect(database.getSchemaVersion()).toBe(CURRENT_SCHEMA_VERSION)
    expect(database.getAccount(account.id)).toMatchObject({
      alias: '历史本地别名',
      aliasCustomized: true,
      avatarUrl: '',
      bio: '',
      creatorLevel: null
    })
  })

  it('backfills legacy Xiaohongshu analytics links with canonical public note URLs in v7', () => {
    directory = mkdtempSync(join(tmpdir(), 'social-vault-db-'))
    const path = join(directory, 'v6.sqlite')
    database = new SocialDatabase(path)
    const account = database.createAccount({
      platformId: 'xiaohongshu', alias: '历史小红书账号', syncMode: 'profile_only'
    })
    database.close()
    database = null

    const previous = new DatabaseSync(path)
    previous.prepare(`
      INSERT INTO contents (
        id, account_id, remote_id, type, title, body_excerpt, url, published_at,
        first_captured_at, updated_at, note, tags_json
      ) VALUES (?, ?, ?, 'image', '历史笔记', '', ?, NULL, ?, ?, '', '[]')
    `).run(
      'legacy-content',
      account.id,
      'aaaaaaaaaaaaaaaaaaaaaaaa',
      'https://creator.xiaohongshu.com/statistics/note-detail?noteId=aaaaaaaaaaaaaaaaaaaaaaaa',
      '2026-07-01T00:00:00.000Z',
      '2026-07-01T00:00:00.000Z'
    )
    previous.exec('PRAGMA user_version = 6')
    previous.close()

    database = new SocialDatabase(path)
    expect(database.getSchemaVersion()).toBe(CURRENT_SCHEMA_VERSION)
    expect(database.getContentDetail('legacy-content').url)
      .toBe('https://www.xiaohongshu.com/explore/aaaaaaaaaaaaaaaaaaaaaaaa')
  })

  it('compacts consecutive unchanged content snapshots in v8', () => {
    directory = mkdtempSync(join(tmpdir(), 'social-vault-db-'))
    const path = join(directory, 'v7.sqlite')
    database = new SocialDatabase(path)
    const account = createManagedAccount(database, 'snapshot-owner', '历史快照账号')
    const payload = standardDataset('snapshot-owner', 'snapshot-content')
    commitManagedDataset(database, account.id, payload)
    const contentId = database.listContents({ accountId: account.id })[0]!.id
    database.close()
    database = null

    const previous = new DatabaseSync(path)
    const insert = previous.prepare(`
      INSERT INTO content_snapshots (
        id, content_id, views, likes, comments, shares, favorites, captured_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    insert.run('same-1', contentId, 120, 10, 2, 1, 3, '2026-07-14T09:00:00.000Z')
    insert.run('same-2', contentId, 120, 10, 2, 1, 3, '2026-07-14T10:00:00.000Z')
    insert.run('changed', contentId, 121, 10, 2, 1, 3, '2026-07-14T11:00:00.000Z')
    insert.run('same-after-change', contentId, 121, 10, 2, 1, 3, '2026-07-14T12:00:00.000Z')
    previous.exec('PRAGMA user_version = 7')
    previous.close()

    database = new SocialDatabase(path)

    expect(database.getSchemaVersion()).toBe(CURRENT_SCHEMA_VERSION)
    expect(database.getContentDetail(contentId).snapshots.map((snapshot) => snapshot.views))
      .toEqual([120, 121])
  })

  it('drops legacy import bookkeeping without deleting synchronized business data in v10', () => {
    directory = mkdtempSync(join(tmpdir(), 'social-vault-db-'))
    const path = join(directory, 'v9.sqlite')
    database = new SocialDatabase(path)
    const account = createManagedAccount(database, 'preserved-owner', '保留账号')
    commitManagedDataset(database, account.id, standardDataset('preserved-owner', 'preserved-content'))
    const contentId = database.listContents({ accountId: account.id })[0]!.id
    database.close()
    database = null

    const previous = new DatabaseSync(path)
    previous.exec(`
      CREATE TABLE import_batches (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL
      ) STRICT;
      INSERT INTO import_batches (id, account_id, created_at)
      VALUES ('legacy-import', '${account.id}', '2026-07-13T08:00:00.000Z');
      PRAGMA user_version = 9;
    `)
    previous.close()

    database = new SocialDatabase(path)
    expect(database.getSchemaVersion()).toBe(CURRENT_SCHEMA_VERSION)
    expect(database.getAccount(account.id)).not.toBeNull()
    expect(database.getContentDetail(contentId).remoteId).toBe('preserved-content')
    expect(database.getContentDetail(contentId).snapshots).toHaveLength(1)
    expect(database.getStorageCounts()).toMatchObject({
      accountCount: 1,
      contentCount: 1,
      accountSnapshotCount: 1,
      contentSnapshotCount: 1,
      jobCount: 1
    })
    database.close()
    database = null

    const inspected = new DatabaseSync(path, { readOnly: true })
    expect(inspected.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'import_batches'
    `).get()).toBeUndefined()
    inspected.close()
  })

  it('migrates v10 jobs to durable v11 batch and retry metadata', () => {
    directory = mkdtempSync(join(tmpdir(), 'social-vault-db-'))
    const path = join(directory, 'v10.sqlite')
    database = new SocialDatabase(path)
    const account = database.createAccount({
      platformId: 'xiaohongshu', alias: '历史任务账号', syncMode: 'recent_20'
    })
    database.createJob({
      id: 'legacy-v10-job',
      kind: 'managed_sync',
      accountId: account.id,
      pluginId: 'xiaohongshu-session-api',
      status: 'queued',
      createdAt: '2026-07-14T08:00:00.000Z'
    })
    database.close()
    database = null

    const previous = new DatabaseSync(path)
    previous.exec(`
      DROP INDEX idx_jobs_batch_status_created;
      DROP INDEX idx_jobs_retry_of;
      DROP INDEX idx_job_batches_created;
      ALTER TABLE jobs DROP COLUMN requested_sync_mode;
      ALTER TABLE jobs DROP COLUMN retry_of_job_id;
      ALTER TABLE jobs DROP COLUMN attempt;
      ALTER TABLE jobs DROP COLUMN trigger_kind;
      ALTER TABLE jobs DROP COLUMN contribution_id;
      ALTER TABLE jobs DROP COLUMN batch_id;
      DROP TABLE job_batches;
      PRAGMA user_version = 10;
    `)
    previous.close()

    database = new SocialDatabase(path)

    expect(database.getSchemaVersion()).toBe(CURRENT_SCHEMA_VERSION)
    expect(database.getJob('legacy-v10-job')).toMatchObject({
      batchId: null,
      contributionId: XIAOHONGSHU_PLATFORM_CONTRIBUTION_ID,
      trigger: 'manual',
      status: 'queued',
      attempt: 1,
      retryOfJobId: null,
      requestedSyncMode: 'recent_20'
    })
    expect(database.listJobBatches()).toEqual([])

    database.close()
    database = null
    const inspected = new DatabaseSync(path, { readOnly: true })
    const indexes = inspected.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'index' AND name IN (
        'idx_job_batches_created', 'idx_jobs_batch_status_created', 'idx_jobs_retry_of'
      ) ORDER BY name
    `).all() as unknown as Array<{ name: string }>
    expect(indexes.map(({ name }) => name)).toEqual([
      'idx_job_batches_created',
      'idx_jobs_batch_status_created',
      'idx_jobs_retry_of'
    ])
    inspected.close()
  })
})

describe('SocialDatabase backup images', () => {
  let directory = ''
  let database: SocialDatabase | null = null

  afterEach(() => {
    database?.close()
    database = null
    if (directory) rmSync(directory, { recursive: true, force: true })
  })

  it('restores a validated SQLite image and requires login verification again', () => {
    directory = mkdtempSync(join(tmpdir(), 'social-vault-backup-'))
    database = new SocialDatabase(join(directory, 'vault.sqlite'))
    const group = database.createGroup({ name: '备份分组', color: '#339cff' })
    const account = createManagedAccount(database, 'remote-backup', '备份账号')
    database.applyManagedIdentity(account.id, {
      remoteId: 'remote-backup', remoteName: '备份账号',
      avatarCacheKey: 'abc123.webp', avatarMime: 'image/webp'
    }, '2026-07-13T07:00:01.000Z')
    database.updateAccount({ id: account.id, groupIds: [group.id] })
    commitManagedDataset(database, account.id, standardDataset('remote-backup', 'content-backup'))
    const queuedBeforeBackup = database.createJob({
      id: 'queued-before-backup',
      kind: 'managed_sync',
      accountId: account.id,
      pluginId: 'xiaohongshu-session-api',
      status: 'queued'
    })
    const externalManifest: PluginManifestV2 = {
      schemaVersion: 2,
      id: 'backup.example',
      name: 'Backup example',
      version: '1.0.0',
      description: 'Verifies portable plugin state',
      license: 'MIT',
      publisher: { id: 'example.publisher', name: 'Example', keyId: 'example.publisher.main' },
      minimumAppVersion: '0.5.0',
      sdkVersion: '1.0.0',
      contributions: [{
        id: 'backup.example.action',
        kind: 'action',
        name: 'Backup action',
        description: 'Test action',
        entry: 'entries/action.js',
        runtime: 'quickjs',
        permissions: ['network.https'],
        placements: ['plugin-center']
      }]
    }
    database.upsertPluginPackage(externalManifest, {
      source: 'catalog', status: 'active', enabled: true,
      packageHash: `sha256:${'b'.repeat(64)}`,
      publisherKeyId: externalManifest.publisher.keyId
    })
    database.savePluginConfig({
      pluginId: externalManifest.id,
      contributionId: externalManifest.contributions[0]!.id,
      publicConfig: { url: 'https://hooks.example.test/events' },
      encryptedSecrets: { token: 'encrypted-secret-that-must-not-be-backed-up' }
    })
    const image = database.createBackupImage()

    const portablePath = join(directory, 'portable-inspection.sqlite')
    writeFileSync(portablePath, image)
    const portable = new DatabaseSync(portablePath, { readOnly: true })
    expect(portable.prepare(`
      SELECT encrypted_secrets_json FROM plugin_configs
      WHERE plugin_id = ? AND contribution_id = ?
    `).get(externalManifest.id, externalManifest.contributions[0]!.id)).toEqual({
      encrypted_secrets_json: '{}'
    })
    expect(portable.prepare(`
      SELECT enabled, package_status, last_error FROM plugin_installations WHERE plugin_id = ?
    `).get(externalManifest.id)).toEqual({
      enabled: 0,
      package_status: 'disabled',
      last_error: '恢复后需要从插件目录重新安装'
    })
    portable.close()

    database.updateAccount({ id: account.id, alias: '已修改', groupIds: [] })
    expect(() => database?.restoreBackupImage(image, () => {
      throw new Error('post-restore initialization failed')
    })).toThrow('原数据库已保留')
    expect(database.getAccount(account.id)?.alias).toBe('已修改')

    database.restoreBackupImage(image)
    image.fill(0)

    expect(database.getAccount(account.id)).toMatchObject({
      alias: '备份账号',
      groupIds: [group.id],
      connectionStatus: 'pending',
      avatarUrl: '',
      syncEnabled: false,
      syncStatus: 'idle'
    })
    expect(database.listContents({ accountId: account.id })).toHaveLength(1)
    expect(database.getAccount(account.id)?.lastSyncError).toContain('重新打开官方页面')
    expect(database.getJob(queuedBeforeBackup.id)).toMatchObject({
      status: 'interrupted',
      errorCode: 'BACKUP_RESTORED'
    })

    expect(() => database?.restoreBackupImage(Buffer.from('not a sqlite database')))
      .toThrow('数据库格式无效')
    expect(database.getAccount(account.id)?.alias).toBe('备份账号')
  })
})

function createAccount(database: SocialDatabase, alias: string) {
  return database.createAccount({
    platformId: 'weibo',
    alias,
    syncMode: 'profile_only'
  })
}

function createManagedAccount(database: SocialDatabase, remoteId: string, remoteName: string) {
  const account = database.createAccount({
    platformId: 'xiaohongshu', alias: remoteName, syncMode: 'recent_20'
  })
  database.applyManagedIdentity(account.id, { remoteId, remoteName }, '2026-07-13T07:00:00.000Z')
  return database.updateAccount({ id: account.id, syncEnabled: true })
}

function managedSyncMetadata(database: SocialDatabase, accountId: string, finishedAt: string) {
  database.upsertPluginPackage(xiaohongshuPluginManifestV2, {
    source: 'builtin',
    status: 'active',
    enabled: true,
    packageHash: 'builtin:xiaohongshu-session-api@0.3.0',
    publisherKeyId: xiaohongshuPluginManifestV2.publisher.keyId
  })
  database.setPluginContributionEnabled(
    xiaohongshuPluginManifestV2.id,
    XIAOHONGSHU_PLATFORM_CONTRIBUTION_ID,
    true
  )
  const job = database.createJob({
    kind: 'managed_sync',
    accountId,
    pluginId: 'xiaohongshu-session-api',
    status: 'committing',
    progress: 80,
    stage: '写入本人资料与内容快照'
  })
  return {
    accountId,
    pluginId: 'xiaohongshu-session-api',
    jobId: job.id,
    authorizedMode: 'recent_20' as const,
    payloadMode: 'recent_20' as const,
    finishedAt
  }
}

function commitManagedDataset(
  database: SocialDatabase,
  accountId: string,
  dataset: StandardDataset,
  finishedAt = '2026-07-13T08:00:01.000Z'
) {
  const startedAt = new Date(Date.parse(finishedAt) - 1_000).toISOString()
  database.markManagedSyncStarted(accountId, startedAt)
  const metadata = managedSyncMetadata(database, accountId, finishedAt)
  return database.commitManagedSync(dataset, metadata).stats
}

function standardDataset(remoteAccountId: string, remoteContentId: string): StandardDataset {
  return {
    capturedAt: '2026-07-13T08:00:00.000Z',
    profile: {
      remoteId: remoteAccountId,
      remoteName: remoteAccountId,
      followers: 12,
      following: 3,
      contentCount: 1,
      viewsTotal: 120
    },
    contents: [{
      remoteId: remoteContentId,
      type: 'article',
      title: `文章 ${remoteContentId}`,
      bodyExcerpt: '正文摘要',
      url: `https://example.com/${remoteContentId}`,
      publishedAt: '2026-07-12T08:00:00.000Z',
      snapshots: [{
        views: 120,
        likes: 10,
        comments: 2,
        shares: 1,
        favorites: 3,
        capturedAt: '2026-07-13T08:00:00.000Z'
      }]
    }],
    warnings: []
  }
}
