import { describe, expect, it } from 'vitest'
import { ExtensionRegistry } from './extension-registry'

describe('ExtensionRegistry', () => {
  it('exposes built-in platforms through manifest v2 contributions', () => {
    const registry = new ExtensionRegistry()
    expect(registry.listManifests().map((item) => item.id)).toEqual([
      'xiaohongshu-session-api',
      'zhihu-session-api'
    ])
    expect(registry.platformDefinitions().map((item) => item.id)).toEqual(['xiaohongshu', 'zhihu'])
  })

  it('returns defensive copies', () => {
    const registry = new ExtensionRegistry()
    const manifest = registry.listManifests()[0]!
    manifest.name = 'changed'
    expect(registry.listManifests()[0]!.name).not.toBe('changed')
  })
})
