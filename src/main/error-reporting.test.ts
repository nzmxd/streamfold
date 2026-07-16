import { describe, expect, it } from 'vitest'
import { markErrorReported, wasErrorReported } from './error-reporting'

describe('error reporting deduplication', () => {
  it('marks error objects without treating primitive messages as shared failures', () => {
    const error = new Error('failed')
    expect(wasErrorReported(error)).toBe(false)
    markErrorReported(error)
    expect(wasErrorReported(error)).toBe(true)
    markErrorReported('failed')
    expect(wasErrorReported('failed')).toBe(false)
  })
})
