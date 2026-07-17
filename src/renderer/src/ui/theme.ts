import { readonly, ref } from 'vue'
import {
  DEFAULT_THEME_COLOR,
  type AppearanceApi,
  type AppearanceState,
  type ResolvedTheme,
  type ThemePreference
} from '../../../shared/contracts'

const STORAGE_KEY = 'streamfold:appearance'
export const FONT_SIZE_STORAGE_KEY = 'streamfold:font-size'
export const DENSITY_STORAGE_KEY = 'streamfold:density'
export const THEME_COLOR_STORAGE_KEY = 'streamfold:theme-color'

export type FontSizePreference = 'small' | 'standard' | 'large'
export type DensityPreference = 'compact' | 'comfortable'

export const themeColorPresets = Object.freeze([
  { value: DEFAULT_THEME_COLOR, label: '海蓝' },
  { value: '#5859de', label: '靛紫' },
  { value: '#0f8a80', label: '青绿' },
  { value: '#c2416c', label: '玫红' },
  { value: '#b65f0b', label: '琥珀' }
] as const)

export interface ThemeColorPalette {
  brand: string
  hover: string
  soft: string
  contrast: string
}

type Rgb = readonly [number, number, number]

const preference = ref<ThemePreference>('system')
const resolved = ref<ResolvedTheme>('light')
const fontSize = ref<FontSizePreference>('standard')
const density = ref<DensityPreference>('compact')
const themeColor = ref(DEFAULT_THEME_COLOR)
let initialized = false
let removeAppearanceListener: (() => void) | null = null

function systemTheme(): ResolvedTheme {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function storedPreference(): ThemePreference {
  const value = readStorage(STORAGE_KEY)
  return value === 'light' || value === 'dark' || value === 'system' ? value : 'system'
}

function storedFontSize(): FontSizePreference {
  return parseFontSizePreference(readStorage(FONT_SIZE_STORAGE_KEY))
}

function storedDensity(): DensityPreference {
  return parseDensityPreference(readStorage(DENSITY_STORAGE_KEY))
}

function storedThemeColor(): string {
  return parseThemeColor(readStorage(THEME_COLOR_STORAGE_KEY))
}

export function parseFontSizePreference(value: string | null): FontSizePreference {
  return value === 'small' || value === 'standard' || value === 'large' ? value : 'standard'
}

export function parseDensityPreference(value: string | null): DensityPreference {
  return value === 'compact' || value === 'comfortable' ? value : 'compact'
}

export function parseThemeColor(value: unknown): string {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)
    ? value.toLowerCase()
    : DEFAULT_THEME_COLOR
}

export function themeColorPalette(value: string, theme: ResolvedTheme): ThemeColorPalette {
  const selected = hexToRgb(parseThemeColor(value))
  const surface: Rgb = theme === 'dark' ? [20, 24, 33] : [255, 255, 255]
  const contrastTarget: Rgb = theme === 'dark' ? [255, 255, 255] : [0, 0, 0]
  const brand = ensureContrast(selected, surface, contrastTarget, 4.5)
  const hover = mixRgb(brand, contrastTarget, 0.12)
  const soft = mixRgb(surface, brand, theme === 'dark' ? 0.22 : 0.12)
  const lightContrast: Rgb = [255, 255, 255]
  const darkContrast: Rgb = [16, 19, 26]
  const contrast = contrastRatio(brand, lightContrast) >= contrastRatio(brand, darkContrast)
    ? lightContrast
    : darkContrast
  return {
    brand: rgbToHex(brand),
    hover: rgbToHex(hover),
    soft: rgbToHex(soft),
    contrast: rgbToHex(contrast)
  }
}

function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeStorage(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // Renderer preferences still apply for the current window.
  }
}

function apply(state: AppearanceState): void {
  preference.value = state.preference
  resolved.value = state.resolved
  themeColor.value = parseThemeColor(state.themeColor)
  writeStorage(STORAGE_KEY, state.preference)
  writeStorage(THEME_COLOR_STORAGE_KEY, themeColor.value)
  document.documentElement.dataset.theme = state.resolved
  document.documentElement.dataset.themeColor = themeColor.value.slice(1)
  document.documentElement.style.colorScheme = state.resolved
  const palette = themeColorPalette(themeColor.value, state.resolved)
  document.documentElement.style.setProperty('--brand', palette.brand)
  document.documentElement.style.setProperty('--brand-hover', palette.hover)
  document.documentElement.style.setProperty('--brand-soft', palette.soft)
  document.documentElement.style.setProperty('--brand-contrast', palette.contrast)
  document.documentElement.style.setProperty('--surface-active', palette.soft)
}

function applyRendererPreferences(
  nextFontSize: FontSizePreference,
  nextDensity: DensityPreference
): void {
  fontSize.value = nextFontSize
  density.value = nextDensity
  document.documentElement.dataset.fontSize = nextFontSize
  document.documentElement.dataset.density = nextDensity
}

function api(): AppearanceApi {
  if (typeof window.socialVault === 'object') return window.socialVault.appearance
  return window.browserWorkspace.appearance
}

export function initializeTheme(): void {
  if (initialized) return
  initialized = true

  const bridge = typeof window.socialVault === 'object' ? window.socialVault : window.browserWorkspace
  document.documentElement.dataset.platform = bridge.runtime.platform

  const saved = storedPreference()
  const savedThemeColor = storedThemeColor()
  applyRendererPreferences(storedFontSize(), storedDensity())
  apply({
    preference: saved,
    resolved: saved === 'system' ? systemTheme() : saved,
    themeColor: savedThemeColor
  })

  removeAppearanceListener = api().onChanged(apply)
  const initial = saved === 'system' ? api().get() : api().set(saved)
  void initial.then(apply).catch(() => {
    // The optimistic local theme remains usable if the native shell is unavailable.
  })
}

export async function setTheme(value: ThemePreference): Promise<void> {
  writeStorage(STORAGE_KEY, value)
  apply({
    preference: value,
    resolved: value === 'system' ? systemTheme() : value,
    themeColor: themeColor.value
  })
  try {
    apply(await api().set(value))
  } catch {
    // Keep the renderer preference; the next launch retries native synchronization.
  }
}

export async function setThemeColor(value: string): Promise<void> {
  const next = parseThemeColor(value)
  writeStorage(THEME_COLOR_STORAGE_KEY, next)
  apply({ preference: preference.value, resolved: resolved.value, themeColor: next })
  try {
    apply(await api().setThemeColor(next))
  } catch {
    // Keep the renderer preference; the next launch retries native synchronization.
  }
}

export function setFontSize(value: FontSizePreference): void {
  writeStorage(FONT_SIZE_STORAGE_KEY, value)
  applyRendererPreferences(value, density.value)
}

export function setDensity(value: DensityPreference): void {
  writeStorage(DENSITY_STORAGE_KEY, value)
  applyRendererPreferences(fontSize.value, value)
}

export function disposeTheme(): void {
  removeAppearanceListener?.()
  removeAppearanceListener = null
  initialized = false
}

export function useTheme() {
  return {
    preference: readonly(preference),
    resolved: readonly(resolved),
    fontSize: readonly(fontSize),
    density: readonly(density),
    themeColor: readonly(themeColor),
    setTheme,
    setThemeColor,
    setFontSize,
    setDensity
  }
}

function hexToRgb(value: string): Rgb {
  return [
    Number.parseInt(value.slice(1, 3), 16),
    Number.parseInt(value.slice(3, 5), 16),
    Number.parseInt(value.slice(5, 7), 16)
  ]
}

function rgbToHex(value: Rgb): string {
  return `#${value.map((channel) => Math.round(channel).toString(16).padStart(2, '0')).join('')}`
}

function mixRgb(from: Rgb, to: Rgb, amount: number): Rgb {
  return [
    from[0] + (to[0] - from[0]) * amount,
    from[1] + (to[1] - from[1]) * amount,
    from[2] + (to[2] - from[2]) * amount
  ]
}

function ensureContrast(foreground: Rgb, background: Rgb, target: Rgb, minimum: number): Rgb {
  if (contrastRatio(foreground, background) >= minimum) return foreground
  for (let amount = 0.04; amount <= 1; amount += 0.04) {
    const candidate = mixRgb(foreground, target, amount)
    if (contrastRatio(candidate, background) >= minimum) return candidate
  }
  return target
}

function contrastRatio(left: Rgb, right: Rgb): number {
  const first = relativeLuminance(left)
  const second = relativeLuminance(right)
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05)
}

function relativeLuminance(value: Rgb): number {
  const [red, green, blue] = value.map((channel) => {
    const normalized = channel / 255
    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4
  })
  return red! * 0.2126 + green! * 0.7152 + blue! * 0.0722
}
