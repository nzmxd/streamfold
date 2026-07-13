import { describe, expect, it } from 'vitest'
import { delta, deltaLabel, formatNumber, messageOf } from './format'

describe('metric delta presentation', () => {
  it('distinguishes an unavailable comparison from zero change', () => {
    expect(delta(12, null)).toBeNull()
    expect(delta(12, 12)).toBe(0)
    expect(deltaLabel(null)).toBe('暂无对比')
    expect(deltaLabel(0)).toBe('与上次持平')
    expect(deltaLabel(5)).toContain('+5')
  })
})

describe('profile metric presentation', () => {
  it('keeps a real zero distinct from unavailable data', () => {
    expect(formatNumber(0)).toBe('0')
    expect(formatNumber(null)).toBe('—')
    expect(formatNumber(undefined)).toBe('—')
  })
})

describe('renderer error presentation', () => {
  it('removes Electron IPC implementation details from account errors', () => {
    expect(messageOf(new Error(
      "Error invoking remote method 'accounts:sync': Error: 小红书 API 暂时无法连接，请稍后重试"
    ))).toBe('小红书 API 暂时无法连接，请稍后重试')
  })
})
