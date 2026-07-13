import { readonly, ref } from 'vue'
import type {
  AppearanceApi,
  AppearanceState,
  ResolvedTheme,
  ThemePreference
} from '../../../shared/contracts'

const STORAGE_KEY = 'streamfold:appearance'
const preference = ref<ThemePreference>('system')
const resolved = ref<ResolvedTheme>('light')
let initialized = false
let removeAppearanceListener: (() => void) | null = null

function systemTheme(): ResolvedTheme {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function storedPreference(): ThemePreference {
  const value = window.localStorage.getItem(STORAGE_KEY)
  return value === 'light' || value === 'dark' || value === 'system' ? value : 'system'
}

function apply(state: AppearanceState): void {
  preference.value = state.preference
  resolved.value = state.resolved
  window.localStorage.setItem(STORAGE_KEY, state.preference)
  document.documentElement.dataset.theme = state.resolved
  document.documentElement.style.colorScheme = state.resolved
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
  apply({ preference: saved, resolved: saved === 'system' ? systemTheme() : saved })

  removeAppearanceListener = api().onChanged(apply)
  const initial = saved === 'system' ? api().get() : api().set(saved)
  void initial.then(apply).catch(() => {
    // The optimistic local theme remains usable if the native shell is unavailable.
  })
}

export async function setTheme(value: ThemePreference): Promise<void> {
  window.localStorage.setItem(STORAGE_KEY, value)
  apply({ preference: value, resolved: value === 'system' ? systemTheme() : value })
  try {
    apply(await api().set(value))
  } catch {
    // Keep the renderer preference; the next launch retries native synchronization.
  }
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
    setTheme
  }
}
