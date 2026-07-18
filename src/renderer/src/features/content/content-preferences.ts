import {
  contentSearchSorts,
  type ContentSearchOrder,
  type ContentSearchSort
} from '../../../../shared/contracts'

export const CONTENT_SORT_PREFERENCES_STORAGE_KEY = 'streamfold:content-sort-preferences:v1'
export const ALL_CONTENT_ACCOUNTS_PREFERENCE_KEY = '__all__'

const DEFAULT_CONTENT_SORT_PREFERENCE: ContentSortPreference = {
  sort: 'published',
  order: 'desc'
}
const supportedSorts = new Set<ContentSearchSort>(contentSearchSorts)

export interface ContentSortPreference {
  sort: ContentSearchSort
  order: ContentSearchOrder
}

export interface ContentPreferenceStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export function normalizeContentSortPreference(value: unknown): ContentSortPreference {
  if (!isRecord(value) || !supportedSorts.has(value.sort as ContentSearchSort)) {
    return { ...DEFAULT_CONTENT_SORT_PREFERENCE }
  }
  const sort = value.sort as ContentSearchSort
  const order = value.order === 'asc' || value.order === 'desc' ? value.order : 'desc'
  return { sort, order: sort === 'relevance' ? 'asc' : order }
}

export function parseContentSortPreferences(value: string | null): Record<string, ContentSortPreference> {
  if (!value) return {}
  try {
    const parsed: unknown = JSON.parse(value)
    if (!isRecord(parsed)) return {}
    const result: Record<string, ContentSortPreference> = {}
    for (const [key, preference] of Object.entries(parsed)) {
      if (!isPreferenceKey(key) || !isContentSortPreference(preference)) continue
      result[key] = normalizeContentSortPreference(preference)
    }
    return result
  } catch {
    return {}
  }
}

export function readContentSortPreference(
  accountId: string,
  storage: ContentPreferenceStorage | null = browserContentPreferenceStorage()
): ContentSortPreference {
  if (!storage) return { ...DEFAULT_CONTENT_SORT_PREFERENCE }
  try {
    const preferences = parseContentSortPreferences(
      storage.getItem(CONTENT_SORT_PREFERENCES_STORAGE_KEY)
    )
    return preferences[preferenceKey(accountId)] ?? { ...DEFAULT_CONTENT_SORT_PREFERENCE }
  } catch {
    return { ...DEFAULT_CONTENT_SORT_PREFERENCE }
  }
}

export function persistContentSortPreference(
  accountId: string,
  preference: ContentSortPreference,
  storage: ContentPreferenceStorage | null = browserContentPreferenceStorage()
): ContentSortPreference {
  const normalized = normalizeContentSortPreference(preference)
  if (!storage) return normalized
  try {
    const preferences = parseContentSortPreferences(
      storage.getItem(CONTENT_SORT_PREFERENCES_STORAGE_KEY)
    )
    preferences[preferenceKey(accountId)] = normalized
    storage.setItem(CONTENT_SORT_PREFERENCES_STORAGE_KEY, JSON.stringify(preferences))
  } catch {
    // The current content view remains usable when local storage is unavailable.
  }
  return normalized
}

function preferenceKey(accountId: string): string {
  const key = accountId.trim()
  return isPreferenceKey(key) ? key : ALL_CONTENT_ACCOUNTS_PREFERENCE_KEY
}

function isPreferenceKey(value: string): boolean {
  const key = value.trim()
  return Boolean(key) && key.length <= 80 && key !== '__proto__' &&
    key !== 'prototype' && key !== 'constructor'
}

function isContentSortPreference(value: unknown): value is ContentSortPreference {
  return isRecord(value) && supportedSorts.has(value.sort as ContentSearchSort) &&
    (value.order === 'asc' || value.order === 'desc')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function browserContentPreferenceStorage(): ContentPreferenceStorage | null {
  try {
    return typeof window === 'object' ? window.localStorage : null
  } catch {
    return null
  }
}
