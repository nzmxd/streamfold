import { describe, expect, it } from 'vitest'
import { normalizePlatformUserAgent } from './browser-compatibility'

const electronUserAgent = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
  'AppleWebKit/537.36 (KHTML, like Gecko)',
  'streamfold/0.4.0',
  'Chrome/150.0.0.0',
  'Electron/43.1.0',
  'Safari/537.36'
].join(' ')

const chromiumUserAgent = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
  'AppleWebKit/537.36 (KHTML, like Gecko)',
  'Chrome/150.0.0.0',
  'Safari/537.36'
].join(' ')

describe('normalizePlatformUserAgent', () => {
  it('removes only the Electron wrapper products from the Zhihu user agent', () => {
    expect(normalizePlatformUserAgent('zhihu', electronUserAgent, 'Streamfold')).toBe(chromiumUserAgent)
  })

  it('preserves the actual OS, Chrome and Safari tokens', () => {
    const normalized = normalizePlatformUserAgent('zhihu', electronUserAgent, 'Streamfold')

    expect(normalized).toContain('(Windows NT 10.0; Win64; x64)')
    expect(normalized).toContain('Chrome/150.0.0.0')
    expect(normalized).toContain('Safari/537.36')
    expect(normalized).not.toContain('streamfold/')
    expect(normalized).not.toContain('Electron/')
  })

  it('compresses excess whitespace after normalization', () => {
    expect(normalizePlatformUserAgent(
      'zhihu',
      'Mozilla/5.0   Chrome/150.0.0.0\tElectron/43.1.0\n Safari/537.36'
    )).toBe('Mozilla/5.0 Chrome/150.0.0.0 Safari/537.36')
  })

  it('does not remove tokens that merely contain the Electron name', () => {
    const value = 'Mozilla/5.0 Chrome/150.0.0.0 MyElectron/1 Electronica/2 Electron/ Safari/537.36'

    expect(normalizePlatformUserAgent('zhihu', value)).toBe(value)
  })

  it('returns other platform user agents byte-for-byte unchanged', () => {
    const value = `  ${electronUserAgent}  `

    expect(normalizePlatformUserAgent('xiaohongshu', value)).toBe(value)
    expect(normalizePlatformUserAgent('weibo', value)).toBe(value)
    expect(normalizePlatformUserAgent('douyin', value)).toBe(value)
  })

  it('falls back to the original value for empty or non-Chrome user agents', () => {
    expect(normalizePlatformUserAgent('zhihu', '')).toBe('')
    expect(normalizePlatformUserAgent('zhihu', '  ')).toBe('  ')
    expect(normalizePlatformUserAgent(
      'zhihu',
      'Mozilla/5.0 Electron/43.1.0 Safari/537.36'
    )).toBe('Mozilla/5.0 Electron/43.1.0 Safari/537.36')
  })

  it('is idempotent', () => {
    const once = normalizePlatformUserAgent('zhihu', electronUserAgent, 'Streamfold')

    expect(normalizePlatformUserAgent('zhihu', once, 'Streamfold')).toBe(once)
  })
})
