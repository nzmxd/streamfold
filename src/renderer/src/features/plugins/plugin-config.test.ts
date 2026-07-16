import { describe, expect, it } from 'vitest'
import { cloneConfigValue, cloneConfigValues, initialConfigValue } from './plugin-config'

describe('plugin config serialization', () => {
  it('copies proxied array defaults into values that Electron can clone', () => {
    const reactiveDefault = new Proxy(['account', 'profile'], {})

    const cloned = cloneConfigValue(reactiveDefault)

    expect(cloned).toEqual(['account', 'profile'])
    expect(cloned).not.toBe(reactiveDefault)
    expect(() => structuredClone(cloned)).not.toThrow()
  })

  it('removes undefined fields and recursively copies values before IPC', () => {
    const reactiveFields = new Proxy(['account', 'content'], {})

    const cloned = cloneConfigValues({ fields: reactiveFields, omitted: undefined, enabled: true })

    expect(cloned).toEqual({ fields: ['account', 'content'], enabled: true })
    expect(() => structuredClone(cloned)).not.toThrow()
  })

  it('shows a numeric plugin default until a persisted collection interval exists', () => {
    const property = {
      type: 'integer' as const,
      title: '手动采集间隔（分钟）',
      default: 5,
      minimum: 5,
      maximum: 1440
    }

    expect(initialConfigValue(property, undefined)).toBe(5)
    expect(initialConfigValue(property, 30)).toBe(30)
  })
})
