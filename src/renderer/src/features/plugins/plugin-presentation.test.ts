import { describe, expect, it } from 'vitest'
import type { PluginContribution } from '../../../../shared/contracts'
import {
  defaultScheduleMinutes,
  minimumScheduleMinutes,
  packageCanBeEnabled,
  permissionLabel
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
})
