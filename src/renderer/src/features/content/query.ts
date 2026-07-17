import type {
  ContentSearchQuery,
  ContentSearchOrder,
  ContentSearchSort,
  ContentTagFacetQuery,
  ContentTagMatch,
  ContentType,
  PlatformId
} from '../../../../shared/contracts'

export type BookmarkFilter = 'all' | 'bookmarked' | 'unbookmarked'

export interface ContentSearchFilters {
  keyword: string
  accountId: string
  platformId: '' | PlatformId
  groupId: string
  type: '' | ContentType
  tags: string[]
  tagMatch: ContentTagMatch
  bookmark: BookmarkFilter
  publishedFrom: string
  publishedTo: string
  capturedFrom: string
  capturedTo: string
  sort: ContentSearchSort
  order: ContentSearchOrder
  pageSize: number
}

export interface PaginationRange {
  page: number
  pageCount: number
  first: number
  last: number
}

export function createDefaultContentSearchFilters(): ContentSearchFilters {
  return {
    keyword: '',
    accountId: '',
    platformId: '',
    groupId: '',
    type: '',
    tags: [],
    tagMatch: 'all',
    bookmark: 'all',
    publishedFrom: '',
    publishedTo: '',
    capturedFrom: '',
    capturedTo: '',
    sort: 'published',
    order: 'desc',
    pageSize: 50
  }
}

export function contentSearchQueryFromFilters(
  filters: ContentSearchFilters,
  offset = 0
): ContentSearchQuery {
  const query: ContentSearchQuery = {
    sort: filters.sort,
    order: filters.sort === 'relevance' ? 'asc' : filters.order,
    limit: normalizePageSize(filters.pageSize),
    offset: Math.max(0, Math.trunc(offset))
  }
  const keyword = filters.keyword.trim()
  const tags = normalizeTags(filters.tags)
  if (keyword) query.keyword = keyword
  if (filters.accountId) query.accountIds = [filters.accountId]
  if (filters.platformId) query.platformId = filters.platformId
  if (filters.groupId) query.groupId = filters.groupId
  if (filters.type) query.type = filters.type
  if (tags.length > 0) {
    query.tags = tags
    query.tagMatch = filters.tagMatch
  }
  if (filters.bookmark !== 'all') query.bookmarked = filters.bookmark === 'bookmarked'
  if (isDateInput(filters.publishedFrom)) query.publishedFrom = startOfDay(filters.publishedFrom)
  if (isDateInput(filters.publishedTo)) query.publishedTo = endOfDay(filters.publishedTo)
  if (isDateInput(filters.capturedFrom)) query.capturedFrom = startOfDay(filters.capturedFrom)
  if (isDateInput(filters.capturedTo)) query.capturedTo = endOfDay(filters.capturedTo)
  return query
}

export function contentTagFacetQueryFromFilters(
  filters: Pick<ContentSearchFilters, 'accountId' | 'platformId' | 'groupId'>,
  search = ''
): ContentTagFacetQuery {
  const query: ContentTagFacetQuery = { limit: 40 }
  const keyword = search.trim()
  if (keyword) query.search = keyword
  if (filters.accountId) query.accountIds = [filters.accountId]
  if (filters.platformId) query.platformId = filters.platformId
  if (filters.groupId) query.groupId = filters.groupId
  return query
}

export function tagsFromInput(value: string): string[] {
  return normalizeTags(value.split(/[,，]/))
}

export function tagsToInput(tags: readonly string[]): string {
  return normalizeTags(tags).join(', ')
}

export function toggleSelectedTag(tags: readonly string[], tag: string): string[] {
  const normalizedTag = tag.trim()
  if (!normalizedTag) return normalizeTags(tags)
  const normalized = normalizeTags(tags)
  const index = normalized.findIndex((item) => item.localeCompare(normalizedTag, 'zh-CN', {
    sensitivity: 'accent'
  }) === 0)
  return index >= 0
    ? normalized.filter((_item, itemIndex) => itemIndex !== index)
    : [...normalized, normalizedTag]
}

export function paginationRange(total: number, offset: number, limit: number): PaginationRange {
  const normalizedTotal = Math.max(0, Math.trunc(total))
  const normalizedLimit = normalizePageSize(limit)
  const pageCount = Math.max(1, Math.ceil(normalizedTotal / normalizedLimit))
  const normalizedOffset = Math.min(
    Math.max(0, Math.trunc(offset)),
    (pageCount - 1) * normalizedLimit
  )
  const page = Math.floor(normalizedOffset / normalizedLimit) + 1
  return {
    page,
    pageCount,
    first: normalizedTotal === 0 ? 0 : normalizedOffset + 1,
    last: Math.min(normalizedTotal, normalizedOffset + normalizedLimit)
  }
}

export function reconcileContentSelection<T extends { id: string }>(
  items: T[],
  selectedId: string | null
): string | null {
  if (selectedId && items.some((item) => item.id === selectedId)) return selectedId
  return items[0]?.id ?? null
}

export function reconcilePageSelection<T extends { id: string }>(
  items: readonly T[],
  selectedIds: readonly string[]
): string[] {
  const visibleIds = new Set(items.map((item) => item.id))
  return [...new Set(selectedIds)].filter((id) => visibleIds.has(id))
}

function normalizeTags(tags: readonly string[]): string[] {
  const result: string[] = []
  const seen = new Set<string>()
  for (const value of tags) {
    const tag = value.trim()
    const key = tag.toLocaleLowerCase('zh-CN')
    if (!tag || seen.has(key)) continue
    seen.add(key)
    result.push(tag)
  }
  return result
}

function normalizePageSize(value: number): number {
  if (!Number.isFinite(value)) return 50
  return Math.min(100, Math.max(1, Math.trunc(value)))
}

function isDateInput(value: string | undefined): value is string {
  return Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value))
}

function startOfDay(value: string): string {
  return localDayBoundary(value, false)
}

function endOfDay(value: string): string {
  return localDayBoundary(value, true)
}

function localDayBoundary(value: string, end: boolean): string {
  const [year, month, day] = value.split('-').map(Number)
  return new Date(
    year!,
    month! - 1,
    day!,
    end ? 23 : 0,
    end ? 59 : 0,
    end ? 59 : 0,
    end ? 999 : 0
  ).toISOString()
}
