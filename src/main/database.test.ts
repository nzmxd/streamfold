import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { ImportRepository } from './services/import-service'
import type { JobRepository } from './services/job-service'
import type { NormalizedImportPayload } from './plugins/types'
import { SocialDatabase } from './database'

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
      groupIds: [group.id],
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

    database.removeGroup(group.id)

    expect(database.getAccount(account.id)?.groupIds).toEqual([])
    expect(database.listAccounts()).toHaveLength(1)
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
      kind: 'file_import',
      accountId: account.id,
      pluginId: 'builtin.file',
      status: 'queued'
    })
    const completed = database.createJob({
      id: 'job-done',
      kind: 'file_import',
      accountId: account.id,
      pluginId: 'builtin.file',
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
      kind: 'file_import',
      accountId: account.id,
      pluginId: 'builtin.file',
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

  it('implements the import and job repository persistence boundaries', () => {
    const importRepository: ImportRepository = database
    const jobRepository: JobRepository = database
    const account = createAccount(database, '账号 A')
    const manifest = {
      schemaVersion: 1 as const,
      id: 'builtin.file',
      name: '本地文件导入',
      version: '1.0.0',
      description: '测试插件',
      license: 'MIT',
      source: 'builtin' as const,
      commitHash: 'builtin',
      mode: 'file_import' as const,
      readOnly: true as const,
      ownedAccountOnly: true as const,
      capabilities: ['file.import' as const],
      allowedHosts: [],
      minimumIntervalSeconds: 0,
      recommendedSyncIntervalHours: 24,
      riskLevel: 'low' as const
    }
    database.upsertPluginState(manifest, { enabled: true })
    database.commitImport(importPayload('remote-a', 'content-a'), importMetadata(account.id))
    const job = database.createJob({
      id: 'job-import',
      kind: 'file_import',
      accountId: account.id,
      pluginId: manifest.id,
      status: 'succeeded',
      progress: 100,
      stage: '完成',
      result: { newContentCount: 1, updatedContentCount: 0, snapshotCount: 1, skippedSnapshotCount: 0 },
      errorCode: '',
      errorMessage: '',
      createdAt: '2026-07-13T08:00:00.000Z',
      startedAt: '2026-07-13T08:00:00.000Z',
      finishedAt: '2026-07-13T08:00:01.000Z'
    })

    expect(jobRepository.getJob(job.id)).toEqual(job)
    expect(importRepository.accountExists(account.id)).toBe(true)
    expect(importRepository.isPluginEnabled(manifest.id)).toBe(true)
    importRepository.recordPluginRun({
      jobId: job.id,
      pluginId: manifest.id,
      accountId: account.id,
      status: 'succeeded',
      startedAt: '2026-07-13T08:00:00.000Z',
      finishedAt: '2026-07-13T08:00:01.000Z',
      fileName: 'C:\\secret\\social-data.json',
      fileHash: `hash-${account.id}`,
      result: job.result,
      errorCode: '',
      errorMessage: ''
    })
    // Retrying the run audit is idempotent and must not increment counters twice.
    importRepository.recordPluginRun({
      jobId: job.id,
      pluginId: manifest.id,
      accountId: account.id,
      status: 'succeeded',
      startedAt: '2026-07-13T08:00:00.000Z',
      finishedAt: '2026-07-13T08:00:01.000Z',
      fileName: 'C:\\secret\\social-data.json',
      fileHash: `hash-${account.id}`,
      result: job.result,
      errorCode: '',
      errorMessage: ''
    })
    expect(database.getPluginState(manifest.id)).toMatchObject({ successCount: 1, failureCount: 0 })
    expect(database.getStorageCounts().importCount).toBe(1)
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

    expect(database.getSchemaVersion()).toBe(3)
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
    expect(database.getSchemaVersion()).toBe(3)
    expect(database.getAccount(account.id)).toMatchObject({
      ownershipStatus: 'user_confirmed',
      ownershipConfirmedAt: '2026-07-01T00:00:00.000Z',
      identityVerifiedAt: null
    })
  })
})

function createAccount(database: SocialDatabase, alias: string) {
  return database.createAccount({
    platformId: 'weibo',
    alias,
    syncMode: 'profile_only'
  })
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
