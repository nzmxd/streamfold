import { describe, expect, it } from 'vitest'
import { isTrustedBrowserUrl, isTrustedShellUrl } from './shell-security'

describe('isTrustedShellUrl', () => {
  it('accepts only the production shell host', () => {
    expect(isTrustedShellUrl('app://shell/index.html', undefined)).toBe(true)
    expect(isTrustedShellUrl('app://shell.evil.test/index.html', undefined)).toBe(false)
    expect(isTrustedShellUrl('https://shell/index.html', undefined)).toBe(false)
  })

  it('keeps the browser toolbar on its own local host', () => {
    expect(isTrustedBrowserUrl('app://browser/browser.html', undefined)).toBe(true)
    expect(isTrustedBrowserUrl('app://shell/index.html', undefined)).toBe(false)
  })

  it('compares development origins instead of string prefixes', () => {
    const developmentUrl = 'http://127.0.0.1:5173/'
    expect(isTrustedShellUrl('http://127.0.0.1:5173/src/main.ts', developmentUrl)).toBe(true)
    expect(isTrustedShellUrl('http://127.0.0.1:5173.evil.test/', developmentUrl)).toBe(false)
    expect(isTrustedShellUrl('http://127.0.0.1:5174/', developmentUrl)).toBe(false)
  })
})
