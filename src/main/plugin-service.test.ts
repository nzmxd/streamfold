import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SocialDatabase } from './database'
import { PluginService } from './plugin-service'

describe('PluginService', () => {
  let database: SocialDatabase
  let service: PluginService

  beforeEach(() => {
    database = new SocialDatabase(':memory:')
    service = new PluginService(database)
    service.initialize()
  })

  afterEach(() => database.close())

  it('enables only available audited plugins', () => {
    const plugins = service.list()
    expect(plugins).toHaveLength(5)
    expect(plugins.find((plugin) => plugin.manifest.id === 'generic-file-import'))
      .toMatchObject({ enabled: true, availability: 'available' })
    expect(plugins.filter((plugin) => plugin.availability === 'planned').every((plugin) => !plugin.enabled))
      .toBe(true)
    expect(service.setEnabled('xiaohongshu-managed-browser', true)).toMatchObject({
      enabled: true, availability: 'available'
    })
    expect(() => service.setEnabled('weibo-managed-browser', true)).toThrow('计划中的插件不能启用')
  })

  it('persists the user toggle for the available plugin', () => {
    expect(service.setEnabled('generic-file-import', false).enabled).toBe(false)
    service.initialize()
    expect(service.list().find((plugin) => plugin.manifest.id === 'generic-file-import')?.enabled).toBe(false)
  })
})
