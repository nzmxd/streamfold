export const CONTENT_SEARCH_MAX_TERMS = 12
export const CONTENT_SEARCH_LIKE_ESCAPE = '\\'
export const CONTENT_TAG_MAX_COUNT = 20
export const CONTENT_TAG_MAX_LENGTH = 24

export interface PreparedContentSearch {
  normalizedQuery: string
  terms: string[]
  longTerms: string[]
  shortTerms: string[]
  shortTermLikePatterns: string[]
  ftsExpression: string | null
}

export interface NormalizeTagsOptions {
  maxCount?: number
  maxLength?: number
}

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u

/**
 * Turns user-entered keywords into bounded, literal search primitives.
 *
 * Terms of at least three Unicode code points can be sent to an FTS5 index
 * using the trigram tokenizer. Shorter terms must use the returned escaped
 * LIKE patterns together with `ESCAPE '\'`.
 */
export function prepareContentSearch(query: string): PreparedContentSearch {
  if (typeof query !== 'string') throw new TypeError('搜索词必须是字符串')

  const compatibilityNormalized = query.normalize('NFKC')
  assertNoControlCharacters(compatibilityNormalized, '搜索词')
  const normalizedQuery = compatibilityNormalized.trim()
  if (!normalizedQuery) {
    return {
      normalizedQuery: '',
      terms: [],
      longTerms: [],
      shortTerms: [],
      shortTermLikePatterns: [],
      ftsExpression: null
    }
  }

  const inputTerms = normalizedQuery.split(/\s+/u)
  if (inputTerms.length > CONTENT_SEARCH_MAX_TERMS) {
    throw new Error(`搜索词最多包含 ${CONTENT_SEARCH_MAX_TERMS} 个字面词`)
  }

  const terms = [...new Set(inputTerms)]
  const longTerms: string[] = []
  const shortTerms: string[] = []
  for (const term of terms) {
    if ([...term].length >= 3) longTerms.push(term)
    else shortTerms.push(term)
  }

  return {
    normalizedQuery,
    terms,
    longTerms,
    shortTerms,
    shortTermLikePatterns: shortTerms.map(toEscapedLikeContainsPattern),
    ftsExpression: longTerms.length > 0
      ? longTerms.map(toFts5Literal).join(' AND ')
      : null
  }
}

/** Escapes `%`, `_` and the escape character itself for a LIKE parameter. */
export function toEscapedLikeContainsPattern(literal: string): string {
  assertNoControlCharacters(literal, 'LIKE 字面词')
  const escaped = literal
    .replaceAll(CONTENT_SEARCH_LIKE_ESCAPE, `${CONTENT_SEARCH_LIKE_ESCAPE}${CONTENT_SEARCH_LIKE_ESCAPE}`)
    .replaceAll('%', `${CONTENT_SEARCH_LIKE_ESCAPE}%`)
    .replaceAll('_', `${CONTENT_SEARCH_LIKE_ESCAPE}_`)
  return `%${escaped}%`
}

/** Quotes one complete FTS5 term so operators and column syntax stay literal. */
export function toFts5Literal(literal: string): string {
  assertNoControlCharacters(literal, 'FTS5 字面词')
  return `"${literal.replaceAll('"', '""')}"`
}

/**
 * Normalizes a tag list for canonical storage and exact matching.
 * Empty values and duplicates are removed while first-seen order is retained.
 */
export function normalizeTags(
  values: readonly unknown[],
  options: NormalizeTagsOptions = {}
): string[] {
  if (!Array.isArray(values)) throw new TypeError('标签必须是数组')

  const maxCount = options.maxCount ?? CONTENT_TAG_MAX_COUNT
  const maxLength = options.maxLength ?? CONTENT_TAG_MAX_LENGTH
  assertNonNegativeSafeInteger(maxCount, '标签数量上限')
  assertPositiveSafeInteger(maxLength, '标签长度上限')

  const normalized: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    if (typeof value !== 'string') throw new TypeError('标签必须是字符串')
    const compatibilityNormalized = value.normalize('NFKC')
    assertNoControlCharacters(compatibilityNormalized, '标签')
    const tag = compatibilityNormalized.trim()
    if (!tag) continue
    if ([...tag].length > maxLength) {
      throw new Error(`标签长度不能超过 ${maxLength} 个字符`)
    }
    if (seen.has(tag)) continue
    seen.add(tag)
    normalized.push(tag)
    if (normalized.length > maxCount) {
      throw new Error(`标签数量不能超过 ${maxCount} 个`)
    }
  }
  return normalized
}

function assertNoControlCharacters(value: string, label: string): void {
  if (CONTROL_CHARACTER_PATTERN.test(value)) throw new Error(`${label}不能包含控制字符`)
}

function assertNonNegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label}无效`)
}

function assertPositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label}无效`)
}
