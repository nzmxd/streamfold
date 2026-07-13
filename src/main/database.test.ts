import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { NormalizedImportPayload } from './plugins/types'
import { SocialDatabase } from './database'
import { PluginService } from './plugin-service'

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

  it('deleting a group does not delete its account', () => {
    const group = database.createGroup({ name: '工作账号', color: '#36a76c' })
    const account = database.createAccount({
      platformId: 'weibo',
      alias: '资讯号',
      syncMode: 'disabled'
    })
    database.updateAccount({ id: account.id, groupIds: [group.id] })
    database.commitImport(importPayload('remote-grouped', 'content-grouped'), importMetadata(account.id))

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

  it('keeps content and snapshots idempotent across repeated imports', () => {
    const account = createAccount(database, '账号 A')
    const payload = importPayload('remote-account-a', 'content-a')

    expect(database.commitImport(payload, importMetadata(account.id))).toEqual({
      newContentCount: 1,
      updatedContentCount: 0,
      snapshotCount: 1,
      skippedSnapshotCount: 0
    })
    expect(database.commitImport(payload, importMetadata(account.id))).toEqual({
      newContentCount: 0,
      updatedContentCount: 1,
      snapshotCount: 0,
      skippedSnapshotCount: 1
    })

    expect(database.getStorageCounts()).toMatchObject({
      contentCount: 1,
      contentSnapshotCount: 1,
      accountSnapshotCount: 1,
      importCount: 2
    })
    const content = database.listContents({ accountId: account.id })[0]
    expect(content?.remoteId).toBe('content-a')
    expect(content?.latestSnapshot?.views).toBe(120)
  })

  it('commits managed sync data idempotently without creating a file import batch', () => {
    const account = createManagedAccount(database, 'managed-owner', '本人账号')
    const payload = importPayload('managed-owner', 'managed-note-1')
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
      importCount: 0,
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
      importCount: 0,
      jobCount: 2
    })
    expect(database.getPluginState('xiaohongshu-session-api')).toMatchObject({ successCount: 2 })
  })

  it('rejects a managed identity mismatch atomically and records a sanitized failure state', () => {
    const account = createManagedAccount(database, 'bound-owner', '已绑定账号')
    const payload = importPayload('different-owner', 'must-not-be-written')
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

  it('rolls back every write when an imported identity conflicts', () => {
    const first = createAccount(database, '账号 A')
    const second = createAccount(database, '账号 B')
    database.commitImport(importPayload('same-remote-id', 'content-a'), importMetadata(first.id))
    const before = database.getStorageCounts()

    expect(() => database.commitImport(
      importPayload('same-remote-id', 'content-b'),
      importMetadata(second.id)
    )).toThrow('已经绑定')

    expect(database.getStorageCounts()).toEqual(before)
    expect(database.getAccount(second.id)?.remoteId).toBeNull()
    expect(database.listContents({ accountId: second.id })).toEqual([])
  })

  it('isolates account data when clearing one account', () => {
    const first = createAccount(database, '账号 A')
    const second = createAccount(database, '账号 B')
    database.commitImport(importPayload('remote-a', 'content-a'), importMetadata(first.id))
    database.commitImport(importPayload('remote-b', 'content-b'), importMetadata(second.id))

    database.clearAccountData(first.id)

    expect(database.listContents({ accountId: first.id })).toEqual([])
    expect(database.listContents({ accountId: second.id }).map((item) => item.remoteId)).toEqual(['content-b'])
    expect(database.getAccount(first.id)).not.toBeNull()
    expect(database.getStorageCounts()).toMatchObject({
      accountCount: 2,
      contentCount: 1,
      contentSnapshotCount: 1,
      accountSnapshotCount: 1,
      importCount: 1
    })
  })

  it('disconnects without deleting history and purges only on explicit removal', () => {
    const account = createAccount(database, '账号 A')
    database.commitImport(importPayload('remote-a', 'content-a'), importMetadata(account.id))

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
      accountSnapshotCount: 0,
      importCount: 0
    })
  })

  it('recovers in-flight jobs as interrupted while leaving completed jobs unchanged', () => {
    const account = createAccount(database, '账号 A')
    const queued = database.createJob({
      id: 'job-queued',
      kind: 'managed_sync',
      accountId: account.id,
      pluginId: 'xiaohongshu-session-api',
      status: 'queued'
    })
    const completed = database.createJob({
      id: 'job-done',
      kind: 'managed_sync',
      accountId: account.id,
      pluginId: 'xiaohongshu-session-api',
      status: 'succeeded',
      progress: 100
    })

    expect(database.recoverInterruptedJobs().map((job) => job.id)).toEqual([queued.id])
    expect(database.getJob(queued.id)).toMatchObject({
      status: 'interrupted',
      errorCode: 'APP_RESTARTED'
    })
    expect(database.getJob(completed.id)?.status).toBe('succeeded')
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

    expect(database.getSchemaVersion()).toBe(5)
    expect(database.getAccount('legacy-account')).toMatchObject({
      status: 'paused',
      connectionStatus: 'pending',
      ownershipStatus: 'unconfirmed',
      syncEnabled: false,
      syncStatus: 'idle'
    })
    expect(database.getStorageCounts()).toMatchObject({
      accountCount: 1,
      contentCount: 0,
      jobCount: 0,
      importCount: 0
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
    expect(database.getSchemaVersion()).toBe(5)
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
    expect(database.getSchemaVersion()).toBe(5)
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
    const account = database.createAccount({
      platformId: 'xiaohongshu', alias: '备份账号', syncMode: 'profile_only'
    })
    database.updateAccount({ id: account.id, groupIds: [group.id] })
    database.commitImport(importPayload('remote-backup', 'content-backup'), importMetadata(account.id))
    const image = database.createBackupImage()

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
      syncEnabled: false,
      syncStatus: 'idle'
    })
    expect(database.listContents({ accountId: account.id })).toHaveLength(1)
    expect(database.getAccount(account.id)?.lastSyncError).toContain('重新打开官方页面')

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
  const plugins = new PluginService(database)
  plugins.initialize()
  plugins.setEnabled('xiaohongshu-session-api', true)
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

function importMetadata(accountId: string) {
  return {
    accountId,
    pluginId: 'builtin.file',
    fileName: 'C:\\private\\exports\\social-data.json',
    fileHash: `hash-${accountId}`,
    confirmOwnership: true
  }
}

function importPayload(remoteAccountId: string, remoteContentId: string): NormalizedImportPayload {
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
