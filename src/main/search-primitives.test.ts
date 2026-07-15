import { describe, expect, it } from 'vitest'
import {
  CONTENT_SEARCH_LIKE_ESCAPE,
  normalizeTags,
  prepareContentSearch,
  toEscapedLikeContainsPattern,
  toFts5Literal
} from './search-primitives'

describe('content search primitives', () => {
  it('normalizes NFKC text, splits Unicode whitespace and removes duplicate terms', () => {
    expect(prepareContentSearch('  ＡＢＣ\u00a0ﬃ  ＡＢＣ  ')).toEqual({
      normalizedQuery: 'ABC ffi  ABC',
      terms: ['ABC', 'ffi'],
      longTerms: ['ABC', 'ffi'],
      shortTerms: [],
      shortTermLikePatterns: [],
      ftsExpression: '"ABC" AND "ffi"'
    })
  })

  it('keeps FTS5 operators and syntax as quoted literal text', () => {
    const prepared = prepareContentSearch('alpha OR title:beta foo* "quoted"')

    expect(prepared.longTerms).toEqual(['alpha', 'title:beta', 'foo*', '"quoted"'])
    expect(prepared.shortTerms).toEqual(['OR'])
    expect(prepared.shortTermLikePatterns).toEqual(['%OR%'])
    expect(prepared.ftsExpression).toBe(
      '"alpha" AND "title:beta" AND "foo*" AND """quoted"""'
    )
    expect(toFts5Literal('NEAR(foo)')).toBe('"NEAR(foo)"')
  })

  it('routes one- and two-code-point terms to escaped LIKE patterns', () => {
    const prepared = prepareContentSearch('知 知乎 % a_ a\\')

    expect(prepared.longTerms).toEqual([])
    expect(prepared.shortTerms).toEqual(['知', '知乎', '%', 'a_', 'a\\'])
    expect(prepared.shortTermLikePatterns).toEqual([
      '%知%',
      '%知乎%',
      '%\\%%',
      '%a\\_%',
      '%a\\\\%'
    ])
    expect(CONTENT_SEARCH_LIKE_ESCAPE).toBe('\\')
    expect(toEscapedLikeContainsPattern('_%\\')).toBe('%\\_\\%\\\\%')
  })

  it('counts Unicode code points instead of UTF-16 code units', () => {
    const prepared = prepareContentSearch('😀 😀a 😀ab')

    expect(prepared.shortTerms).toEqual(['😀', '😀a'])
    expect(prepared.longTerms).toEqual(['😀ab'])
  })

  it('returns inert primitives for an empty query', () => {
    expect(prepareContentSearch('   ')).toEqual({
      normalizedQuery: '',
      terms: [],
      longTerms: [],
      shortTerms: [],
      shortTermLikePatterns: [],
      ftsExpression: null
    })
  })

  it('rejects control characters and more than twelve input terms', () => {
    expect(prepareContentSearch(Array.from({ length: 12 }, (_, index) => `term${index}`).join(' ')).terms)
      .toHaveLength(12)
    expect(() => prepareContentSearch('safe\nunsafe')).toThrow('控制字符')
    expect(() => prepareContentSearch('\tsafe')).toThrow('控制字符')
    expect(() => prepareContentSearch(`safe${String.fromCharCode(0x7f)}unsafe`)).toThrow('控制字符')
    expect(() => prepareContentSearch(Array.from({ length: 13 }, (_, index) => `t${index}`).join(' ')))
      .toThrow('最多包含 12 个')
  })
})

describe('tag normalization', () => {
  it('normalizes, trims, removes empty values and deduplicates in first-seen order', () => {
    expect(normalizeTags([' 重点 ', '', '   ', 'ＡＢＣ', '重点', 'ABC'])).toEqual(['重点', 'ABC'])
  })

  it('applies length constraints after NFKC normalization by Unicode code point', () => {
    expect(normalizeTags(['😀😀'], { maxLength: 2 })).toEqual(['😀😀'])
    expect(() => normalizeTags(['ﬃ'], { maxLength: 2 })).toThrow('长度不能超过 2')
    expect(normalizeTags(['a'.repeat(24)])).toEqual(['a'.repeat(24)])
    expect(() => normalizeTags(['a'.repeat(25)])).toThrow('长度不能超过 24')
  })

  it('applies the count constraint to canonical non-empty unique tags', () => {
    expect(normalizeTags(['a', 'a', '', 'b'], { maxCount: 2 })).toEqual(['a', 'b'])
    expect(() => normalizeTags(['a', 'b', 'c'], { maxCount: 2 })).toThrow('数量不能超过 2')
    expect(normalizeTags([], { maxCount: 0 })).toEqual([])
    expect(normalizeTags(Array.from({ length: 20 }, (_, index) => `tag-${index}`))).toHaveLength(20)
    expect(() => normalizeTags(Array.from({ length: 21 }, (_, index) => `tag-${index}`)))
      .toThrow('数量不能超过 20')
  })

  it('rejects invalid values, options and control characters', () => {
    expect(() => normalizeTags(['safe\ttag'])).toThrow('控制字符')
    expect(() => normalizeTags(['\ttag'])).toThrow('控制字符')
    expect(() => normalizeTags(['tag', 1])).toThrow('标签必须是字符串')
    expect(() => normalizeTags([], { maxCount: -1 })).toThrow('数量上限无效')
    expect(() => normalizeTags([], { maxLength: 0 })).toThrow('长度上限无效')
  })
})
