import { describe, expect, it } from 'vitest'
import { delta, deltaLabel } from './format'

describe('metric delta presentation', () => {
  it('distinguishes an unavailable comparison from zero change', () => {
    expect(delta(12, null)).toBeNull()
    expect(delta(12, 12)).toBe(0)
    expect(deltaLabel(null)).toBe('暂无对比')
    expect(deltaLabel(0)).toBe('与上次持平')
    expect(deltaLabel(5)).toContain('+5')
  })
})
