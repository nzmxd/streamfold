import { readonly, ref } from 'vue'
import type {
  AppearanceApi,
  AppearanceState,
  ResolvedTheme,
  ThemePreference
} from '../../../shared/contracts'

const STORAGE_KEY = 'streamfold:appearance'
export const FONT_SIZE_STORAGE_KEY = 'streamfold:font-size'
export const DENSITY_STORAGE_KEY = 'streamfold:density'

export type FontSizePreference = 'small' | 'standard' | 'large'
export type DensityPreference = 'compact' | 'comfortable'

const preference = ref<ThemePreference>('system')
const resolved = ref<ResolvedTheme>('light')
const fontSize = ref<FontSizePreference>('standard')
const density = ref<DensityPreference>('compact')
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

export function parseFontSizePreference(value: string | null): FontSizePreference {
  return value === 'small' || value === 'standard' || value === 'large' ? value : 'standard'
}

export function parseDensityPreference(value: string | null): DensityPreference {
  return value === 'compact' || value === 'comfortable' ? value : 'compact'
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
  writeStorage(STORAGE_KEY, state.preference)
  document.documentElement.dataset.theme = state.resolved
  document.documentElement.style.colorScheme = state.resolved
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
  applyRendererPreferences(storedFontSize(), storedDensity())
  apply({ preference: saved, resolved: saved === 'system' ? systemTheme() : saved })

  removeAppearanceListener = api().onChanged(apply)
  const initial = saved === 'system' ? api().get() : api().set(saved)
  void initial.then(apply).catch(() => {
    // The optimistic local theme remains usable if the native shell is unavailable.
  })
}

export async function setTheme(value: ThemePreference): Promise<void> {
  writeStorage(STORAGE_KEY, value)
  apply({ preference: value, resolved: value === 'system' ? systemTheme() : value })
  try {
    apply(await api().set(value))
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
    setTheme,
    setFontSize,
    setDensity
  }
}
