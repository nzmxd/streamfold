import { describe, expect, it, vi } from 'vitest'
import {
  ALL_CONTENT_ACCOUNTS_PREFERENCE_KEY,
  CONTENT_SORT_PREFERENCES_STORAGE_KEY,
  normalizeContentSortPreference,
  parseContentSortPreferences,
  persistContentSortPreference,
  readContentSortPreference,
  type ContentPreferenceStorage
} from './content-preferences'

describe('content sort preferences', () => {
  it('keeps account and all-content sorting independent', () => {
    const storage = memoryStorage()

    persistContentSortPreference('', { sort: 'captured', order: 'asc' }, storage)
    persistContentSortPreference('account-1', { sort: 'views', order: 'desc' }, storage)

    expect(readContentSortPreference('', storage)).toEqual({ sort: 'captured', order: 'asc' })
    expect(readContentSortPreference('account-1', storage)).toEqual({ sort: 'views', order: 'desc' })
    expect(readContentSortPreference('account-2', storage)).toEqual({ sort: 'published', order: 'desc' })
    expect(parseContentSortPreferences(storage.value())).toHaveProperty(
      ALL_CONTENT_ACCOUNTS_PREFERENCE_KEY
    )
  })

  it('canonicalizes relevance order and safely ignores unknown stored values', () => {
    const storage = memoryStorage({
      [CONTENT_SORT_PREFERENCES_STORAGE_KEY]: JSON.stringify({
        valid: { sort: 'relevance', order: 'desc' },
        unknown: { sort: 'popularity', order: 'desc' },
        malformed: { sort: 'views', order: 'sideways' }
      })
    })

    expect(readContentSortPreference('valid', storage)).toEqual({ sort: 'relevance', order: 'asc' })
    expect(readContentSortPreference('unknown', storage)).toEqual({ sort: 'published', order: 'desc' })
    expect(readContentSortPreference('malformed', storage)).toEqual({ sort: 'published', order: 'desc' })
    expect(normalizeContentSortPreference({ sort: 'captured', order: 'asc' }))
      .toEqual({ sort: 'captured', order: 'asc' })
  })

  it('falls back for corrupt JSON and unavailable storage without throwing', () => {
    const brokenRead: ContentPreferenceStorage = {
      getItem: vi.fn(() => { throw new Error('storage disabled') }),
      setItem: vi.fn()
    }
    const brokenWrite: ContentPreferenceStorage = {
      getItem: vi.fn(() => '{broken'),
      setItem: vi.fn(() => { throw new Error('quota exceeded') })
    }

    expect(parseContentSortPreferences('{broken')).toEqual({})
    expect(readContentSortPreference('account-1', brokenRead))
      .toEqual({ sort: 'published', order: 'desc' })
    expect(() => persistContentSortPreference(
      'account-1', { sort: 'interactions', order: 'asc' }, brokenWrite
    )).not.toThrow()
    expect(persistContentSortPreference(
      'account-1', { sort: 'interactions', order: 'asc' }, null
    )).toEqual({ sort: 'interactions', order: 'asc' })
  })
})

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial))
  return {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { values.set(key, value) }),
    value: () => values.get(CONTENT_SORT_PREFERENCES_STORAGE_KEY) ?? null
  }
}
