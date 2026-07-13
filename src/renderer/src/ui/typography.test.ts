/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const rendererStyleSheets = [
  'style.css',
  'features.css',
  'theme.css',
  'browser.css'
] as const

describe('renderer typography', () => {
  it('defines the shared readable type scale', () => {
    const theme = readFileSync(new URL('../theme.css', import.meta.url), 'utf8')

    expect(theme).toContain('--font-caption: 12px')
    expect(theme).toContain('--font-body: 14px')
    expect(theme).toContain('--font-ui: 15px')
    expect(theme).toContain('--font-page: 28px')
  })

  it.each(rendererStyleSheets)('keeps functional text at least 12px in %s', (fileName) => {
    const css = readFileSync(new URL(`../${fileName}`, import.meta.url), 'utf8')

    expect(css).not.toMatch(/font-size:\s*(?:[1-9]|10|11)px\b/)
  })
})
