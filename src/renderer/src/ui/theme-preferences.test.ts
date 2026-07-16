import { describe, expect, it } from 'vitest'
import { parseDensityPreference, parseFontSizePreference } from './theme'

describe('renderer appearance preferences', () => {
  it('restores supported font sizes and falls back to the standard scale', () => {
    expect(parseFontSizePreference('small')).toBe('small')
    expect(parseFontSizePreference('standard')).toBe('standard')
    expect(parseFontSizePreference('large')).toBe('large')
    expect(parseFontSizePreference('oversized')).toBe('standard')
    expect(parseFontSizePreference(null)).toBe('standard')
  })

  it('uses compact desktop density unless a comfortable layout was saved', () => {
    expect(parseDensityPreference('comfortable')).toBe('comfortable')
    expect(parseDensityPreference('compact')).toBe('compact')
    expect(parseDensityPreference('dense')).toBe('compact')
    expect(parseDensityPreference(null)).toBe('compact')
  })
})
