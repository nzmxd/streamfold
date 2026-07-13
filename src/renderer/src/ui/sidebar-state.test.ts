import { describe, expect, it, vi } from 'vitest'
import {
  SIDEBAR_COLLAPSED_STORAGE_KEY,
  createSidebarState,
  parseStoredSidebarCollapsed,
  persistSidebarCollapsed,
  readSidebarCollapsed,
  type SidebarStorage
} from './sidebar-state'

describe('sidebar collapse state', () => {
  it('parses only the supported persisted collapsed values', () => {
    expect(parseStoredSidebarCollapsed('true')).toBe(true)
    expect(parseStoredSidebarCollapsed('1')).toBe(true)
    expect(parseStoredSidebarCollapsed('false')).toBe(false)
    expect(parseStoredSidebarCollapsed('0')).toBe(false)
    expect(parseStoredSidebarCollapsed('TRUE')).toBe(false)
    expect(parseStoredSidebarCollapsed('invalid')).toBe(false)
    expect(parseStoredSidebarCollapsed(null)).toBe(false)
  })

  it('restores the persisted state and persists explicit changes', () => {
    const storage = memoryStorage({ [SIDEBAR_COLLAPSED_STORAGE_KEY]: 'true' })
    const state = createSidebarState(storage)

    expect(state.collapsed.value).toBe(true)
    state.setCollapsed(false)
    expect(state.collapsed.value).toBe(false)
    expect(storage.setItem).toHaveBeenCalledWith(SIDEBAR_COLLAPSED_STORAGE_KEY, 'false')

    state.toggle()
    expect(state.collapsed.value).toBe(true)
    expect(storage.setItem).toHaveBeenLastCalledWith(SIDEBAR_COLLAPSED_STORAGE_KEY, 'true')
  })

  it('does not rewrite storage when the requested state is unchanged', () => {
    const storage = memoryStorage({ [SIDEBAR_COLLAPSED_STORAGE_KEY]: 'false' })
    const state = createSidebarState(storage)

    state.setCollapsed(false)
    expect(storage.setItem).not.toHaveBeenCalled()
  })

  it('keeps a usable in-memory state when local storage is unavailable', () => {
    const storage: SidebarStorage = {
      getItem: vi.fn(() => { throw new Error('storage disabled') }),
      setItem: vi.fn(() => { throw new Error('quota exceeded') })
    }
    const state = createSidebarState(storage)

    expect(state.collapsed.value).toBe(false)
    expect(() => state.toggle()).not.toThrow()
    expect(state.collapsed.value).toBe(true)
  })

  it('uses expanded as the safe default without storage', () => {
    expect(readSidebarCollapsed(null)).toBe(false)
    expect(() => persistSidebarCollapsed(null, true)).not.toThrow()
    expect(createSidebarState(null).collapsed.value).toBe(false)
  })
})

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial))
  return {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { values.set(key, value) })
  }
}
