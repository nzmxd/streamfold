const ZHIHU_ORIGIN = 'https://www.zhihu.com'
const ZHIHU_LEGACY_API_HOST = 'api.zhihu.com'

const PROFILE_INCLUDE = [
  'follower_count',
  'following_count',
  'answer_count',
  'articles_count',
  'pins_count',
  'question_count',
  'voteup_count',
  'thanked_count',
  'favorited_count',
  'headline',
  'gender'
].join(',')
const ANSWERS_INCLUDE = 'data[*].voteup_count,comment_count,created_time,updated_time,question,excerpt'
const ARTICLES_INCLUDE = 'data[*].voteup_count,comment_count,created,updated,excerpt'
const CREATOR_CONTENT_PATH = '/api/v4/creators/creations/v2/all'
const CREATOR_SORT_TYPE = 'created'
const MEMBER_AGGREGATE_PATH = '/api/v4/creators/analysis/realtime/member/aggr'
const MEMBER_DAILY_PATH = '/api/v4/creators/analysis/realtime/member/daily'
const CONTENT_ANALYSIS_LIST_PATH = '/api/v4/creators/analysis/realtime/content/list'
const CONTENT_AGGREGATE_PATH = '/api/v4/creators/analysis/realtime/content/aggr'
const CONTENT_DAILY_PATH = '/api/v4/creators/analysis/realtime/content/daily'
const ANALYSIS_TAB = 'all'

const PAGE_SIZE = 20
const MAX_CONTENTS = 100
const MAX_PAGES = 5
const MAX_PAGING_OFFSET = 100
const MAX_ANALYSIS_OFFSET = 80
const MAX_ANALYTICS_DAYS = 90
const MAX_COUNT = 1_000_000_000_000
const MAX_DIRECT_RESPONSE_BYTES = 256 * 1024
const MAX_LIST_RESPONSE_BYTES = 512 * 1024
const MAX_LIST_TOTAL_BYTES = 2 * 1024 * 1024
const HANDLE_RE = /^[A-Za-z0-9_-]{1,128}$/
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/
const CONTENT_TOKEN_RE = /^[A-Za-z0-9._~-]{1,256}$/
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

type ZhihuListKind = 'answers' | 'articles' | 'pins'
export type ZhihuAnalysisContentType = 'answer' | 'article' | 'pin' | 'zvideo'

function creatorContentsEndpoint(offset: number): string {
  return canonicalEndpoint(CREATOR_CONTENT_PATH, {
    start: '0',
    end: '0',
    limit: String(PAGE_SIZE),
    offset: String(offset),
    need_co_creation: '1',
    sort_type: CREATOR_SORT_TYPE
  })
}

function memberAggregateEndpoint(start?: string, end?: string): string {
  const query: Record<string, string> = { tab: ANALYSIS_TAB }
  if (start !== undefined || end !== undefined) {
    const range = analyticsDateRange(start, end)
    query.start = range.start
    query.end = range.end
  }
  return canonicalEndpoint(MEMBER_AGGREGATE_PATH, query)
}

function memberDailyEndpoint(start: string, end: string): string {
  const range = analyticsDateRange(start, end)
  return canonicalEndpoint(MEMBER_DAILY_PATH, {
    tab: ANALYSIS_TAB,
    start: range.start,
    end: range.end
  })
}

function contentAnalysisListEndpoint(type: ZhihuAnalysisContentType, offset: number): string {
  const cleanOffset = analysisOffset(offset)
  return canonicalEndpoint(CONTENT_ANALYSIS_LIST_PATH, {
    type: cleanAnalysisContentType(type),
    limit: String(PAGE_SIZE),
    offset: String(cleanOffset)
  })
}

function contentAggregateEndpoint(type: ZhihuAnalysisContentType, token: string): string {
  return canonicalEndpoint(CONTENT_AGGREGATE_PATH, {
    type: cleanAnalysisContentType(type),
    token: cleanContentToken(token)
  })
}

function contentDailyEndpoint(
  type: ZhihuAnalysisContentType,
  token: string,
  start: string,
  end: string
): string {
  const range = analyticsDateRange(start, end)
  return canonicalEndpoint(CONTENT_DAILY_PATH, {
    type: cleanAnalysisContentType(type),
    token: cleanContentToken(token),
    start: range.start,
    end: range.end
  })
}

function memberEndpoint(handle: string): string {
  return canonicalEndpoint(`/api/v4/members/${encodeURIComponent(cleanHandle(handle))}`, {
    include: PROFILE_INCLUDE
  })
}

function listEndpoint(kind: ZhihuListKind, handle: string, offset: number): string {
  const query: Record<string, string> = {
    limit: String(PAGE_SIZE),
    offset: String(offset)
  }
  if (kind === 'answers') query.include = ANSWERS_INCLUDE
  if (kind === 'articles') query.include = ARTICLES_INCLUDE
  return canonicalEndpoint(
    `/api/v4/members/${encodeURIComponent(cleanHandle(handle))}/${kind}`,
    query
  )
}

export const ZHIHU_API_ENDPOINTS = Object.freeze({
  identity: '/api/v4/me?include=url_token',
  profile: memberEndpoint,
  creatorContents: (offset = 0) => creatorContentsEndpoint(offset),
  memberAggregate: (start?: string, end?: string) => memberAggregateEndpoint(start, end),
  memberDaily: (start: string, end: string) => memberDailyEndpoint(start, end),
  contentAnalysisList: (type: ZhihuAnalysisContentType, offset = 0) =>
    contentAnalysisListEndpoint(type, offset),
  contentAggregate: (type: ZhihuAnalysisContentType, token: string) =>
    contentAggregateEndpoint(type, token),
  contentDaily: (type: ZhihuAnalysisContentType, token: string, start: string, end: string) =>
    contentDailyEndpoint(type, token, start, end),
  answers: (handle: string, offset = 0) => listEndpoint('answers', handle, offset),
  articles: (handle: string, offset = 0) => listEndpoint('articles', handle, offset),
  pins: (handle: string, offset = 0) => listEndpoint('pins', handle, offset)
})

export interface ZhihuJsonResponse {
  status: number
  url: string
  json: unknown
}

/**
 * The transport may use an account's persistent browser session, but it only
 * receives endpoints produced and revalidated by this module. It must return
 * parsed JSON and never exposes cookies, page HTML or DOM state.
 */
export interface ZhihuApiTransport {
  getJson(endpoint: string): Promise<ZhihuJsonResponse>
}

export type ZhihuApiErrorCode =
  | 'AUTH_REQUIRED'
  | 'RATE_LIMITED'
  | 'NOT_FOUND'
  | 'HTTP_STATUS'
  | 'API_REJECTED'
  | 'MALFORMED_RESPONSE'
  | 'RESPONSE_TOO_LARGE'
  | 'IDENTITY_MISMATCH'
  | 'DUPLICATE_CONTENT'
  | 'INCOMPLETE_PAGINATION'

export class ZhihuApiError extends Error {
  constructor(
    readonly code: ZhihuApiErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'ZhihuApiError'
  }
}

export interface ZhihuIdentity {
  remoteId: string
  remoteHandle: string
  remoteName: string
}

export interface ZhihuProfile extends ZhihuIdentity {
  avatarUrl: string | null
  bio: string
  followers: number | null
  following: number | null
  answerCount: number | null
  articleCount: number | null
  pinCount: number | null
  questionCount: number | null
  voteupCount: number | null
  thankedCount: number | null
  favoriteCount: number | null
  contentCount: number | null
  likesAndFavoritesTotal: number | null
}

export type ZhihuContentType = 'answer' | 'article' | 'post' | 'video'

export interface ZhihuContent {
  /** Namespaced stable key suitable for persistence across content kinds. */
  id: string
  /** The platform's original item id, always represented as a string. */
  platformContentId: string
  type: ZhihuContentType
  title: string
  bodyExcerpt: string
  url: string
  publishedAt: string | null
  updatedAt: string | null
  impressionCount: number | null
  readCount: number | null
  playCount: number | null
  voteUpCount: number | null
  likeCount: number | null
  commentCount: number | null
  shareCount: number | null
  favoriteCount: number | null
  repostCount: number | null
}

export interface ZhihuAdvancedMetrics {
  positiveInteractionRate: number | null
  followerConversion: number | null
  status: string | null
}

export interface ZhihuAnalyticsMetrics {
  views: number | null
  impressions: number | null
  plays: number | null
  upvotes: number | null
  likes: number | null
  comments: number | null
  favorites: number | null
  shares: number | null
  reactions: number | null
  reposts: number | null
  likesAndReactions: number | null
  newUpvotes: number | null
  newLikes: number | null
  upvoteIncreases: number | null
  upvoteDecreases: number | null
  likeIncreases: number | null
  likeDecreases: number | null
  publishCount: number | null
  clickRate: number | null
  readCompletionRate: number | null
  playCompletionRate: number | null
  advanced: ZhihuAdvancedMetrics
}

export interface ZhihuMemberAggregate {
  metrics: ZhihuAnalyticsMetrics
  today: ZhihuAnalyticsMetrics | null
  yesterday: ZhihuAnalyticsMetrics | null
  updatedAt: string | null
}

export interface ZhihuDailyAnalytics extends ZhihuAnalyticsMetrics {
  date: string
}

export interface ZhihuContentAnalysisItem {
  contentType: ZhihuAnalysisContentType
  contentToken: string
  contentId: string | null
  title: string
  metrics: ZhihuAnalyticsMetrics
}

export interface ZhihuContentAnalysisList {
  contentType: ZhihuAnalysisContentType
  items: ZhihuContentAnalysisItem[]
  isEnd: boolean
  next: string | null
  total: number
  totalReal: number
}

export interface ZhihuApiSnapshot {
  identity: ZhihuIdentity
  profile: ZhihuProfile
  contents: ZhihuContent[]
}

interface ZhihuListPage {
  items: unknown[]
  isEnd: boolean
  next: string | null
  bytes: number
}

interface ZhihuCreatorPage extends ZhihuListPage {
  total: number
  totalReal: number
}

/**
 * Converts a fixed Zhihu API URL to a canonical same-origin endpoint.
 *
 * Zhihu currently returns two legacy paging.next forms: an http://www.zhihu.com
 * URL and an api.zhihu.com/members/... URL. Both are accepted only after their
 * path and query pass the fixed read-only allowlist, then converted to the
 * canonical https://www.zhihu.com/api/v4/... endpoint before any request.
 */
export function normalizeZhihuApiEndpoint(value: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 2_048 || value !== value.trim() ||
    /[\u0000-\u001f\u007f]/.test(value)) {
    malformed('知乎 API 地址非法')
  }
  const authority = /^https:\/\/([^/?#]+)/i.exec(value)?.[1] ?? ''
  if (/:\d+$/.test(authority)) malformed('知乎 API 地址不在只读白名单')

  let url: URL
  try {
    url = new URL(value, ZHIHU_ORIGIN)
  } catch {
    malformed('知乎 API 地址非法')
  }
  const isLegacyHttpPagingUrl = url!.protocol === 'http:' && url!.hostname === 'www.zhihu.com'
  if ((url!.protocol !== 'https:' && !isLegacyHttpPagingUrl) ||
    url!.username || url!.password || url!.port || url!.hash) {
    malformed('知乎 API 地址不在只读白名单')
  }

  let path = url!.pathname
  if (url!.hostname === ZHIHU_LEGACY_API_HOST) {
    if (!path.startsWith('/members/')) malformed('知乎 API 地址不在只读白名单')
    path = `/api/v4${path}`
  } else if (url!.hostname !== 'www.zhihu.com') {
    malformed('知乎 API 地址不在只读白名单')
  }

  const entries = [...url!.searchParams.entries()]
  if (new Set(entries.map(([key]) => key)).size !== entries.length) {
    malformed('知乎 API 查询参数重复')
  }
  const query = Object.fromEntries(entries)

  if (path === '/api/v4/me') {
    if (isLegacyHttpPagingUrl) malformed('知乎 API 地址不在只读白名单')
    assertExactQuery(query, { include: 'url_token' })
    return ZHIHU_API_ENDPOINTS.identity
  }

  if (path === CREATOR_CONTENT_PATH) {
    if (isLegacyHttpPagingUrl) malformed('知乎 API 地址不在只读白名单')
    const expectedKeys = ['start', 'end', 'limit', 'offset', 'need_co_creation', 'sort_type']
    if (Object.keys(query).length !== expectedKeys.length ||
      expectedKeys.some((key) => !Object.prototype.hasOwnProperty.call(query, key))) {
      malformed('知乎创作内容接口查询参数不在白名单')
    }
    if (query.start !== '0' || query.end !== '0' || query.limit !== String(PAGE_SIZE) ||
      query.need_co_creation !== '1' || query.sort_type !== CREATOR_SORT_TYPE) {
      malformed('知乎创作内容接口查询参数不在白名单')
    }
    const offset = decimalInteger(query.offset, '知乎创作内容分页 offset')
    if (offset < 0 || offset > MAX_PAGING_OFFSET || offset % PAGE_SIZE !== 0) {
      malformed('知乎创作内容分页 offset 超出允许范围')
    }
    return creatorContentsEndpoint(offset)
  }

  if (path === MEMBER_AGGREGATE_PATH) {
    if (isLegacyHttpPagingUrl) malformed('知乎 API 地址不在只读白名单')
    const keys = Object.keys(query)
    if (query.tab !== ANALYSIS_TAB || (keys.length !== 1 && keys.length !== 3)) {
      malformed('知乎账号聚合指标查询参数不在白名单')
    }
    if (keys.length === 1) return memberAggregateEndpoint()
    assertExactKeys(query, ['tab', 'start', 'end'], '知乎账号聚合指标')
    const range = analyticsDateRange(query.start, query.end)
    return memberAggregateEndpoint(range.start, range.end)
  }

  if (path === MEMBER_DAILY_PATH) {
    if (isLegacyHttpPagingUrl) malformed('知乎 API 地址不在只读白名单')
    assertExactKeys(query, ['tab', 'start', 'end'], '知乎账号日趋势')
    if (query.tab !== ANALYSIS_TAB) malformed('知乎账号日趋势 tab 参数不在白名单')
    const range = analyticsDateRange(query.start, query.end)
    return memberDailyEndpoint(range.start, range.end)
  }

  if (path === CONTENT_ANALYSIS_LIST_PATH) {
    if (isLegacyHttpPagingUrl) malformed('知乎 API 地址不在只读白名单')
    assertExactKeys(query, ['type', 'limit', 'offset'], '知乎内容分析列表')
    if (query.limit !== String(PAGE_SIZE)) malformed('知乎内容分析列表分页大小必须固定为 20')
    const offset = analysisOffset(decimalInteger(query.offset, '知乎内容分析列表 offset'))
    return contentAnalysisListEndpoint(cleanAnalysisContentType(query.type), offset)
  }

  if (path === CONTENT_AGGREGATE_PATH) {
    if (isLegacyHttpPagingUrl) malformed('知乎 API 地址不在只读白名单')
    assertExactKeys(query, ['type', 'token'], '知乎单内容聚合指标')
    return contentAggregateEndpoint(
      cleanAnalysisContentType(query.type),
      cleanContentToken(query.token)
    )
  }

  if (path === CONTENT_DAILY_PATH) {
    if (isLegacyHttpPagingUrl) malformed('知乎 API 地址不在只读白名单')
    assertExactKeys(query, ['type', 'token', 'start', 'end'], '知乎单内容日趋势')
    const range = analyticsDateRange(query.start, query.end)
    return contentDailyEndpoint(
      cleanAnalysisContentType(query.type),
      cleanContentToken(query.token),
      range.start,
      range.end
    )
  }

  const matched = /^\/api\/v4\/members\/([^/]+)(?:\/(answers|articles|pins))?$/.exec(path)
  if (!matched?.[1]) malformed('知乎 API 路径不在只读白名单')
  const handle = cleanHandle(decodeSegment(matched[1]))
  const kind = matched[2] as ZhihuListKind | undefined
  if (!kind) {
    if (isLegacyHttpPagingUrl) malformed('知乎 API 地址不在只读白名单')
    assertExactQuery(query, { include: PROFILE_INCLUDE })
    return memberEndpoint(handle)
  }

  const expectedInclude = kind === 'answers'
    ? ANSWERS_INCLUDE
    : kind === 'articles' ? ARTICLES_INCLUDE : null
  const expectedKeys = expectedInclude ? ['limit', 'offset', 'include'] : ['limit', 'offset']
  if (Object.keys(query).length !== expectedKeys.length ||
    expectedKeys.some((key) => !Object.prototype.hasOwnProperty.call(query, key))) {
    malformed('知乎分页接口查询参数不在白名单')
  }
  if (query.limit !== String(PAGE_SIZE)) malformed('知乎分页大小必须固定为 20')
  const offset = decimalInteger(query.offset, '知乎分页 offset')
  if (offset < 0 || offset > MAX_PAGING_OFFSET || offset % PAGE_SIZE !== 0) {
    malformed('知乎分页 offset 超出允许范围')
  }
  if (expectedInclude !== null && query.include !== expectedInclude) {
    malformed('知乎分页 include 参数不在白名单')
  }
  return listEndpoint(kind, handle, offset)
}

export class ZhihuApi {
  constructor(private readonly transport: ZhihuApiTransport) {}

  async getIdentity(): Promise<ZhihuIdentity> {
    return parseZhihuIdentity(await this.request(ZHIHU_API_ENDPOINTS.identity))
  }

  async getProfile(identity?: ZhihuIdentity): Promise<ZhihuProfile> {
    const current = identity ?? await this.getIdentity()
    return parseZhihuProfile(
      await this.request(ZHIHU_API_ENDPOINTS.profile(current.remoteHandle)),
      current
    )
  }

  async getMemberAggregate(start?: string, end?: string): Promise<ZhihuMemberAggregate> {
    const endpoint = memberAggregateEndpoint(start, end)
    return parseZhihuMemberAggregate(await this.request(endpoint), endpoint)
  }

  async getMemberDaily(start: string, end: string): Promise<ZhihuDailyAnalytics[]> {
    const endpoint = memberDailyEndpoint(start, end)
    return parseZhihuDailyAnalytics(await this.request(endpoint), endpoint)
  }

  async getContentAnalysisList(
    type: ZhihuAnalysisContentType,
    offset = 0
  ): Promise<ZhihuContentAnalysisList> {
    const endpoint = contentAnalysisListEndpoint(type, offset)
    return parseZhihuContentAnalysisList(await this.request(endpoint), type, endpoint)
  }

  async getContentAnalysisItems(
    type: ZhihuAnalysisContentType,
    limit = 20
  ): Promise<ZhihuContentAnalysisItem[]> {
    const cleanType = cleanAnalysisContentType(type)
    assertLimit(limit)
    const items: ZhihuContentAnalysisItem[] = []
    const tokens = new Set<string>()
    const visited = new Set<string>()
    let endpoint = contentAnalysisListEndpoint(cleanType, 0)
    let expectedTotal: number | null = null
    let expectedTotalReal: number | null = null
    let aggregateBytes = 0

    for (let pageNumber = 1; pageNumber <= MAX_PAGES; pageNumber += 1) {
      if (visited.has(endpoint)) malformed('知乎内容分析列表返回了重复的下一页地址')
      visited.add(endpoint)
      const page = parseZhihuContentAnalysisList(await this.request(endpoint), cleanType, endpoint)
      aggregateBytes += jsonBytes(page)
      if (aggregateBytes > MAX_LIST_TOTAL_BYTES) tooLarge('知乎内容分析分页响应总量超过 2 MiB')
      if (expectedTotal === null) {
        expectedTotal = page.total
        expectedTotalReal = page.totalReal
      } else if (page.total !== expectedTotal || page.totalReal !== expectedTotalReal) {
        malformed('知乎内容分析分页总数在采集期间发生变化')
      }
      if (items.length + page.items.length > page.total) {
        malformed('知乎内容分析分页数量超过接口声明总数')
      }

      for (const item of page.items) {
        if (tokens.has(item.contentToken)) {
          throw new ZhihuApiError('DUPLICATE_CONTENT', `知乎内容分析 token 重复：${item.contentToken}`)
        }
        tokens.add(item.contentToken)
        items.push(item)
        if (items.length >= limit) return items
      }
      if (page.isEnd) {
        if (items.length !== Math.min(page.total, limit)) {
          throw new ZhihuApiError(
            'INCOMPLETE_PAGINATION',
            `知乎内容分析分页结束时仅返回 ${items.length} / ${Math.min(page.total, limit)} 条数据`
          )
        }
        return items
      }
      if (pageNumber === MAX_PAGES) break
      const currentUrl = new URL(endpoint, ZHIHU_ORIGIN)
      const currentOffset = Number(currentUrl.searchParams.get('offset'))
      const nextEndpoint = page.next
        ? normalizeZhihuApiEndpoint(page.next)
        : contentAnalysisListEndpoint(cleanType, currentOffset + PAGE_SIZE)
      assertNextContentAnalysisPage(endpoint, nextEndpoint, cleanType)
      if (visited.has(nextEndpoint)) malformed('知乎内容分析列表返回了重复的下一页地址')
      endpoint = nextEndpoint
    }

    throw new ZhihuApiError('INCOMPLETE_PAGINATION', '知乎内容分析在安全分页上限内未返回足够数据')
  }

  async getContentAggregate(
    type: ZhihuAnalysisContentType,
    token: string
  ): Promise<ZhihuAnalyticsMetrics> {
    const endpoint = contentAggregateEndpoint(type, token)
    return parseZhihuContentAggregate(await this.request(endpoint), type, token)
  }

  async getContentDaily(
    type: ZhihuAnalysisContentType,
    token: string,
    start: string,
    end: string
  ): Promise<ZhihuDailyAnalytics[]> {
    const endpoint = contentDailyEndpoint(type, token, start, end)
    return parseZhihuDailyAnalytics(await this.request(endpoint), endpoint)
  }

  async getAnswers(remoteHandle: string, limit = 20): Promise<ZhihuContent[]> {
    return await this.getList('answers', remoteHandle, limit)
  }

  async getArticles(remoteHandle: string, limit = 20): Promise<ZhihuContent[]> {
    return await this.getList('articles', remoteHandle, limit)
  }

  async getPins(remoteHandle: string, limit = 20): Promise<ZhihuContent[]> {
    return await this.getList('pins', remoteHandle, limit)
  }

  async getContents(remoteHandle: string, limit = 20): Promise<ZhihuContent[]> {
    assertLimit(limit)
    // Keep validating the bound handle at this boundary even though the
    // authenticated creator endpoint identifies the account from its session.
    cleanHandle(remoteHandle)
    return await this.getCreatorContents(limit)
  }

  async getCreatorContents(limit = 20): Promise<ZhihuContent[]> {
    assertLimit(limit)
    const rows: ZhihuContent[] = []
    const ids = new Set<string>()
    const visited = new Set<string>()
    let endpoint = creatorContentsEndpoint(0)
    let aggregateBytes = 0
    let expectedTotal: number | null = null
    let expectedTotalReal: number | null = null

    for (let pageNumber = 1; pageNumber <= MAX_PAGES; pageNumber += 1) {
      if (visited.has(endpoint)) malformed('知乎创作内容接口返回了重复的下一页地址')
      visited.add(endpoint)
      const page = parseZhihuCreatorPage(await this.request(endpoint), endpoint)
      aggregateBytes += page.bytes
      if (aggregateBytes > MAX_LIST_TOTAL_BYTES) tooLarge('知乎创作内容分页响应总量超过 2 MiB')
      if (expectedTotal === null) {
        expectedTotal = page.total
        expectedTotalReal = page.totalReal
      } else if (page.total !== expectedTotal || page.totalReal !== expectedTotalReal) {
        malformed('知乎创作内容分页总数在采集期间发生变化')
      }
      if (rows.length + page.items.length > page.total) {
        malformed('知乎创作内容分页数量超过接口声明总数')
      }

      let nextEndpoint: string | null = null
      if (!page.isEnd) {
        if (!page.next) malformed('知乎创作内容分页响应缺少下一页地址')
        nextEndpoint = normalizeZhihuApiEndpoint(page.next)
        assertNextCreatorPage(endpoint, nextEndpoint)
        if (visited.has(nextEndpoint)) malformed('知乎创作内容接口返回了重复的下一页地址')
      }

      for (const item of page.items) {
        const content = parseZhihuCreatorContent(item)
        if (ids.has(content.id)) {
          throw new ZhihuApiError('DUPLICATE_CONTENT', `知乎内容 ID 重复：${content.id}`)
        }
        ids.add(content.id)
        rows.push(content)
        if (rows.length >= limit) return rows
      }
      if (page.isEnd) {
        if (rows.length !== Math.min(page.total, limit)) {
          throw new ZhihuApiError(
            'INCOMPLETE_PAGINATION',
            `知乎创作内容分页结束时仅返回 ${rows.length} / ${Math.min(page.total, limit)} 条数据`
          )
        }
        return rows
      }
      if (rows.length >= page.total) malformed('知乎创作内容已达到声明总数但仍返回下一页')
      endpoint = nextEndpoint!
    }

    throw new ZhihuApiError(
      'INCOMPLETE_PAGINATION',
      '知乎创作内容在安全分页上限内未返回足够数据'
    )
  }

  async collect(expectedRemoteId: string, limit = 20): Promise<ZhihuApiSnapshot> {
    const expected = cleanId(expectedRemoteId, 'expectedRemoteId')
    assertLimit(limit)
    const before = await this.getIdentity()
    assertExpectedIdentity(expected, before.remoteId)
    const profile = await this.getProfile(before)
    const contents = await this.getContents(before.remoteHandle, limit)
    const after = await this.getIdentity()
    assertExpectedIdentity(expected, after.remoteId)
    if (before.remoteId !== after.remoteId || before.remoteHandle !== after.remoteHandle) {
      throw new ZhihuApiError('IDENTITY_MISMATCH', '采集期间知乎登录身份发生变化，已拒绝返回数据')
    }
    return { identity: after, profile, contents }
  }

  private async request(endpoint: string): Promise<ZhihuJsonResponse> {
    const normalized = normalizeZhihuApiEndpoint(endpoint)
    return await this.transport.getJson(normalized)
  }

  private async getList(
    kind: ZhihuListKind,
    remoteHandle: string,
    limit: number
  ): Promise<ZhihuContent[]> {
    assertLimit(limit)
    const handle = cleanHandle(remoteHandle)
    const rows: ZhihuContent[] = []
    const ids = new Set<string>()
    const visited = new Set<string>()
    let endpoint = listEndpoint(kind, handle, 0)
    let aggregateBytes = 0

    for (let pageNumber = 1; pageNumber <= MAX_PAGES; pageNumber += 1) {
      if (visited.has(endpoint)) malformed('知乎分页接口返回了重复的下一页地址')
      visited.add(endpoint)
      const page = parseZhihuListPage(await this.request(endpoint), endpoint)
      aggregateBytes += page.bytes
      if (aggregateBytes > MAX_LIST_TOTAL_BYTES) tooLarge('知乎内容分页响应总量超过 2 MiB')
      let nextEndpoint: string | null = null
      if (!page.isEnd) {
        if (!page.next) malformed('知乎分页响应缺少下一页地址')
        nextEndpoint = normalizeZhihuApiEndpoint(page.next)
        assertNextPage(endpoint, nextEndpoint, kind, handle)
        if (visited.has(nextEndpoint)) malformed('知乎分页接口返回了重复的下一页地址')
      }

      for (const item of page.items) {
        const content = kind === 'answers'
          ? parseZhihuAnswer(item)
          : kind === 'articles' ? parseZhihuArticle(item) : parseZhihuPin(item)
        if (ids.has(content.id)) {
          throw new ZhihuApiError('DUPLICATE_CONTENT', `知乎内容 ID 重复：${content.id}`)
        }
        ids.add(content.id)
        rows.push(content)
        if (rows.length >= limit) return rows
      }
      if (page.isEnd) return rows
      endpoint = nextEndpoint!
    }

    throw new ZhihuApiError(
      'INCOMPLETE_PAGINATION',
      `知乎${listLabel(kind)}在安全分页上限内未返回足够数据`
    )
  }
}

export function parseZhihuIdentity(response: ZhihuJsonResponse): ZhihuIdentity {
  const data = responseObject(response, ZHIHU_API_ENDPOINTS.identity, MAX_DIRECT_RESPONSE_BYTES)
  return {
    remoteId: cleanId(firstPresent(data, ['id', 'uid']), 'me.id'),
    remoteHandle: cleanHandle(data.url_token, 'me.url_token'),
    remoteName: cleanString(data.name, 'me.name', 120, false)
  }
}

export function parseZhihuProfile(
  response: ZhihuJsonResponse,
  expected?: ZhihuIdentity
): ZhihuProfile {
  const expectedEndpoint = expected
    ? ZHIHU_API_ENDPOINTS.profile(expected.remoteHandle)
    : normalizeZhihuApiEndpoint(response.url)
  const data = responseObject(response, expectedEndpoint, MAX_DIRECT_RESPONSE_BYTES)
  const remoteId = cleanId(firstPresent(data, ['id', 'uid']), 'member.id')
  const remoteHandle = cleanHandle(data.url_token, 'member.url_token')
  if (expected && (remoteId !== expected.remoteId || remoteHandle !== expected.remoteHandle)) {
    throw new ZhihuApiError('IDENTITY_MISMATCH', '知乎资料接口返回了不一致的登录身份')
  }
  const answerCount = optionalCount(data.answer_count, 'member.answer_count')
  const articleCount = optionalCount(data.articles_count, 'member.articles_count')
  const pinCount = optionalCount(data.pins_count, 'member.pins_count')
  const voteupCount = optionalCount(data.voteup_count, 'member.voteup_count')
  const favoriteCount = optionalCount(data.favorited_count, 'member.favorited_count')
  return {
    remoteId,
    remoteHandle,
    remoteName: cleanString(data.name, 'member.name', 120, false),
    avatarUrl: safeAvatarUrl(data.avatar_url),
    bio: optionalString(firstPresent(data, ['headline', 'description']), 'member.headline', 2_000),
    followers: optionalCount(data.follower_count, 'member.follower_count'),
    following: optionalCount(data.following_count, 'member.following_count'),
    answerCount,
    articleCount,
    pinCount,
    questionCount: optionalCount(data.question_count, 'member.question_count'),
    voteupCount,
    thankedCount: optionalCount(data.thanked_count, 'member.thanked_count'),
    favoriteCount,
    contentCount: sumWhenComplete([answerCount, articleCount, pinCount]),
    likesAndFavoritesTotal: sumWhenComplete([voteupCount, favoriteCount])
  }
}

export function parseZhihuMemberAggregate(
  response: ZhihuJsonResponse,
  expectedEndpoint = normalizeZhihuApiEndpoint(response.url)
): ZhihuMemberAggregate {
  const data = responseObject(response, expectedEndpoint, MAX_DIRECT_RESPONSE_BYTES)
  return {
    metrics: parseZhihuAnalyticsMetrics(data, 'member.aggr'),
    today: optionalAnalyticsBlock(data.today, 'member.aggr.today'),
    yesterday: optionalAnalyticsBlock(data.yesterday, 'member.aggr.yesterday'),
    updatedAt: optionalAnalyticsUpdatedAt(data.updated, 'member.aggr.updated')
  }
}

export function parseZhihuDailyAnalytics(
  response: ZhihuJsonResponse,
  expectedEndpoint = normalizeZhihuApiEndpoint(response.url)
): ZhihuDailyAnalytics[] {
  const result = validatedResponse(response, expectedEndpoint, MAX_LIST_RESPONSE_BYTES)
  const rows = analysisRows(result.json, 'daily.response')
  if (rows.length > MAX_ANALYTICS_DAYS) malformed('知乎日趋势响应超过 90 条')
  const normalizedEndpoint = normalizeZhihuApiEndpoint(expectedEndpoint)
  const endpointUrl = new URL(normalizedEndpoint, ZHIHU_ORIGIN)
  const expectedStart = endpointUrl.searchParams.get('start')
  const expectedEnd = endpointUrl.searchParams.get('end')
  const dates = new Set<string>()
  const parsed = rows.map((value, index) => {
    const item = objectValue(value, `daily.data[${index}]`)
    const date = cleanAnalyticsDate(
      firstPresent(item, ['p_date', 'date', 'day', 'stat_date']),
      `daily.data[${index}].date`
    )
    if (expectedStart && expectedEnd && (date < expectedStart || date > expectedEnd)) {
      malformed('知乎日趋势返回了请求日期范围之外的数据')
    }
    if (dates.has(date)) malformed(`知乎日趋势日期重复：${date}`)
    dates.add(date)
    return { date, ...parseZhihuAnalyticsMetrics(item, `daily.data[${index}]`) }
  })
  return parsed.sort((left, right) => left.date.localeCompare(right.date))
}

export function parseZhihuContentAggregate(
  response: ZhihuJsonResponse,
  type: ZhihuAnalysisContentType,
  token: string
): ZhihuAnalyticsMetrics {
  const endpoint = contentAggregateEndpoint(type, token)
  const data = responseObject(response, endpoint, MAX_DIRECT_RESPONSE_BYTES)
  const metricSource = data.data === undefined || data.data === null
    ? data
    : objectValue(data.data, 'content.aggr.data')
  return parseZhihuAnalyticsMetrics(metricSource, 'content.aggr')
}

export function parseZhihuContentAnalysisList(
  response: ZhihuJsonResponse,
  type: ZhihuAnalysisContentType,
  expectedEndpoint = normalizeZhihuApiEndpoint(response.url)
): ZhihuContentAnalysisList {
  const cleanType = cleanAnalysisContentType(type)
  const result = validatedResponse(response, expectedEndpoint, MAX_LIST_RESPONSE_BYTES)
  const data = objectValue(result.json, 'content.list.response')
  if (!Array.isArray(data.data)) malformed('知乎内容分析列表 data 必须是数组')
  if (data.data.length > PAGE_SIZE) malformed('知乎内容分析列表单页数量超过 20 条')
  const paging = objectValue(data.paging, 'content.list.paging')
  if (typeof paging.is_end !== 'boolean') malformed('知乎内容分析列表 paging.is_end 必须是布尔值')
  const total = optionalCount(paging.totals, 'content.list.paging.totals')
  const totalReal = optionalCount(paging.totals_real, 'content.list.paging.totals_real')
  if (total === null || totalReal === null) malformed('知乎内容分析列表缺少分页总数')
  let next: string | null = null
  if (!paging.is_end) {
    if (paging.next !== undefined && paging.next !== null && paging.next !== '') {
      if (typeof paging.next !== 'string') malformed('知乎内容分析列表 paging.next 类型非法')
      next = normalizeZhihuApiEndpoint(paging.next)
      assertNextContentAnalysisPage(expectedEndpoint, next, cleanType)
    }
  } else if (paging.next !== undefined && paging.next !== null && typeof paging.next !== 'string') {
    malformed('知乎内容分析列表 paging.next 类型非法')
  }
  return {
    contentType: cleanType,
    items: data.data.map((item, index) => parseZhihuContentAnalysisItem(item, cleanType, index)),
    isEnd: paging.is_end,
    next,
    total,
    totalReal
  }
}

export function parseZhihuAnalyticsMetrics(
  value: unknown,
  path = 'metrics'
): ZhihuAnalyticsMetrics {
  const item = objectValue(value, path)
  const advanced = item.advanced === undefined || item.advanced === null
    ? {}
    : objectValue(item.advanced, `${path}.advanced`)
  const advancedStatus = optionalAdvancedStatus(
    firstPresent(advanced, ['status']) ?? firstPresent(item, ['advanced_status']),
    `${path}.advanced.status`
  )
  const unavailable = isExplicitUnavailableAdvancedStatus(advancedStatus)
  return {
    views: optionalCount(firstPresent(item, ['pv', 'read_count', 'view_count']), `${path}.pv`),
    impressions: optionalCount(firstPresent(item, ['show', 'show_count', 'impression_count']), `${path}.show`),
    plays: optionalCount(firstPresent(item, ['play', 'play_count']), `${path}.play`),
    upvotes: optionalCount(firstPresent(item, ['upvote', 'vote_up_count', 'voteup_count']), `${path}.upvote`),
    likes: optionalCount(firstPresent(item, ['like', 'like_count']), `${path}.like`),
    comments: optionalCount(firstPresent(item, ['comment', 'comment_count']), `${path}.comment`),
    favorites: optionalCount(firstPresent(item, ['collect', 'collect_count', 'favorite_count']), `${path}.collect`),
    shares: optionalCount(firstPresent(item, ['share', 'share_count']), `${path}.share`),
    reactions: optionalCount(firstPresent(item, ['reaction', 'reaction_count']), `${path}.reaction`),
    reposts: optionalCount(firstPresent(item, ['re_pin', 'repin_count']), `${path}.re_pin`),
    likesAndReactions: optionalCount(
      firstPresent(item, ['like_and_reaction']),
      `${path}.like_and_reaction`
    ),
    newUpvotes: optionalCount(firstPresent(item, ['new_upvote']), `${path}.new_upvote`),
    newLikes: optionalCount(firstPresent(item, ['new_like']), `${path}.new_like`),
    upvoteIncreases: optionalCount(
      firstPresent(item, ['new_incr_upvote_num']),
      `${path}.new_incr_upvote_num`
    ),
    upvoteDecreases: optionalCount(
      firstPresent(item, ['new_desc_upvote_num']),
      `${path}.new_desc_upvote_num`
    ),
    likeIncreases: optionalCount(
      firstPresent(item, ['new_incr_like_num']),
      `${path}.new_incr_like_num`
    ),
    likeDecreases: optionalCount(
      firstPresent(item, ['new_desc_like_num']),
      `${path}.new_desc_like_num`
    ),
    publishCount: optionalCount(firstPresent(item, ['publish_cnt']), `${path}.publish_cnt`),
    clickRate: optionalRate(firstPresent(item, ['click_rate']), `${path}.click_rate`),
    readCompletionRate: optionalRate(
      firstPresent(item, ['read_finished_rate']),
      `${path}.read_finished_rate`
    ),
    playCompletionRate: optionalRate(
      firstPresent(item, ['play_finished_rate']),
      `${path}.play_finished_rate`
    ),
    advanced: {
      positiveInteractionRate: unavailable
        ? null
        : optionalPercentRate(
            firstPresent(advanced, ['positive_interact_percent']) ??
              firstPresent(item, ['positive_interact_percent']),
            `${path}.advanced.positive_interact_percent`
          ),
      followerConversion: unavailable
        ? null
        : optionalSignedCount(
            firstPresent(advanced, ['follower_translate']) ??
              firstPresent(item, ['follower_translate']),
            `${path}.advanced.follower_translate`
          ),
      status: advancedStatus
    }
  }
}

function parseZhihuContentAnalysisItem(
  value: unknown,
  expectedType: ZhihuAnalysisContentType,
  index: number
): ZhihuContentAnalysisItem {
  const path = `content.list.data[${index}]`
  const item = objectValue(value, path)
  const rawType = firstPresent(item, ['type', 'content_type']) ?? expectedType
  const actualType = rawType === 'video' ? 'zvideo' : cleanAnalysisContentType(rawType)
  if (actualType !== expectedType) malformed('知乎内容分析列表返回了其他内容类型')
  const typedContentKey = actualType === 'zvideo' && (item.zvideo === undefined || item.zvideo === null)
    ? 'video'
    : actualType
  const nestedContentKey = item.data === undefined || item.data === null ? typedContentKey : 'data'
  const nestedContent = item[nestedContentKey]
  const data = nestedContent === undefined || nestedContent === null
    ? item
    : objectValue(nestedContent, `${path}.${nestedContentKey}`)
  const contentToken = cleanResponseContentToken(
    firstPresent(item, ['content_token', 'token', 'url_token']) ??
      firstPresent(data, ['content_token', 'token', 'url_token']) ??
      firstPresent(data, ['content_id', 'id']) ??
      firstPresent(item, ['content_id', 'id']),
    `${path}.content_token`
  )
  const idValue = firstPresent(data, ['content_id', 'id']) ?? firstPresent(item, ['content_id', 'id'])
  const contentId = idValue === undefined ? null : cleanId(idValue, `${path}.content_id`)
  const title = optionalString(
    firstPresent(data, ['title', 'content_title', 'excerpt_title']) ??
      firstPresent(item, ['title', 'content_title']),
    `${path}.title`,
    500
  )
  const flatMetrics = data === item ? item : { ...data, ...item }
  const metricBase = item.metrics !== undefined && item.metrics !== null
    ? objectValue(item.metrics, `${path}.metrics`)
    : isObjectRecord(item.reaction)
      ? objectValue(item.reaction, `${path}.reaction`)
      : data.metrics !== undefined && data.metrics !== null
        ? objectValue(data.metrics, `${path}.data.metrics`)
        : isObjectRecord(data.reaction)
          ? objectValue(data.reaction, `${path}.data.reaction`)
          : flatMetrics
  const advancedValue = item.advanced ?? data.advanced
  const metricSource = advancedValue === undefined || advancedValue === null || metricBase.advanced !== undefined
    ? metricBase
    : { ...metricBase, advanced: advancedValue }
  return {
    contentType: actualType,
    contentToken,
    contentId,
    title,
    metrics: parseZhihuAnalyticsMetrics(metricSource, `${path}.metrics`)
  }
}

export function parseZhihuAnswer(value: unknown): ZhihuContent {
  const item = objectValue(value, 'answers.data[]')
  const answerId = cleanId(item.id, 'answer.id')
  const question = objectValue(item.question, 'answer.question')
  const questionId = cleanId(question.id, 'answer.question.id')
  return {
    id: `answer:${questionId}:${answerId}`,
    platformContentId: answerId,
    type: 'answer',
    title: cleanString(question.title, 'answer.question.title', 500, false),
    bodyExcerpt: apiExcerpt(item.excerpt, 'answer.excerpt'),
    url: `${ZHIHU_ORIGIN}/question/${encodeURIComponent(questionId)}/answer/${encodeURIComponent(answerId)}`,
    publishedAt: optionalTimestamp(firstPresent(item, ['created_time', 'created']), 'answer.created_time'),
    updatedAt: optionalTimestamp(firstPresent(item, ['updated_time', 'updated']), 'answer.updated_time'),
    impressionCount: null,
    readCount: null,
    playCount: null,
    voteUpCount: optionalCount(firstPresent(item, ['voteup_count', 'reaction_count']), 'answer.voteup_count'),
    likeCount: contentLikeCount(item, ['like_count'], 'answer'),
    commentCount: optionalCount(item.comment_count, 'answer.comment_count'),
    shareCount: null,
    favoriteCount: null,
    repostCount: null
  }
}

export function parseZhihuArticle(value: unknown): ZhihuContent {
  const item = objectValue(value, 'articles.data[]')
  const id = cleanId(item.id, 'article.id')
  return {
    id: `article:${id}`,
    platformContentId: id,
    type: 'article',
    title: cleanString(item.title, 'article.title', 500, false),
    bodyExcerpt: apiExcerpt(firstPresent(item, ['excerpt_title', 'excerpt']), 'article.excerpt'),
    url: `https://zhuanlan.zhihu.com/p/${encodeURIComponent(id)}`,
    publishedAt: optionalTimestamp(
      firstPresent(item, ['created', 'created_time', 'updated', 'updated_time']),
      'article.created'
    ),
    updatedAt: optionalTimestamp(firstPresent(item, ['updated', 'updated_time']), 'article.updated'),
    impressionCount: null,
    readCount: null,
    playCount: null,
    voteUpCount: optionalCount(item.voteup_count, 'article.voteup_count'),
    likeCount: contentLikeCount(item, ['like_count'], 'article'),
    commentCount: optionalCount(item.comment_count, 'article.comment_count'),
    shareCount: null,
    favoriteCount: null,
    repostCount: null
  }
}

export function parseZhihuPin(value: unknown): ZhihuContent {
  const item = objectValue(value, 'pins.data[]')
  const id = cleanId(item.id, 'pin.id')
  const excerpt = apiExcerpt(item.excerpt_title, 'pin.excerpt_title')
  return {
    id: `pin:${id}`,
    platformContentId: id,
    type: 'post',
    title: excerpt
      ? excerpt.length > 500 ? `${excerpt.slice(0, 499)}…` : excerpt
      : '无标题想法',
    bodyExcerpt: excerpt,
    url: `${ZHIHU_ORIGIN}/pin/${encodeURIComponent(id)}`,
    publishedAt: optionalTimestamp(firstPresent(item, ['created', 'created_time']), 'pin.created'),
    updatedAt: optionalTimestamp(firstPresent(item, ['updated', 'updated_time']), 'pin.updated'),
    impressionCount: null,
    readCount: null,
    playCount: null,
    voteUpCount: optionalCount(item.voteup_count, 'pin.voteup_count'),
    likeCount: contentLikeCount(item, ['like_count', 'reaction_count'], 'pin'),
    commentCount: optionalCount(item.comment_count, 'pin.comment_count'),
    shareCount: optionalCount(item.repin_count, 'pin.repin_count'),
    favoriteCount: null,
    repostCount: optionalCount(item.repin_count, 'pin.repin_count')
  }
}

/** Maps one row returned by the authenticated creator content-management API. */
export function parseZhihuCreatorContent(value: unknown): ZhihuContent {
  const row = objectValue(value, 'creator.data[]')
  const kind = cleanString(row.type, 'creator.data[].type', 40, false)
  if (kind !== 'answer' && kind !== 'article' && kind !== 'pin' &&
    kind !== 'zvideo' && kind !== 'video') {
    malformed(`知乎创作内容类型暂不支持：${kind}`)
  }
  const data = objectValue(row.data, `creator.${kind}.data`)
  const reaction = row.reaction === undefined || row.reaction === null
    ? {}
    : objectValue(row.reaction, `creator.${kind}.reaction`)
  const id = cleanId(data.id, `creator.${kind}.data.id`)
  const publishedAt = optionalTimestamp(
    firstPresent(data, ['created_time', 'created']),
    `creator.${kind}.data.created_time`
  )
  const updatedAt = optionalTimestamp(
    firstPresent(data, ['updated_time', 'updated']),
    `creator.${kind}.data.updated_time`
  )
  const bodyExcerpt = creatorApiExcerpt(data, kind)
  const titleValue = firstPresent(data, ['title', 'excerpt_title'])
  const title = titleValue === undefined
    ? kind === 'pin' ? (bodyExcerpt || '无标题想法')
      : kind === 'zvideo' || kind === 'video' ? '无标题视频'
        : malformed(`creator.${kind}.data.title 缺失`)
    : cleanString(titleValue, `creator.${kind}.data.title`, 500, false)
  const common = {
    platformContentId: id,
    title,
    bodyExcerpt,
    publishedAt,
    updatedAt,
    impressionCount: optionalCount(
      firstPresent(reaction, ['show_count', 'impression_count']),
      `creator.${kind}.reaction.show_count`
    ),
    readCount: optionalCount(reaction.read_count, `creator.${kind}.reaction.read_count`),
    playCount: optionalCount(reaction.play_count, `creator.${kind}.reaction.play_count`),
    voteUpCount: optionalCount(reaction.vote_up_count, `creator.${kind}.reaction.vote_up_count`),
    likeCount: optionalCount(reaction.like_count, `creator.${kind}.reaction.like_count`),
    commentCount: optionalCount(reaction.comment_count, `creator.${kind}.reaction.comment_count`),
    shareCount: optionalCount(reaction.share_count, `creator.${kind}.reaction.share_count`),
    favoriteCount: optionalCount(reaction.collect_count, `creator.${kind}.reaction.collect_count`),
    repostCount: optionalCount(
      firstPresent(reaction, ['re_pin', 'repin_count']),
      `creator.${kind}.reaction.re_pin`
    )
  }

  if (kind === 'answer') {
    const questionId = cleanId(data.question_id, 'creator.answer.data.question_id')
    return {
      ...common,
      id: `answer:${questionId}:${id}`,
      type: 'answer',
      url: `${ZHIHU_ORIGIN}/question/${encodeURIComponent(questionId)}/answer/${encodeURIComponent(id)}`
    }
  }
  if (kind === 'article') {
    return {
      ...common,
      id: `article:${id}`,
      type: 'article',
      url: `https://zhuanlan.zhihu.com/p/${encodeURIComponent(id)}`
    }
  }
  if (kind === 'pin') {
    return {
      ...common,
      id: `pin:${id}`,
      type: 'post',
      url: `${ZHIHU_ORIGIN}/pin/${encodeURIComponent(id)}`
    }
  }
  return {
    ...common,
    id: `zvideo:${id}`,
    type: 'video',
    url: `${ZHIHU_ORIGIN}/zvideo/${encodeURIComponent(id)}`
  }
}

function parseZhihuListPage(response: ZhihuJsonResponse, endpoint: string): ZhihuListPage {
  const result = validatedResponse(response, endpoint, MAX_LIST_RESPONSE_BYTES)
  const data = objectValue(result.json, 'list.response')
  if (!Array.isArray(data.data)) malformed('知乎列表响应 data 必须是数组')
  if (data.data.length > PAGE_SIZE) malformed('知乎列表单页数量超过 20 条')
  const paging = objectValue(data.paging, 'list.paging')
  if (typeof paging.is_end !== 'boolean') malformed('知乎列表 paging.is_end 必须是布尔值')
  let next: string | null = null
  if (!paging.is_end) {
    if (typeof paging.next !== 'string' || paging.next.length === 0) {
      malformed('知乎分页响应缺少下一页地址')
    }
    next = paging.next
  } else if (paging.next !== undefined && paging.next !== null && typeof paging.next !== 'string') {
    malformed('知乎列表 paging.next 类型非法')
  }
  return { items: data.data, isEnd: paging.is_end, next, bytes: result.bytes }
}

function parseZhihuCreatorPage(response: ZhihuJsonResponse, endpoint: string): ZhihuCreatorPage {
  const result = validatedResponse(response, endpoint, MAX_LIST_RESPONSE_BYTES)
  const data = objectValue(result.json, 'creator.response')
  if (!Array.isArray(data.data)) malformed('知乎创作内容响应 data 必须是数组')
  if (data.data.length > PAGE_SIZE) malformed('知乎创作内容单页数量超过 20 条')
  const paging = objectValue(data.paging, 'creator.paging')
  if (typeof paging.is_end !== 'boolean') malformed('知乎创作内容 paging.is_end 必须是布尔值')
  const total = optionalCount(paging.totals, 'creator.paging.totals')
  const totalReal = optionalCount(paging.totals_real, 'creator.paging.totals_real')
  if (total === null || totalReal === null) malformed('知乎创作内容分页缺少总数')
  let next: string | null = null
  if (!paging.is_end) {
    if (typeof paging.next !== 'string' || paging.next.length === 0) {
      malformed('知乎创作内容分页响应缺少下一页地址')
    }
    next = paging.next
  } else if (paging.next !== undefined && paging.next !== null && typeof paging.next !== 'string') {
    malformed('知乎创作内容 paging.next 类型非法')
  }
  return { items: data.data, isEnd: paging.is_end, next, bytes: result.bytes, total, totalReal }
}

function responseObject(
  response: ZhihuJsonResponse,
  endpoint: string,
  maximumBytes: number
): Record<string, unknown> {
  return objectValue(validatedResponse(response, endpoint, maximumBytes).json, `${endpoint}.response`)
}

function validatedResponse(
  response: ZhihuJsonResponse,
  endpoint: string,
  maximumBytes: number
): { json: unknown; bytes: number } {
  const record = objectValue(response, 'transport.response')
  if (!Number.isInteger(record.status) || (record.status as number) < 100 || (record.status as number) > 599) {
    malformed('transport.response.status 非法')
  }
  validateResponseUrl(record.url, endpoint)
  const status = record.status as number
  if (status === 401 || status === 403) {
    throw new ZhihuApiError('AUTH_REQUIRED', '知乎登录已失效，请重新登录')
  }
  if (status === 429) {
    throw new ZhihuApiError('RATE_LIMITED', '知乎请求暂时受限，请稍后再试')
  }
  if (status === 404) {
    const message = normalizeZhihuApiEndpoint(endpoint).startsWith(CREATOR_CONTENT_PATH)
      ? '知乎内容管理接口不可用，未返回当前账号的内容数据'
      : '知乎账号或内容不存在'
    throw new ZhihuApiError('NOT_FOUND', message)
  }
  if (status < 200 || status >= 300) {
    throw new ZhihuApiError('HTTP_STATUS', `知乎只读接口返回 HTTP ${status}`)
  }
  const bytes = jsonBytes(record.json)
  if (bytes > maximumBytes) tooLarge(`知乎接口 ${endpoint} 响应超过大小上限`)
  const responseRecord = record.json && typeof record.json === 'object' && !Array.isArray(record.json)
    ? record.json as Record<string, unknown>
    : null
  const responseCode = responseRecord?.code
  const responseMessage = responseRecord
    ? firstPresent(responseRecord, ['msg', 'message'])
    : undefined
  const authCode = responseCode === 401 || responseCode === 403 ||
    responseCode === '401' || responseCode === '403'
  const authMessage = typeof responseMessage === 'string' &&
    /(?:no\s*auth|unauth|登录|login|auth|session)/i.test(responseMessage)
  if (authCode || authMessage) {
    throw new ZhihuApiError('AUTH_REQUIRED', '知乎登录已失效，请重新登录')
  }
  const possibleError = record.json && typeof record.json === 'object' && !Array.isArray(record.json)
    ? (record.json as Record<string, unknown>).error
    : undefined
  if (possibleError !== undefined && possibleError !== null) {
    const error = typeof possibleError === 'object' && !Array.isArray(possibleError)
      ? possibleError as Record<string, unknown>
      : {}
    const message = typeof error.message === 'string' ? error.message.slice(0, 200) : '平台拒绝请求'
    if (/(?:登录|login|auth|session)/i.test(message)) {
      throw new ZhihuApiError('AUTH_REQUIRED', '知乎登录已失效，请重新登录')
    }
    throw new ZhihuApiError('API_REJECTED', `知乎接口拒绝请求：${message}`)
  }
  return { json: record.json, bytes }
}

function validateResponseUrl(value: unknown, expectedEndpoint: string): void {
  if (typeof value !== 'string' || value.length > 2_048) malformed('知乎 API 响应地址非法')
  let url: URL
  try {
    url = new URL(value)
  } catch {
    malformed('知乎 API 响应地址非法')
  }
  if (url!.origin !== ZHIHU_ORIGIN || url!.username || url!.password || url!.port) {
    malformed('知乎 API 响应来源不在只读白名单')
  }
  if (url!.pathname === '/signin' || url!.pathname.startsWith('/signin/')) {
    throw new ZhihuApiError('AUTH_REQUIRED', '知乎登录已失效，请重新登录')
  }
  if (normalizeZhihuApiEndpoint(url!.toString()) !== normalizeZhihuApiEndpoint(expectedEndpoint)) {
    malformed('知乎 API 响应地址与请求不一致')
  }
}

function assertNextPage(
  currentEndpoint: string,
  nextEndpoint: string,
  kind: ZhihuListKind,
  handle: string
): void {
  const current = new URL(currentEndpoint, ZHIHU_ORIGIN)
  const next = new URL(nextEndpoint, ZHIHU_ORIGIN)
  const expectedPath = `/api/v4/members/${encodeURIComponent(handle)}/${kind}`
  const currentOffset = Number(current.searchParams.get('offset'))
  const nextOffset = Number(next.searchParams.get('offset'))
  if (next.pathname !== expectedPath || nextOffset !== currentOffset + PAGE_SIZE) {
    malformed('知乎分页下一页地址未按固定步长前进')
  }
}

function assertNextCreatorPage(currentEndpoint: string, nextEndpoint: string): void {
  const current = new URL(currentEndpoint, ZHIHU_ORIGIN)
  const next = new URL(nextEndpoint, ZHIHU_ORIGIN)
  const currentOffset = Number(current.searchParams.get('offset'))
  const nextOffset = Number(next.searchParams.get('offset'))
  if (next.pathname !== CREATOR_CONTENT_PATH || nextOffset !== currentOffset + PAGE_SIZE) {
    malformed('知乎创作内容分页下一页地址未按固定步长前进')
  }
}

function assertNextContentAnalysisPage(
  currentEndpoint: string,
  nextEndpoint: string,
  type: ZhihuAnalysisContentType
): void {
  const current = new URL(currentEndpoint, ZHIHU_ORIGIN)
  const next = new URL(nextEndpoint, ZHIHU_ORIGIN)
  const currentOffset = Number(current.searchParams.get('offset'))
  const nextOffset = Number(next.searchParams.get('offset'))
  if (next.pathname !== CONTENT_ANALYSIS_LIST_PATH ||
    next.searchParams.get('type') !== type ||
    next.searchParams.get('limit') !== String(PAGE_SIZE) ||
    nextOffset !== currentOffset + PAGE_SIZE) {
    malformed('知乎内容分析下一页地址未按固定步长前进')
  }
}

function compareContentsNewestFirst(left: ZhihuContent, right: ZhihuContent): number {
  const leftTime = left.publishedAt ? Date.parse(left.publishedAt) : -1
  const rightTime = right.publishedAt ? Date.parse(right.publishedAt) : -1
  return rightTime - leftTime || left.id.localeCompare(right.id)
}

function canonicalEndpoint(path: string, query: Record<string, string>): string {
  const search = new URLSearchParams(query).toString()
  return search ? `${path}?${search}` : path
}

function assertExactQuery(
  actual: Record<string, string>,
  expected: Record<string, string>
): void {
  const actualKeys = Object.keys(actual)
  const expectedKeys = Object.keys(expected)
  if (actualKeys.length !== expectedKeys.length ||
    expectedKeys.some((key) => actual[key] !== expected[key])) {
    malformed('知乎 API 查询参数不在白名单')
  }
}

function assertExactKeys(
  actual: Record<string, string>,
  expectedKeys: readonly string[],
  label: string
): void {
  const actualKeys = Object.keys(actual)
  if (actualKeys.length !== expectedKeys.length ||
    expectedKeys.some((key) => !Object.prototype.hasOwnProperty.call(actual, key))) {
    malformed(`${label}查询参数不在白名单`)
  }
}

function analyticsDateRange(
  startValue: unknown,
  endValue: unknown
): { start: string; end: string } {
  const start = cleanAnalyticsDate(startValue, 'start')
  const end = cleanAnalyticsDate(endValue, 'end')
  const startTime = Date.parse(`${start}T00:00:00.000Z`)
  const endTime = Date.parse(`${end}T00:00:00.000Z`)
  const dayCount = Math.floor((endTime - startTime) / 86_400_000) + 1
  if (dayCount < 1 || dayCount > MAX_ANALYTICS_DAYS) {
    malformed('知乎指标日期范围必须为 1 到 90 天')
  }
  return { start, end }
}

function cleanAnalyticsDate(value: unknown, path: string): string {
  if (typeof value !== 'string' || !ISO_DATE_RE.test(value)) malformed(`${path} 必须是 YYYY-MM-DD`)
  const timestamp = Date.parse(`${value}T00:00:00.000Z`)
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) {
    malformed(`${path} 不是有效日期`)
  }
  return value
}

function cleanAnalysisContentType(value: unknown): ZhihuAnalysisContentType {
  if (value === 'answer' || value === 'article' || value === 'pin' || value === 'zvideo') {
    return value
  }
  malformed('知乎内容分析类型不在白名单')
}

function cleanContentToken(value: unknown, path = 'contentToken'): string {
  if (typeof value !== 'string') malformed(`${path} 必须是字符串`)
  const token = value.trim()
  if (!CONTENT_TOKEN_RE.test(token)) malformed(`${path} 格式非法`)
  return token
}

function cleanResponseContentToken(value: unknown, path: string): string {
  if (Number.isSafeInteger(value) && (value as number) >= 0) {
    return cleanContentToken(String(value), path)
  }
  return cleanContentToken(value, path)
}

function analysisOffset(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > MAX_ANALYSIS_OFFSET || value % PAGE_SIZE !== 0) {
    malformed('知乎内容分析 offset 超出允许范围')
  }
  return value
}

function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    malformed('知乎账号标识编码非法')
  }
}

function decimalInteger(value: unknown, path: string): number {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/.test(value)) malformed(`${path} 必须是十进制整数`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) malformed(`${path} 超出安全整数范围`)
  return parsed
}

function objectValue(value: unknown, path: string): Record<string, unknown> {
  if (!isObjectRecord(value)) malformed(`${path} 必须是对象`)
  return value
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function analysisRows(value: unknown, path: string): unknown[] {
  if (Array.isArray(value)) return value
  const record = objectValue(value, path)
  if (!Array.isArray(record.data)) malformed(`${path}.data 必须是数组`)
  return record.data
}

function firstPresent(record: Record<string, unknown>, names: readonly string[]): unknown {
  for (const name of names) {
    if (record[name] !== undefined && record[name] !== null && record[name] !== '') return record[name]
  }
  return undefined
}

function cleanString(value: unknown, path: string, maximum: number, allowEmpty: boolean): string {
  if (typeof value !== 'string') malformed(`${path} 必须是字符串`)
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) malformed(`${path} 包含控制字符`)
  const text = value.trim()
  if ((!allowEmpty && !text) || text.length > maximum) malformed(`${path} 长度非法`)
  return text
}

function optionalString(value: unknown, path: string, maximum: number): string {
  if (value === undefined || value === null || value === '') return ''
  return cleanString(value, path, maximum, true)
}

function optionalAnalyticsBlock(value: unknown, path: string): ZhihuAnalyticsMetrics | null {
  if (value === undefined || value === null) return null
  return parseZhihuAnalyticsMetrics(value, path)
}

function optionalAnalyticsUpdatedAt(value: unknown, path: string): string | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value === 'number') return optionalTimestamp(value, path)
  return cleanString(value, path, 100, false)
}

function optionalAdvancedStatus(value: unknown, path: string): string | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value === 'string') return cleanString(value, path, 100, false)
  if (typeof value === 'boolean') return String(value)
  if (Number.isSafeInteger(value)) return String(value)
  malformed(`${path} 类型非法`)
}

function isExplicitUnavailableAdvancedStatus(status: string | null): boolean {
  return status !== null && /(?:unavailable|insufficient|updating|locked|disabled|forbidden|unnormal|level|(?:^|_)pv(?:_|$)|read|不可用|不足|更新中|未开放|无权限)/i.test(status)
}

function optionalRate(value: unknown, path: string): number | null {
  if (value === undefined || value === null || value === '') return null
  let percentage = false
  if (typeof value === 'string') {
    const text = value.trim()
    percentage = text.endsWith('%')
    const numeric = percentage ? text.slice(0, -1).trim() : text
    if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(numeric)) malformed(`${path} 必须是百分比`)
    value = Number(numeric)
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
    malformed(`${path} 必须在 0 到 100 之间`)
  }
  return percentage || value > 1 ? value / 100 : value
}

function optionalPercentRate(value: unknown, path: string): number | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value === 'string') {
    const numeric = value.trim().replace(/%$/, '').trim()
    if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(numeric)) malformed(`${path} 必须是百分比`)
    value = Number(numeric)
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
    malformed(`${path} 必须在 0 到 100 之间`)
  }
  return value / 100
}

function optionalSignedCount(value: unknown, path: string): number | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value === 'string' && /^-?(?:0|[1-9]\d*)$/.test(value)) value = Number(value)
  if (!Number.isSafeInteger(value) || Math.abs(value as number) > MAX_COUNT) {
    malformed(`${path} 必须是安全整数`)
  }
  return value as number
}

function apiExcerpt(value: unknown, path: string): string {
  const raw = optionalString(value, path, 5_000)
  if (!raw) return ''
  const withoutTags = raw
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/?(?:p|div|li|ul|ol|blockquote|h[1-6])(?:\s[^>]*)?>/gi, ' ')
    .replace(/<\/?[a-z][^>]*>/gi, '')
  return decodeApiTextEntities(withoutTags).replace(/\s+/gu, ' ').trim()
}

function creatorApiExcerpt(data: Record<string, unknown>, kind: string): string {
  const direct = firstPresent(data, ['excerpt', 'excerpt_title'])
  if (direct !== undefined) return apiExcerpt(direct, `creator.${kind}.data.excerpt`)
  if (kind !== 'pin' || data.content === undefined || data.content === null) return ''
  // These are API JSON text blocks; no page document or DOM state is accessed.
  if (!Array.isArray(data.content) || data.content.length > 100) {
    malformed('creator.pin.data.content 必须是最多 100 项的 JSON 数组')
  }
  const text = data.content.flatMap((value, index) => {
    const block = objectValue(value, `creator.pin.data.content[${index}]`)
    if (block.type !== 'text') return []
    const content = firstPresent(block, ['own_text', 'content'])
    return content === undefined
      ? []
      : [optionalString(content, `creator.pin.data.content[${index}].text`, 5_000)]
  }).join(' ')
  return apiExcerpt(text, 'creator.pin.data.content.text')
}

function decodeApiTextEntities(value: string): string {
  const named: Record<string, string> = {
    amp: '&', apos: "'", gt: '>', lt: '<', nbsp: ' ', quot: '"'
  }
  return value.replace(/&(?:#(\d{1,7})|#x([\da-f]{1,6})|([a-z]{2,8}));/gi, (entity, decimal, hex, name) => {
    if (name) return named[String(name).toLowerCase()] ?? entity
    const codePoint = Number.parseInt(decimal ?? hex, decimal ? 10 : 16)
    if (!Number.isInteger(codePoint) || codePoint <= 0 || codePoint > 0x10ffff ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff)) return entity
    return String.fromCodePoint(codePoint)
  })
}

function contentLikeCount(
  item: Record<string, unknown>,
  directKeys: readonly string[],
  path: string
): number | null {
  const direct = firstPresent(item, directKeys)
  if (direct !== undefined) return optionalCount(direct, `${path}.like_count`)
  if (item.reaction === undefined || item.reaction === null) return null
  const reaction = objectValue(item.reaction, `${path}.reaction`)
  if (reaction.statistics === undefined || reaction.statistics === null) return null
  const statistics = objectValue(reaction.statistics, `${path}.reaction.statistics`)
  return optionalCount(statistics.like_count, `${path}.reaction.statistics.like_count`)
}

function cleanHandle(value: unknown, path = 'remoteHandle'): string {
  if (typeof value !== 'string') malformed(`${path} 必须是字符串`)
  const handle = value.trim()
  if (!HANDLE_RE.test(handle)) malformed(`${path} 格式非法`)
  return handle
}

function cleanId(value: unknown, path: string): string {
  let id: string
  if (typeof value === 'string') {
    id = value.trim()
  } else if (Number.isSafeInteger(value) && (value as number) >= 0) {
    id = String(value)
  } else {
    malformed(`${path} 必须是字符串 ID 或非负安全整数`)
  }
  if (!ID_RE.test(id!)) malformed(`${path} 格式非法`)
  return id!
}

function optionalCount(value: unknown, path: string): number | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value === 'string' && /^(?:0|[1-9]\d*)$/.test(value)) value = Number(value)
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > MAX_COUNT) {
    malformed(`${path} 必须是非负安全整数`)
  }
  return value as number
}

function optionalTimestamp(value: unknown, path: string): string | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value === 'string' && /^(?:0|[1-9]\d*)$/.test(value)) value = Number(value)
  if (!Number.isSafeInteger(value) || (value as number) <= 0) malformed(`${path} 必须是时间戳`)
  let timestamp = value as number
  if (timestamp < 10_000_000_000) timestamp *= 1_000
  const date = new Date(timestamp)
  const year = date.getUTCFullYear()
  if (!Number.isFinite(date.getTime()) || year < 2000 || year > 2100) malformed(`${path} 超出允许范围`)
  return date.toISOString()
}

function safeAvatarUrl(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string' || value.length > 2_048) malformed('member.avatar_url 格式非法')
  try {
    const url = new URL(value)
    const hostname = url.hostname.toLowerCase()
    const official = hostname === 'zhimg.com' || hostname.endsWith('.zhimg.com') ||
      hostname === 'zhihu.com' || hostname.endsWith('.zhihu.com')
    if (url.protocol !== 'https:' || !official || url.username || url.password || url.port) {
      malformed('member.avatar_url 不在知乎官方图片域名')
    }
    url.hash = ''
    return url.toString()
  } catch (error) {
    if (error instanceof ZhihuApiError) throw error
    malformed('member.avatar_url 格式非法')
  }
}

function sumWhenComplete(values: readonly (number | null)[]): number | null {
  if (values.some((value) => value === null)) return null
  const total = values.reduce<number>((sum, value) => sum + (value ?? 0), 0)
  if (!Number.isSafeInteger(total) || total > MAX_COUNT) malformed('知乎汇总指标超出允许范围')
  return total
}

function assertExpectedIdentity(expected: string, actual: string): void {
  if (expected !== actual) {
    throw new ZhihuApiError(
      'IDENTITY_MISMATCH',
      `当前知乎登录身份 ${actual} 与本地绑定身份 ${expected} 不一致`
    )
  }
}

function assertLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_CONTENTS) {
    malformed('知乎内容同步上限必须是 1 到 100')
  }
}

function listLabel(kind: ZhihuListKind): string {
  return kind === 'answers' ? '回答' : kind === 'articles' ? '文章' : '想法'
}

function jsonBytes(value: unknown): number {
  try {
    const serialized = JSON.stringify(value)
    if (serialized === undefined) malformed('知乎接口响应不是 JSON 值')
    return Buffer.byteLength(serialized, 'utf8')
  } catch (error) {
    if (error instanceof ZhihuApiError) throw error
    malformed('知乎接口响应无法序列化为 JSON')
  }
}

function malformed(message: string): never {
  throw new ZhihuApiError('MALFORMED_RESPONSE', message)
}

function tooLarge(message: string): never {
  throw new ZhihuApiError('RESPONSE_TOO_LARGE', message)
}
