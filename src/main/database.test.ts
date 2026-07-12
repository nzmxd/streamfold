import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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
})
