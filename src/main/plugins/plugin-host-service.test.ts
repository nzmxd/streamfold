import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SocialDatabase } from '../database'
import {
  XIAOHONGSHU_PLATFORM_CONTRIBUTION_ID,
  xiaohongshuPluginManifestV2
} from './builtin-manifests'
import { PluginHostService } from './plugin-host-service'

describe('PluginHostService schedules', () => {
  let database: SocialDatabase
  let host: PluginHostService
  let accountId: string

  beforeEach(() => {
    database = new SocialDatabase(':memory:')
    host = new PluginHostService(database, {
      available: () => true,
      encrypt: (value) => value,
      decrypt: (value) => value
    })
    host.initialize()
    host.setPackageEnabled(xiaohongshuPluginManifestV2.id, true)
    accountId = database.createAccount({
      platformId: 'xiaohongshu',
      alias: '计划测试账号',
      syncMode: 'profile_only'
    }).id
    host.grant({
      pluginId: xiaohongshuPluginManifestV2.id,
      contributionId: XIAOHONGSHU_PLATFORM_CONTRIBUTION_ID,
      permissions: ['scheduler.run'],
      accountIds: [accountId],
      groupIds: [],
      dataScopes: [],
      networkOrigins: []
    })
  })

  afterEach(() => database.close())

  it('creates and re-enables a local-time daily schedule', () => {
    const schedule = host.createSchedule({
      pluginId: xiaohongshuPluginManifestV2.id,
      contributionId: XIAOHONGSHU_PLATFORM_CONTRIBUTION_ID,
      accountIds: [accountId],
      groupIds: [],
      cadence: { type: 'daily', time: '09:30' },
      enabled: true
    })

    expect(schedule).toMatchObject({
      cadence: { type: 'daily', time: '09:30' },
      intervalMinutes: 1440,
      enabled: true
    })
    expect(schedule.nextRunAt).not.toBeNull()
    expect(new Date(schedule.nextRunAt!).getTime()).toBeGreaterThan(Date.now())
    expect([
      new Date(schedule.nextRunAt!).getHours(),
      new Date(schedule.nextRunAt!).getMinutes()
    ]).toEqual([9, 30])

    expect(host.updateSchedule(schedule.id, false)).toMatchObject({
      enabled: false,
      nextRunAt: null
    })
    const enabled = host.updateSchedule(schedule.id, true)
    expect(enabled.enabled).toBe(true)
    expect(new Date(enabled.nextRunAt!).getTime()).toBeGreaterThan(Date.now())
    expect(new Date(enabled.nextRunAt!).getHours()).toBe(9)
  })

  it('keeps legacy interval input and enforces the contribution minimum', () => {
    const common = {
      pluginId: xiaohongshuPluginManifestV2.id,
      contributionId: XIAOHONGSHU_PLATFORM_CONTRIBUTION_ID,
      accountIds: [accountId],
      groupIds: [],
      enabled: false
    }
    expect(host.createSchedule({ ...common, intervalMinutes: 60 })).toMatchObject({
      cadence: { type: 'interval', intervalMinutes: 60 }
    })
    expect(() => host.createSchedule({
      ...common,
      cadence: { type: 'interval', intervalMinutes: 30 }
    })).toThrow('最短间隔不能少于 60 分钟')
  })
})
