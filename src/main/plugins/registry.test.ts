import { describe, expect, it } from 'vitest'
import { PluginRegistry } from './registry'

describe('PluginRegistry', () => {
  it('contains only session API adapters and exposes no file import plugin', () => {
    const registry = new PluginRegistry()
    expect(registry.get('generic-file-import')).toBeNull()
    expect(registry.get('xiaohongshu-managed-browser')).toBeNull()

    const xiaohongshu = registry.get('xiaohongshu-session-api')
    expect(xiaohongshu).toMatchObject({
      availability: 'available',
      defaultEnabled: false,
      manifest: {
        version: '0.1.0',
        mode: 'session_api',
        riskLevel: 'high',
        capabilities: [
          'account.identity',
          'account.profile',
          'account.metrics',
          'content.list',
          'content.metrics'
        ],
        allowedHosts: ['creator.xiaohongshu.com']
      }
    })
    expect(xiaohongshu?.manifest.commitHash).toContain('opencli-b0f84c99')

    const planned = registry.list().filter((item) => item.availability === 'planned')
    expect(planned.map((item) => item.manifest.id)).toEqual([
      'weibo-session-api',
      'douyin-session-api',
      'zhihu-session-api'
    ])
    expect(planned.every((item) => item.manifest.mode === 'session_api' && !item.defaultEnabled)).toBe(true)
  })
})
