import { describe, expect, it } from 'vitest'
import {
  GENERIC_FILE_IMPORT_PLUGIN_ID,
  PluginRegistry
} from './registry'

describe('PluginRegistry', () => {
  it('exposes audited available plugins and keeps unfinished adapters non-executable', () => {
    const registry = new PluginRegistry()
    const generic = registry.get(GENERIC_FILE_IMPORT_PLUGIN_ID)
    expect(generic).toMatchObject({
      availability: 'available',
      defaultEnabled: true,
      manifest: {
        schemaVersion: 1,
        source: 'builtin',
        readOnly: true,
        ownedAccountOnly: true,
        mode: 'file_import',
        riskLevel: 'low',
        allowedHosts: []
      }
    })
    expect(generic?.manifest.capabilities).toEqual([
      'file.import',
      'account.profile',
      'content.list',
      'content.metrics'
    ])

    const xiaohongshu = registry.get('xiaohongshu-managed-browser')
    expect(xiaohongshu).toMatchObject({
      availability: 'available',
      defaultEnabled: false,
      manifest: {
        version: '0.1.0',
        mode: 'managed_browser',
        capabilities: ['account.identity'],
        allowedHosts: ['creator.xiaohongshu.com']
      }
    })
    expect(xiaohongshu?.manifest.commitHash).toMatch(/^sha256:[a-f0-9]{64}:[a-f0-9]{64}$/)

    const planned = registry.list().filter((item) => item.availability === 'planned')
    expect(planned.map((item) => item.manifest.id)).toEqual([
      'weibo-managed-browser',
      'douyin-managed-browser',
      'zhihu-managed-browser'
    ])
    for (const adapter of planned) {
      expect(adapter.manifest.mode).toBe('managed_browser')
      expect(adapter.defaultEnabled).toBe(false)
      expect(registry.isExecutable(adapter.manifest.id)).toBe(false)
      expect(() => registry.requireExecutable(adapter.manifest.id)).toThrowError(
        expect.objectContaining({ code: 'PLUGIN_NOT_AVAILABLE' })
      )
    }
  })
})
