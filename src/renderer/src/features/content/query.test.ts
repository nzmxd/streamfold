import { describe, expect, it } from 'vitest'
import {
  contentSearchQueryFromFilters,
  contentTagFacetQueryFromFilters,
  createDefaultContentSearchFilters,
  paginationRange,
  reconcileContentSelection,
  reconcilePageSelection,
  tagsFromInput,
  tagsToInput,
  toggleSelectedTag
} from './query'

describe('content search query helpers', () => {
  it('builds a paginated query and omits empty optional filters', () => {
    const filters = createDefaultContentSearchFilters()
    filters.keyword = '  选题复盘  '
    filters.type = 'article'
    filters.pageSize = 500

    expect(contentSearchQueryFromFilters(filters, 100)).toEqual({
      keyword: '选题复盘',
      type: 'article',
      sort: 'captured',
      order: 'desc',
      limit: 100,
      offset: 100
    })
  })

  it('uses ascending BM25 rank when relevance sorting is selected', () => {
    const filters = createDefaultContentSearchFilters()
    filters.keyword = '内容增长'
    filters.sort = 'relevance'
    filters.order = 'desc'

    expect(contentSearchQueryFromFilters(filters)).toMatchObject({
      keyword: '内容增长',
      sort: 'relevance',
      order: 'asc'
    })
  })

  it('maps account, group, bookmark, tags and both date ranges', () => {
    const filters = createDefaultContentSearchFilters()
    Object.assign(filters, {
      accountId: 'account-1',
      platformId: 'zhihu',
      groupId: 'group-1',
      tags: [' 复盘 ', '增长', '复盘'],
      tagMatch: 'any',
      bookmark: 'unbookmarked',
      publishedFrom: '2026-07-01',
      publishedTo: '2026-07-13',
      capturedFrom: '2026-07-02',
      capturedTo: '2026-07-14'
    })

    expect(contentSearchQueryFromFilters(filters)).toEqual({
      sort: 'captured',
      order: 'desc',
      limit: 50,
      offset: 0,
      accountIds: ['account-1'],
      platformId: 'zhihu',
      groupId: 'group-1',
      tags: ['复盘', '增长'],
      tagMatch: 'any',
      bookmarked: false,
      publishedFrom: new Date(2026, 6, 1, 0, 0, 0, 0).toISOString(),
      publishedTo: new Date(2026, 6, 13, 23, 59, 59, 999).toISOString(),
      capturedFrom: new Date(2026, 6, 2, 0, 0, 0, 0).toISOString(),
      capturedTo: new Date(2026, 6, 14, 23, 59, 59, 999).toISOString()
    })
  })

  it('builds scoped tag facet queries independently of content pagination', () => {
    expect(contentTagFacetQueryFromFilters({
      accountId: 'account-1',
      platformId: 'xiaohongshu',
      groupId: 'group-1'
    }, '  增长 ')).toEqual({
      search: '增长',
      accountIds: ['account-1'],
      platformId: 'xiaohongshu',
      groupId: 'group-1',
      limit: 40
    })
  })

  it('normalizes editable tag input and toggles selected facets', () => {
    expect(tagsFromInput(' 复盘，增长,复盘, ')).toEqual(['复盘', '增长'])
    expect(tagsToInput([' 复盘 ', '增长', '复盘'])).toBe('复盘, 增长')
    expect(toggleSelectedTag(['复盘'], '增长')).toEqual(['复盘', '增长'])
    expect(toggleSelectedTag(['复盘', '增长'], '复盘')).toEqual(['增长'])
  })

  it('calculates stable one-based pagination ranges', () => {
    expect(paginationRange(0, 0, 50)).toEqual({ page: 1, pageCount: 1, first: 0, last: 0 })
    expect(paginationRange(121, 50, 50)).toEqual({ page: 2, pageCount: 3, first: 51, last: 100 })
    expect(paginationRange(121, 999, 50)).toEqual({ page: 3, pageCount: 3, first: 101, last: 121 })
  })

  it('reconciles active and checked selections against the visible page', () => {
    const items = [{ id: 'first' }, { id: 'second' }]
    expect(reconcileContentSelection(items, 'second')).toBe('second')
    expect(reconcileContentSelection(items, 'missing')).toBe('first')
    expect(reconcileContentSelection([], 'missing')).toBeNull()
    expect(reconcilePageSelection(items, ['second', 'hidden', 'second'])).toEqual(['second'])
  })
})
