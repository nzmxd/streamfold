import type { ContentQuery, ContentType, PlatformId } from '../../../../shared/contracts'

export interface ContentFilters {
  search: string
  accountId: string
  platformId: '' | PlatformId
  type: '' | ContentType
  from?: string
  to?: string
  limit?: number
}

export function contentQueryFromFilters(filters: ContentFilters): ContentQuery {
  const query: ContentQuery = { limit: filters.limit ?? 500 }
  const keyword = filters.search.trim()
  if (keyword) query.query = keyword
  if (filters.accountId) query.accountId = filters.accountId
  if (filters.platformId) query.platformId = filters.platformId
  if (filters.type) query.type = filters.type
  if (isDateInput(filters.from)) query.from = `${filters.from}T00:00:00.000Z`
  if (isDateInput(filters.to)) query.to = `${filters.to}T23:59:59.999Z`
  return query
}

function isDateInput(value: string | undefined): value is string {
  return Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value))
}

export function reconcileContentSelection<T extends { id: string }>(
  items: T[],
  selectedId: string | null
): string | null {
  if (selectedId && items.some((item) => item.id === selectedId)) return selectedId
  return items[0]?.id ?? null
}
