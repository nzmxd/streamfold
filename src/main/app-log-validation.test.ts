import { describe, expect, it } from 'vitest'
import { parseAppLogQuery, parseRendererErrorLog } from './validation'

describe('app log validation', () => {
  it('normalizes supported filters', () => {
    expect(parseAppLogQuery({
      level: 'error',
      scope: 'sync',
      search: 'content_token',
      limit: 250
    })).toEqual({ level: 'error', scope: 'sync', search: 'content_token', limit: 250 })
  })

  it('rejects unsupported levels and excessive limits', () => {
    expect(() => parseAppLogQuery({ level: 'fatal' })).toThrow('日志级别无效')
    expect(() => parseAppLogQuery({ limit: 2_001 })).toThrow('日志数量无效')
  })

  it('accepts bounded renderer diagnostics and rejects unknown sources', () => {
    expect(parseRendererErrorLog({
      message: 'render failed',
      source: 'vue',
      code: 'RENDER_FAILED',
      stack: 'Error: render failed',
      details: '{"phase":"render"}',
      file: 'app://shell/assets/index.js',
      line: 12,
      column: 4,
      componentInfo: 'render function'
    })).toMatchObject({ source: 'vue', code: 'RENDER_FAILED', line: 12, column: 4 })
    expect(() => parseRendererErrorLog({ message: 'x', source: 'console' }))
      .toThrow('渲染错误来源无效')
  })
})
