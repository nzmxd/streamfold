import { describe, expect, it } from 'vitest'
import { contentQueryFromFilters, reconcileContentSelection } from './query'

describe('content query helpers', () => {
  it('omits empty filters and trims the search term', () => {
    expect(contentQueryFromFilters({
      search: '  选题复盘  ', accountId: '', platformId: '', type: 'article'
    })).toEqual({ limit: 500, query: '选题复盘', type: 'article' })
  })

  it('expands date inputs to inclusive UTC day boundaries', () => {
    expect(contentQueryFromFilters({
      search: '', accountId: 'account-1', platformId: '', type: '',
      from: '2026-07-01', to: '2026-07-13'
    })).toEqual({
      limit: 500,
      accountId: 'account-1',
      from: '2026-07-01T00:00:00.000Z',
      to: '2026-07-13T23:59:59.999Z'
    })
  })

  it('keeps a visible selection and otherwise selects the first result', () => {
    const items = [{ id: 'first' }, { id: 'second' }]
    expect(reconcileContentSelection(items, 'second')).toBe('second')
    expect(reconcileContentSelection(items, 'missing')).toBe('first')
    expect(reconcileContentSelection([], 'missing')).toBeNull()
  })
})
