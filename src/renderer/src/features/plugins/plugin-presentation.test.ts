import { describe, expect, it } from 'vitest'
import type { PluginContribution } from '../../../../shared/contracts'
import {
  defaultScheduleMinutes,
  minimumScheduleMinutes,
  packageCanBeEnabled,
  permissionLabel,
  scheduleCadenceLabel
} from './plugin-presentation'

describe('plugin presentation', () => {
  it('uses the host minimum and recommendation for platform schedules', () => {
    const contribution = {
      kind: 'platform.adapter',
      minimumIntervalSeconds: 120,
      recommendedSyncIntervalHours: 24
    } as PluginContribution
    expect(minimumScheduleMinutes(contribution)).toBe(60)
    expect(defaultScheduleMinutes(contribution)).toBe(1440)
  })

  it('honors scheduled task declarations', () => {
    const contribution = {
      kind: 'scheduled.task',
      minimumIntervalMinutes: 15,
      defaultIntervalMinutes: 60
    } as PluginContribution
    expect(minimumScheduleMinutes(contribution)).toBe(15)
    expect(defaultScheduleMinutes(contribution)).toBe(60)
  })

  it('does not offer enabling for security-blocked packages', () => {
    const plugin = { status: 'revoked' } as Parameters<typeof packageCanBeEnabled>[0]
    expect(packageCanBeEnabled(plugin)).toBe(false)
    expect(packageCanBeEnabled({ status: 'active' } as Parameters<typeof packageCanBeEnabled>[0])).toBe(true)
    expect(packageCanBeEnabled({ status: 'disabled' } as Parameters<typeof packageCanBeEnabled>[0])).toBe(false)
  })

  it('presents security-sensitive permissions in plain language', () => {
    expect(permissionLabel('platform.session-json')).toContain('JSON')
    expect(permissionLabel('network.https')).toContain('HTTPS')
  })

  it('presents each schedule cadence without exposing storage details', () => {
    expect(scheduleCadenceLabel({ type: 'interval', intervalMinutes: 90 })).toBe('每 90 分钟')
    expect(scheduleCadenceLabel({ type: 'interval', intervalMinutes: 1440 })).toBe('每 1 天')
    expect(scheduleCadenceLabel({ type: 'daily', time: '09:30' })).toBe('每天 09:30')
    expect(scheduleCadenceLabel({
      type: 'weekly',
      weekdays: [1, 3, 7],
      time: '18:05'
    })).toBe('每周一、三、日 18:05')
    expect(scheduleCadenceLabel({
      type: 'monthly',
      monthDays: [1, 15, 31],
      time: '08:00'
    })).toBe('每月 1、15、31 日 08:00')
    expect(scheduleCadenceLabel({
      type: 'monthly',
      monthDays: [1, 2, 3, 4, 5, 6, 7],
      time: '08:00'
    })).toBe('每月 1、2、3 等 7 天 08:00')
  })
})
