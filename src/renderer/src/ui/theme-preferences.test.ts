import { describe, expect, it } from 'vitest'
import { DEFAULT_THEME_COLOR } from '../../../shared/contracts'
import {
  parseDensityPreference,
  parseFontSizePreference,
  parseThemeColor,
  themeColorPalette,
  themeColorPresets
} from './theme'

describe('renderer appearance preferences', () => {
  it('uses a unique blue default theme preset', () => {
    expect(DEFAULT_THEME_COLOR).toBe('#2563eb')
    expect(themeColorPresets[0]).toEqual({ value: DEFAULT_THEME_COLOR, label: '海蓝' })
    expect(new Set(themeColorPresets.map((preset) => preset.value)).size).toBe(themeColorPresets.length)
  })

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

  it('normalizes valid custom colors and rejects corrupt stored values', () => {
    expect(parseThemeColor('#C2416C')).toBe('#c2416c')
    expect(parseThemeColor('#fff')).toBe(DEFAULT_THEME_COLOR)
    expect(parseThemeColor('purple')).toBe(DEFAULT_THEME_COLOR)
    expect(parseThemeColor(null)).toBe(DEFAULT_THEME_COLOR)
  })

  it('derives readable palettes for extreme colors in light and dark themes', () => {
    const light = themeColorPalette('#ffffff', 'light')
    const dark = themeColorPalette('#000000', 'dark')

    expect(contrastRatio(light.brand, '#ffffff')).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(light.brand, light.contrast)).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(dark.brand, '#141821')).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(dark.brand, dark.contrast)).toBeGreaterThanOrEqual(4.5)
    expect(light.soft).not.toBe(light.brand)
    expect(dark.soft).not.toBe(dark.brand)
  })
})

function contrastRatio(left: string, right: string): number {
  const first = luminance(left)
  const second = luminance(right)
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05)
}

function luminance(value: string): number {
  const channels = [1, 3, 5].map((start) => Number.parseInt(value.slice(start, start + 2), 16) / 255)
  const [red, green, blue] = channels.map((channel) => (
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  ))
  return red! * 0.2126 + green! * 0.7152 + blue! * 0.0722
}
