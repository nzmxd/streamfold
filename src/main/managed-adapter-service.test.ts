import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SocialDatabase } from './database'
import { ManagedAdapterService } from './managed-adapter-service'
import { PluginService } from './plugin-service'
import type { AdapterOperation } from './adapters'

describe('ManagedAdapterService', () => {
  let database: SocialDatabase
  let plugins: PluginService

  beforeEach(() => {
    database = new SocialDatabase(':memory:')
    plugins = new PluginService(database)
    plugins.initialize()
    plugins.setEnabled('xiaohongshu-managed-browser', true)
  })

  afterEach(() => database.close())

  it('verifies a visible creator identity and persists the plugin binding', async () => {
    const account = database.createAccount({
      platformId: 'xiaohongshu', alias: '本人账号', syncMode: 'profile_only'
    })
    const service = serviceWith(account.id, (operation) => operation === 'probe'
      ? probeResult('ready')
      : whoamiResult('remote-user-1', '本人昵称'))

    const preview = await service.verifyIdentity(account.id)
    expect(preview).toMatchObject({
      status: 'confirmation_required', remoteId: 'remote-user-1', remoteName: '本人昵称',
      confirmationToken: 'identity-preview-token'
    })
    expect(database.getAccount(account.id)).toMatchObject({ remoteId: null, syncEnabled: false })
    await expect(service.confirmIdentity({
      accountId: account.id,
      token: preview.confirmationToken!,
      confirmIdentity: true
    })).resolves.toMatchObject({ status: 'verified' })
    expect(database.getAccount(account.id)).toMatchObject({
      remoteId: 'remote-user-1', remoteName: '本人昵称',
      connectionStatus: 'ready', ownershipStatus: 'plugin_verified',
      identityVerifiedAt: '2026-07-13T08:00:00.000Z'
    })
    expect(database.getPluginState('xiaohongshu-managed-browser')).toMatchObject({
      successCount: 2, failureCount: 0, lastError: ''
    })
  })

  it('stops sync when the visible identity no longer matches the bound account', async () => {
    const account = database.createAccount({
      platformId: 'xiaohongshu', alias: '本人账号', syncMode: 'profile_only'
    })
    database.applyManagedIdentity(account.id, {
      remoteId: 'remote-user-1', remoteName: '原身份'
    }, '2026-07-12T08:00:00.000Z')
    const service = serviceWith(account.id, (operation) => operation === 'probe'
      ? probeResult('ready')
      : whoamiResult('remote-user-2', '另一身份'))

    await expect(service.verifyIdentity(account.id)).resolves.toMatchObject({ status: 'identity_mismatch' })
    expect(database.getAccount(account.id)).toMatchObject({
      remoteId: 'remote-user-1', connectionStatus: 'mismatch', syncEnabled: false
    })
  })

  it('marks login expiry without running whoami when the official page asks for login', async () => {
    const account = database.createAccount({
      platformId: 'xiaohongshu', alias: '待登录', syncMode: 'profile_only'
    })
    const operations: AdapterOperation[] = []
    const service = serviceWith(account.id, (operation) => {
      operations.push(operation)
      return probeResult('login_required')
    })
    await expect(service.verifyIdentity(account.id)).resolves.toMatchObject({ status: 'login_required' })
    expect(operations).toEqual(['probe'])
    expect(database.getAccount(account.id)).toMatchObject({
      connectionStatus: 'expired', syncEnabled: false, status: 'expired'
    })
  })

  it('enforces the persisted minimum interval after a completed probe', async () => {
    const account = database.createAccount({
      platformId: 'xiaohongshu', alias: '限频账号', syncMode: 'profile_only'
    })
    const service = serviceWith(account.id, () => probeResult('login_required'))
    await service.verifyIdentity(account.id)
    await expect(service.verifyIdentity(account.id)).rejects.toThrow('60 秒后重试')
  })

  it('fails closed during challenge cooldown and while the same account is already running', async () => {
    const account = database.createAccount({
      platformId: 'xiaohongshu', alias: '冷却账号', syncMode: 'profile_only'
    })
    const challenged = serviceWith(account.id, () => probeResult('challenge'))
    await challenged.verifyIdentity(account.id)
    await expect(challenged.verifyIdentity(account.id)).rejects.toThrow('安全验证冷却中')

    const second = database.createAccount({
      platformId: 'xiaohongshu', alias: '互斥账号', syncMode: 'profile_only'
    })
    let release: ((value: unknown) => void) | null = null
    const pending = new Promise<unknown>((resolve) => { release = resolve })
    const concurrent = new ManagedAdapterService({
      repository: database,
      browser: { runAdapterOperation: async () => pending },
      plugins,
      clock: () => new Date('2026-07-13T08:00:00.000Z')
    })
    const first = concurrent.verifyIdentity(second.id)
    await Promise.resolve()
    await expect(concurrent.verifyIdentity(second.id)).rejects.toThrow('正在核验身份')
    release!(probeResult('login_required'))
    await expect(first).resolves.toMatchObject({ status: 'login_required' })
  })

  function serviceWith(
    _accountId: string,
    result: (operation: AdapterOperation) => unknown
  ): ManagedAdapterService {
    return new ManagedAdapterService({
      repository: database,
      browser: { runAdapterOperation: async (_id, _adapter, operation) => result(operation) },
      plugins,
      clock: () => new Date('2026-07-13T08:00:00.000Z'),
      createToken: () => 'identity-preview-token'
    })
  }
})

function probeResult(status: 'ready' | 'login_required' | 'challenge') {
  if (status === 'ready') return {
    schemaVersion: 1,
    operation: 'probe',
    adapterId: 'xiaohongshu-managed-browser',
    adapterVersion: '0.1.0',
    scriptVersion: 'xhs-creator-probe-dom-v1',
    pageUrl: 'https://creator.xiaohongshu.com/',
    pageKind: 'creator',
    supported: true,
    status: 'ready',
    evidence: ['official_creator_host', 'dom_ready', 'visible_account_control']
  }
  if (status === 'challenge') return {
    schemaVersion: 1,
    operation: 'probe',
    adapterId: 'xiaohongshu-managed-browser',
    adapterVersion: '0.1.0',
    scriptVersion: 'xhs-creator-probe-dom-v1',
    pageUrl: 'https://creator.xiaohongshu.com/',
    pageKind: 'creator',
    supported: true,
    status: 'challenge',
    evidence: ['official_creator_host', 'visible_challenge']
  }
  return {
    schemaVersion: 1,
    operation: 'probe',
    adapterId: 'xiaohongshu-managed-browser',
    adapterVersion: '0.1.0',
    scriptVersion: 'xhs-creator-probe-dom-v1',
    pageUrl: 'https://creator.xiaohongshu.com/login',
    pageKind: 'login',
    supported: true,
    status: 'login_required',
    evidence: ['official_creator_host', 'dom_ready', 'login_route']
  }
}

function whoamiResult(remoteId: string, remoteName: string) {
  return {
    schemaVersion: 1,
    operation: 'whoami',
    adapterId: 'xiaohongshu-managed-browser',
    adapterVersion: '0.1.0',
    scriptVersion: 'xhs-creator-whoami-dom-v1',
    pageUrl: 'https://creator.xiaohongshu.com/',
    pageKind: 'creator',
    status: 'ready',
    identity: { remoteId, remoteName, profileUrl: null },
    evidence: ['official_creator_host', 'visible_profile_link', 'visible_user_id']
  }
}
