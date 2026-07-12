import { describe, expect, it } from 'vitest'
import {
  GENERIC_FILE_IMPORT_PLUGIN_ID,
  PluginRegistry
} from './registry'

describe('PluginRegistry', () => {
  it('exposes the low-risk builtin generic importer and non-executable planned adapters', () => {
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

    const planned = registry.list().filter((item) => item.availability === 'planned')
    expect(planned.map((item) => item.manifest.id)).toEqual([
      'xiaohongshu-managed-browser',
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
