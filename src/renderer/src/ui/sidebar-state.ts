import { readonly, ref, type DeepReadonly, type Ref } from 'vue'

export const SIDEBAR_COLLAPSED_STORAGE_KEY = 'streamfold:sidebar-collapsed'

export interface SidebarStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export interface SidebarState {
  collapsed: DeepReadonly<Ref<boolean>>
  setCollapsed(value: boolean): void
  toggle(): void
}

export function parseStoredSidebarCollapsed(value: string | null): boolean {
  return value === 'true' || value === '1'
}

export function readSidebarCollapsed(storage: SidebarStorage | null): boolean {
  if (!storage) return false
  try {
    return parseStoredSidebarCollapsed(storage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY))
  } catch {
    return false
  }
}

export function persistSidebarCollapsed(
  storage: SidebarStorage | null,
  collapsed: boolean
): void {
  if (!storage) return
  try {
    storage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, collapsed ? 'true' : 'false')
  } catch {
    // The in-memory UI state remains usable when local storage is unavailable.
  }
}

export function createSidebarState(
  storage: SidebarStorage | null = browserLocalStorage()
): SidebarState {
  const collapsed = ref(readSidebarCollapsed(storage))
  const setCollapsed = (value: boolean): void => {
    if (collapsed.value === value) return
    collapsed.value = value
    persistSidebarCollapsed(storage, value)
  }
  return {
    collapsed: readonly(collapsed),
    setCollapsed,
    toggle: () => setCollapsed(!collapsed.value)
  }
}

function browserLocalStorage(): SidebarStorage | null {
  try {
    return typeof window === 'object' ? window.localStorage : null
  } catch {
    return null
  }
}
