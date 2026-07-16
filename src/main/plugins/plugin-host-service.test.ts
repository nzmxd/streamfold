import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SocialDatabase } from '../database'
import {
  MANUAL_COLLECTION_INTERVAL_MINUTES_CONFIG_KEY,
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
    accountId = database.createAccount({
      platformId: 'xiaohongshu',
      alias: '计划测试账号',
      syncMode: 'profile_only'
    }).id
    host = new PluginHostService(database, {
      available: () => true,
      encrypt: (value) => value,
      decrypt: (value) => value
    })
    host.initialize()
  })

  afterEach(() => database.close())

  it('enables and grants fresh built-in adapters, then persists a validated manual collection interval', () => {
    expect(host.listPackages().every((plugin) => plugin.enabled)).toBe(true)
    expect(host.listContributions().find((item) => (
      item.pluginId === xiaohongshuPluginManifestV2.id
        && item.contribution.id === XIAOHONGSHU_PLATFORM_CONTRIBUTION_ID
    ))).toMatchObject({ enabled: true, granted: true })
    expect(host.getGrant(
      xiaohongshuPluginManifestV2.id,
      XIAOHONGSHU_PLATFORM_CONTRIBUTION_ID
    )).toMatchObject({
      permissions: ['platform.session-json', 'scheduler.run'],
      accountIds: [accountId]
    })
    expect(host.requireEnabledSessionApi(xiaohongshuPluginManifestV2.id, accountId))
      .toEqual({ manualCollectionIntervalSeconds: 60 })

    expect(host.saveConfig({
      pluginId: xiaohongshuPluginManifestV2.id,
      contributionId: XIAOHONGSHU_PLATFORM_CONTRIBUTION_ID,
      values: { [MANUAL_COLLECTION_INTERVAL_MINUTES_CONFIG_KEY]: 15 }
    }).values).toEqual({ [MANUAL_COLLECTION_INTERVAL_MINUTES_CONFIG_KEY]: 15 })
    expect(host.requireEnabledSessionApi(xiaohongshuPluginManifestV2.id, accountId))
      .toEqual({ manualCollectionIntervalSeconds: 15 * 60 })

    const laterAccount = database.createAccount({
      platformId: 'xiaohongshu',
      alias: '默认授权账号',
      syncMode: 'profile_only'
    })
    expect(host.getGrant(
      xiaohongshuPluginManifestV2.id,
      XIAOHONGSHU_PLATFORM_CONTRIBUTION_ID
    )?.accountIds).toEqual([accountId, laterAccount.id])
    expect(host.requireEnabledSessionApi(xiaohongshuPluginManifestV2.id, laterAccount.id))
      .toEqual({ manualCollectionIntervalSeconds: 15 * 60 })

    for (const invalid of [0, 1.5, 24 * 60 + 1]) {
      expect(() => host.saveConfig({
        pluginId: xiaohongshuPluginManifestV2.id,
        contributionId: XIAOHONGSHU_PLATFORM_CONTRIBUTION_ID,
        values: { [MANUAL_COLLECTION_INTERVAL_MINUTES_CONFIG_KEY]: invalid }
      })).toThrow('插件配置 manualCollectionIntervalMinutes')
    }
  })

  it('does not re-enable or widen explicitly changed built-in state', () => {
    host.grant({
      pluginId: xiaohongshuPluginManifestV2.id,
      contributionId: XIAOHONGSHU_PLATFORM_CONTRIBUTION_ID,
      permissions: ['platform.session-json'],
      accountIds: [accountId],
      groupIds: [],
      dataScopes: [],
      networkOrigins: []
    })
    host.setPackageEnabled(xiaohongshuPluginManifestV2.id, false)

    host.initialize()

    expect(host.listPackages().find((item) => item.manifest.id === xiaohongshuPluginManifestV2.id)?.enabled)
      .toBe(false)
    expect(host.getGrant(
      xiaohongshuPluginManifestV2.id,
      XIAOHONGSHU_PLATFORM_CONTRIBUTION_ID
    )).toMatchObject({ permissions: ['platform.session-json'], accountIds: [accountId] })

    host.setPackageEnabled(xiaohongshuPluginManifestV2.id, true)
    host.setContributionEnabled(
      xiaohongshuPluginManifestV2.id,
      XIAOHONGSHU_PLATFORM_CONTRIBUTION_ID,
      true
    )
    const laterAccount = database.createAccount({
      platformId: 'xiaohongshu',
      alias: '稍后添加',
      syncMode: 'profile_only'
    })
    expect(() => host.requireEnabledSessionApi(xiaohongshuPluginManifestV2.id, laterAccount.id))
      .toThrow('请先授权该适配器访问此账号')
    expect(host.getGrant(
      xiaohongshuPluginManifestV2.id,
      XIAOHONGSHU_PLATFORM_CONTRIBUTION_ID
    )?.accountIds).toEqual([accountId])
  })

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
