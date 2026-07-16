import { describe, expect, it } from 'vitest'
import { normalizeRendererError } from './renderer-error'

describe('renderer error normalization', () => {
  it('keeps structured rejection diagnostics instead of coercing objects', () => {
    expect(normalizeRendererError({
      message: '同步失败',
      code: 'SYNC_REJECTED',
      stack: 'Error: 同步失败',
      retryAfterSeconds: 30
    })).toMatchObject({
      message: '同步失败',
      code: 'SYNC_REJECTED',
      stack: 'Error: 同步失败',
      details: expect.stringContaining('retryAfterSeconds')
    })
  })

  it('serializes message-less and circular objects safely', () => {
    const rejection: Record<string, unknown> = { reason: 'offline' }
    rejection.self = rejection
    const normalized = normalizeRendererError(rejection)
    expect(normalized.message).toContain('offline')
    expect(normalized.message).toContain('[Circular]')
    expect(normalized.message).not.toBe('[object Object]')
  })
})
