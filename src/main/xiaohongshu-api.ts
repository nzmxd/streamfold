const CREATOR_ORIGIN = 'https://creator.xiaohongshu.com'
const PUBLIC_NOTE_ORIGIN = 'https://www.xiaohongshu.com'
const NOTE_DETAIL_ORIGIN = 'https://edith.xiaohongshu.com'

export const XIAOHONGSHU_API_ENDPOINTS = Object.freeze({
  personalInfo: '/api/galaxy/creator/home/personal_info',
  userInfo: '/api/galaxy/user/info',
  accountStats: '/api/galaxy/creator/data/note_detail_new',
  noteAnalyzeList: '/api/galaxy/creator/datacenter/note/analyze/list',
  postedNotes: '/api/galaxy/v2/creator/note/user/posted',
  postedNotesLegacy: '/api/galaxy/creator/note/user/posted',
  noteDetail: '/web_api/sns/capa/postgw/note/detail'
})

export const XIAOHONGSHU_API_ROUTES = Object.freeze({
  home: `${CREATOR_ORIGIN}/new/home`,
  noteAnalytics: `${CREATOR_ORIGIN}/statistics/data-analysis?source=official`,
  noteManager: `${CREATOR_ORIGIN}/new/note-manager`
})

const MAX_DIRECT_RESPONSE_BYTES = 256 * 1024
const MAX_CAPTURE_RESPONSE_BYTES = 512 * 1024
const MAX_CAPTURE_TOTAL_BYTES = 2 * 1024 * 1024
const MAX_CONTENTS = 100
const MAX_DETAIL_REQUESTS_PER_SYNC = 10
const DETAIL_REQUEST_INTERVAL_MS = 2_000
const MAX_EXCERPT_CHARACTERS = 500
const MAX_COUNT = 1_000_000_000_000
const ID_RE = /^[a-zA-Z0-9_-]{3,128}$/

export type XiaohongshuCaptureKind = 'posted_notes' | 'note_analyze_list' | 'note_detail'

/**
 * A transport response is deliberately JSON-only. The browser implementation
 * may use the logged-in session and observe a signed response, but it must not
 * expose document text, HTML, DOM nodes, cookies or request credentials here.
 */
export interface XiaohongshuJsonResponse {
  status: number
  url: string
  json: unknown
}

export interface XiaohongshuApiTransport {
  directJson(endpoint: string): Promise<XiaohongshuJsonResponse>
  captureSignedJson(
    route: string,
    kind: XiaohongshuCaptureKind,
    limit: number
  ): Promise<readonly XiaohongshuJsonResponse[]>
}

export type XiaohongshuApiErrorCode =
  | 'AUTH_REQUIRED'
  | 'SIGNATURE_REQUIRED'
  | 'HTTP_STATUS'
  | 'API_REJECTED'
  | 'MALFORMED_RESPONSE'
  | 'RESPONSE_TOO_LARGE'
  | 'IDENTITY_MISMATCH'
  | 'CONTENT_MISMATCH'
  | 'DUPLICATE_CONTENT'
  | 'INCOMPLETE_CAPTURE'
  | 'RISK_CONTROL'

export class XiaohongshuApiError extends Error {
  constructor(
    readonly code: XiaohongshuApiErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'XiaohongshuApiError'
  }
}

export interface XiaohongshuIdentity {
  remoteId: string
  remoteName: string
}

export interface XiaohongshuProfile extends XiaohongshuIdentity {
  avatarUrl: string | null
  followers: number
  following: number
  likesAndFavorites: number
  bio: string
  creatorLevel: number | null
}

export interface XiaohongshuUserInfo extends XiaohongshuIdentity {
  avatarUrl: string | null
  bio: string
}

export interface XiaohongshuMetricPeriod {
  views: number
  averageViewTimeMs: number
  homeViews: number
  likes: number
  favorites: number
  comments: number
  danmaku: number
  shares: number
  newFollowers: number
}

export interface XiaohongshuAccountMetrics {
  seven: XiaohongshuMetricPeriod
  thirty: XiaohongshuMetricPeriod
}

export type XiaohongshuContentType = 'post' | 'image' | 'video'

export interface XiaohongshuContent {
  id: string
  title: string
  bodyExcerpt: string
  postTime: string | null
  readCount: number | null
  likeCount: number | null
  favoriteCount: number | null
  commentCount: number | null
  shareCount: number | null
  type: XiaohongshuContentType | null
  url: string
}

export interface XiaohongshuApiSnapshot {
  identity: XiaohongshuIdentity
  profile: XiaohongshuProfile
  accountMetrics: XiaohongshuAccountMetrics
  contents: XiaohongshuContent[]
  warnings: string[]
}

export interface XiaohongshuContentOptions {
  enrichExcerpts?: boolean
  existingExcerpts?: ReadonlyMap<string, string>
}

export interface XiaohongshuApiOptions {
  wait?: (milliseconds: number) => Promise<void>
}

export class XiaohongshuApi {
  private readonly wait: (milliseconds: number) => Promise<void>

  constructor(
    private readonly transport: XiaohongshuApiTransport,
    options: XiaohongshuApiOptions = {}
  ) {
    this.wait = options.wait ?? waitFor
  }

  async getProfile(): Promise<XiaohongshuProfile> {
    const personal = parsePersonalInfo(
      await this.transport.directJson(XIAOHONGSHU_API_ENDPOINTS.personalInfo)
    )
    const user = parseUserInfo(
      await this.transport.directJson(XIAOHONGSHU_API_ENDPOINTS.userInfo)
    )
    if (personal.remoteId !== user.remoteId) {
      throw new XiaohongshuApiError(
        'IDENTITY_MISMATCH',
        '小红书资料接口返回了不一致的登录身份，已拒绝使用本次数据'
      )
    }
    return {
      ...personal,
      avatarUrl: user.avatarUrl,
      bio: personal.bio || user.bio
    }
  }

  async getAccountMetrics(): Promise<XiaohongshuAccountMetrics> {
    const response = await this.transport.directJson(XIAOHONGSHU_API_ENDPOINTS.accountStats)
    return parseAccountMetrics(response)
  }

  async getContents(
    limit = 20,
    options: XiaohongshuContentOptions = {}
  ): Promise<{ contents: XiaohongshuContent[], warnings: string[] }> {
    assertLimit(limit)
    const postedResponses = await this.transport.captureSignedJson(
      XIAOHONGSHU_API_ROUTES.noteManager,
      'posted_notes',
      limit
    )
    const posted = parsePostedCaptures(postedResponses, limit)
    const analyzeResponses = await this.transport.captureSignedJson(
      XIAOHONGSHU_API_ROUTES.noteAnalytics,
      'note_analyze_list',
      limit
    )
    const analyzed = parseAnalyzeCaptures(analyzeResponses, limit, false)
    const contents = mergeContents(posted, analyzed, limit).map((content) => {
      const existing = options.existingExcerpts?.get(content.id)
      return !content.bodyExcerpt && existing
        ? { ...content, bodyExcerpt: existing }
        : content
    })
    if (!options.enrichExcerpts) return { contents, warnings: [] }
    return this.enrichExcerpts(contents)
  }

  /**
   * Reads identity before and after the signed analytics capture. Any account
   * switch aborts the whole result; callers must only persist a returned
   * snapshot atomically.
   */
  async collect(
    expectedRemoteId: string,
    limit = 20,
    contentOptions: XiaohongshuContentOptions = {}
  ): Promise<XiaohongshuApiSnapshot> {
    const expected = cleanId(expectedRemoteId, 'expectedRemoteId')
    assertLimit(limit)
    const before = await this.getProfile()
    assertExpectedIdentity(expected, before.remoteId)
    const accountMetrics = await this.getAccountMetrics()
    const contentResult = await this.getContents(limit, contentOptions)
    const after = await this.getProfile()
    assertExpectedIdentity(expected, after.remoteId)
    if (before.remoteId !== after.remoteId || before.remoteName !== after.remoteName) {
      throw new XiaohongshuApiError(
        'IDENTITY_MISMATCH',
        '采集期间小红书登录身份发生变化，已拒绝返回数据'
      )
    }
    return {
      identity: { remoteId: after.remoteId, remoteName: after.remoteName },
      profile: after,
      accountMetrics,
      contents: contentResult.contents,
      warnings: contentResult.warnings
    }
  }

  private async enrichExcerpts(
    source: readonly XiaohongshuContent[]
  ): Promise<{ contents: XiaohongshuContent[], warnings: string[] }> {
    const contents = source.map((content) => ({ ...content }))
    const missing = contents.filter((content) => !content.bodyExcerpt)
    // Creator detail routes are built only from the validated work ID and type.
    // Public xsec query values are useful for opening the original post, but are
    // neither required nor read for excerpt enrichment.
    const candidates = missing.slice(0, MAX_DETAIL_REQUESTS_PER_SYNC)
    let failed = false

    for (let index = 0; index < candidates.length; index += 1) {
      if (index > 0) await this.wait(DETAIL_REQUEST_INTERVAL_MS)
      const content = candidates[index]!
      try {
        const responses = await this.transport.captureSignedJson(creatorNoteUpdateUrl(content), 'note_detail', 1)
        content.bodyExcerpt = parseNoteDetailCaptures(responses, content.id)
      } catch (error) {
        if (error instanceof XiaohongshuApiError &&
          (error.code === 'AUTH_REQUIRED' || error.code === 'RISK_CONTROL')) {
          throw error
        }
        failed = true
        break
      }
    }

    const warnings: string[] = []
    if (failed || missing.length > candidates.length) {
      warnings.push('部分作品摘要暂未补齐，将在后续同步中继续处理。')
    }
    return { contents, warnings }
  }
}

export function parsePersonalInfo(response: XiaohongshuJsonResponse): XiaohongshuProfile {
  const data = responseData(response, XIAOHONGSHU_API_ENDPOINTS.personalInfo, MAX_DIRECT_RESPONSE_BYTES)
  const record = objectValue(data, 'personal_info.data')
  const identityValue = firstDefined(record, ['red_num', 'user_id', 'red_id', 'account_id', 'userid'])
  const remoteId = cleanId(
    identityValue,
    'personal_info.data.red_num'
  )
  const grow = optionalObject(record.grow_info, 'personal_info.data.grow_info')
  return {
    remoteId,
    remoteName: cleanString(record.name, 'personal_info.data.name', 80, false),
    avatarUrl: null,
    followers: countValue(record.fans_count, 'personal_info.data.fans_count'),
    following: countValue(record.follow_count, 'personal_info.data.follow_count'),
    likesAndFavorites: countValue(record.faved_count, 'personal_info.data.faved_count'),
    bio: record.personal_desc === undefined || record.personal_desc === null
      ? ''
      : cleanString(record.personal_desc, 'personal_info.data.personal_desc', 1_000, true),
    creatorLevel: grow?.level === undefined || grow.level === null
      ? null
      : countValue(grow.level, 'personal_info.data.grow_info.level')
  }
}

export function parseUserInfo(response: XiaohongshuJsonResponse): XiaohongshuUserInfo {
  const data = responseData(response, XIAOHONGSHU_API_ENDPOINTS.userInfo, MAX_DIRECT_RESPONSE_BYTES)
  const record = objectValue(data, 'user_info.data')
  return {
    remoteId: cleanId(record.redId, 'user_info.data.redId'),
    remoteName: cleanString(record.userName, 'user_info.data.userName', 80, false),
    avatarUrl: safeAvatarUrl(record.userAvatar),
    bio: record.userDesc === undefined || record.userDesc === null
      ? ''
      : cleanString(record.userDesc, 'user_info.data.userDesc', 1_000, true)
  }
}

export function parseAccountMetrics(response: XiaohongshuJsonResponse): XiaohongshuAccountMetrics {
  const data = objectValue(
    responseData(response, XIAOHONGSHU_API_ENDPOINTS.accountStats, MAX_DIRECT_RESPONSE_BYTES),
    'note_detail_new.data'
  )
  return {
    seven: parseMetricPeriod(data.seven, 'note_detail_new.data.seven'),
    thirty: parseMetricPeriod(data.thirty, 'note_detail_new.data.thirty')
  }
}

export function parseAnalyzeCaptures(
  responses: readonly XiaohongshuJsonResponse[],
  limit: number,
  requireComplete = true
): XiaohongshuContent[] {
  assertLimit(limit)
  if (!Array.isArray(responses) || responses.length === 0) {
    malformed('没有捕获到小红书作品分析 JSON 响应')
  }
  let aggregateBytes = 0
  let maximumTotal = 0
  const rows: XiaohongshuContent[] = []
  const ids = new Set<string>()
  const pages = new Set<number>()
  const ordered = [...responses].sort((left, right) => pageNumber(left.url) - pageNumber(right.url))
  for (const response of ordered) {
    if (!isNoteAnalyzeListUrl(response.url)) malformed('捕获结果包含非白名单作品接口')
    const bytes = jsonBytes(response.json)
    aggregateBytes += bytes
    if (aggregateBytes > MAX_CAPTURE_TOTAL_BYTES) tooLarge('作品接口捕获结果总量超过 2 MiB')
    const data = objectValue(
      responseData(response, XIAOHONGSHU_API_ENDPOINTS.noteAnalyzeList, MAX_CAPTURE_RESPONSE_BYTES),
      'note_analyze.data'
    )
    const page = pageNumber(response.url)
    if (pages.has(page)) malformed(`作品接口第 ${page} 页重复`)
    pages.add(page)
    const total = countValue(data.total, 'note_analyze.data.total')
    maximumTotal = Math.max(maximumTotal, total)
    if (!Array.isArray(data.note_infos)) malformed('note_analyze.data.note_infos 必须是数组')
    if (data.note_infos.length > MAX_CONTENTS) malformed('单页作品数量超过上限')
    for (const raw of data.note_infos) {
      const content = parseContent(raw)
      if (ids.has(content.id)) {
        throw new XiaohongshuApiError('DUPLICATE_CONTENT', `作品 ID 重复：${content.id}`)
      }
      ids.add(content.id)
      rows.push(content)
      if (rows.length > MAX_CONTENTS) malformed('作品总数量超过 100 条上限')
    }
  }
  const required = Math.min(maximumTotal, limit)
  if (requireComplete && rows.length < required) {
    throw new XiaohongshuApiError(
      'INCOMPLETE_CAPTURE',
      `作品接口仅捕获 ${rows.length}/${required} 条，已拒绝返回不完整数据`
    )
  }
  return rows.slice(0, limit)
}

export function parsePostedCaptures(
  responses: readonly XiaohongshuJsonResponse[],
  limit: number
): XiaohongshuContent[] {
  assertLimit(limit)
  if (!Array.isArray(responses) || responses.length === 0) {
    malformed('没有捕获到小红书作品管理 JSON 响应')
  }
  let aggregateBytes = 0
  let maximumTotal = 0
  let lastHasMore = false
  const rows: XiaohongshuContent[] = []
  const ids = new Set<string>()
  const ordered = [...responses].sort((left, right) => capturePageNumber(left.url) - capturePageNumber(right.url))
  for (const response of ordered) {
    if (!isPostedNotesUrl(response.url)) malformed('捕获结果包含非白名单作品管理接口')
    aggregateBytes += jsonBytes(response.json)
    if (aggregateBytes > MAX_CAPTURE_TOTAL_BYTES) tooLarge('作品管理接口捕获结果总量超过 2 MiB')
    const path = new URL(response.url).pathname
    const data = objectValue(responseData(response, path, MAX_CAPTURE_RESPONSE_BYTES), 'posted_notes.data')
    const nested = optionalObject(data.data, 'posted_notes.data.data')
    const source = firstArraySource([data, nested], ['notes', 'note_list', 'items', 'list'])
    const notes = firstArray(source, ['notes', 'note_list', 'items', 'list'])
    const totalValue = firstDefined(data, ['total', 'note_count', 'count']) ??
      postedTagsTotal(data, 'posted_notes.data.tags') ??
      (nested
        ? firstDefined(nested, ['total', 'note_count', 'count']) ??
          postedTagsTotal(nested, 'posted_notes.data.data.tags')
        : undefined)
    if (totalValue !== undefined) maximumTotal = Math.max(maximumTotal, countValue(totalValue, 'posted_notes.data.total'))
    lastHasMore = data.has_more === true || data.hasMore === true ||
      nested?.has_more === true || nested?.hasMore === true ||
      postedPageHasMore(data, 'posted_notes.data.page') ||
      (nested ? postedPageHasMore(nested, 'posted_notes.data.data.page') : false)
    for (const raw of notes) {
      const content = parsePostedContent(raw)
      if (ids.has(content.id)) continue
      ids.add(content.id)
      rows.push(content)
      if (rows.length > MAX_CONTENTS) malformed('作品管理接口返回超过 100 条上限')
    }
  }
  const required = maximumTotal > 0 ? Math.min(maximumTotal, limit) : rows.length
  if (rows.length < required || (maximumTotal === 0 && lastHasMore && rows.length < limit)) {
    throw new XiaohongshuApiError(
      'INCOMPLETE_CAPTURE',
      `作品管理接口仅捕获 ${rows.length}/${required || limit} 条，已拒绝返回不完整数据`
    )
  }
  return rows.slice(0, limit)
}

export function parseNoteDetailCapture(
  response: XiaohongshuJsonResponse,
  expectedNoteId: string
): string {
  const expected = cleanId(expectedNoteId, 'expectedNoteId')
  const record = objectValue(response, 'transport.response')
  if (!Number.isInteger(record.status) || (record.status as number) < 100 || (record.status as number) > 599) {
    malformed('transport.response.status 非法')
  }
  if (!isNoteDetailApiUrl(record.url)) malformed('作品详情响应来源不在白名单')
  const status = record.status as number
  if (status === 401 || status === 403) {
    throw new XiaohongshuApiError('AUTH_REQUIRED', '小红书登录已失效，请在官方页面重新登录')
  }
  if (isRiskControlCode(status)) {
    throw new XiaohongshuApiError('RISK_CONTROL', '小红书暂时限制了作品详情请求')
  }
  if (status < 200 || status >= 300) {
    throw new XiaohongshuApiError('HTTP_STATUS', `小红书作品详情接口返回 HTTP ${status}`)
  }
  if (jsonBytes(record.json) > MAX_CAPTURE_RESPONSE_BYTES) tooLarge('作品详情响应超过 512 KiB')

  const envelope = objectValue(record.json, 'note_detail.response')
  const code = envelope.code
  const message = typeof envelope.msg === 'string' ? envelope.msg.slice(0, 200) : ''
  if (isRiskControlCode(code) || /(?:验证|风控|频繁|risk|captcha)/i.test(message)) {
    throw new XiaohongshuApiError('RISK_CONTROL', '小红书暂时限制了作品详情请求')
  }
  if ((code !== undefined && code !== 0 && code !== '0') || envelope.success === false) {
    if (/(?:登录|login|auth|session)/i.test(message) || code === 401 || code === -100) {
      throw new XiaohongshuApiError('AUTH_REQUIRED', '小红书登录已失效，请在官方页面重新登录')
    }
    throw new XiaohongshuApiError('API_REJECTED', '小红书作品详情接口拒绝了请求')
  }
  const data = objectValue(envelope.data, 'note_detail.data')
  const actual = cleanId(data.id, 'note_detail.data.id')
  if (actual !== expected) {
    throw new XiaohongshuApiError('CONTENT_MISMATCH', '作品详情响应与请求的作品不一致')
  }
  if (data.desc === undefined || data.desc === null) return ''
  if (typeof data.desc !== 'string') malformed('note_detail.data.desc 必须是字符串')
  return normalizeXiaohongshuExcerpt(data.desc)
}

export function parseNoteDetailCaptures(
  responses: readonly XiaohongshuJsonResponse[],
  expectedNoteId: string
): string {
  if (!Array.isArray(responses) || responses.length === 0 || responses.length > 10) {
    throw new XiaohongshuApiError('INCOMPLETE_CAPTURE', '作品详情接口未返回可验证的 JSON 响应')
  }
  const matches: string[] = []
  let aggregateBytes = 0
  for (const response of responses) {
    aggregateBytes += jsonBytes(response.json)
    if (aggregateBytes > MAX_CAPTURE_TOTAL_BYTES) tooLarge('作品详情捕获结果总量超过 2 MiB')
    try {
      matches.push(parseNoteDetailCapture(response, expectedNoteId))
    } catch (error) {
      if (error instanceof XiaohongshuApiError && error.code === 'CONTENT_MISMATCH') continue
      throw error
    }
  }
  if (matches.length !== 1) {
    throw new XiaohongshuApiError('INCOMPLETE_CAPTURE', '作品详情接口未返回唯一匹配的作品')
  }
  return matches[0]!
}

export function isPostedNotesUrl(value: string): boolean {
  try {
    if (typeof value !== 'string' || value.length > 2_048) return false
    const url = new URL(value, CREATOR_ORIGIN)
    const tab = url.searchParams.get('tab')
    const page = url.searchParams.get('page')
    const pageNum = url.searchParams.get('page_num')
    return url.protocol === 'https:' && url.hostname === 'creator.xiaohongshu.com' &&
      !url.username && !url.password && !url.port &&
      (url.pathname === XIAOHONGSHU_API_ENDPOINTS.postedNotes ||
        url.pathname === XIAOHONGSHU_API_ENDPOINTS.postedNotesLegacy) &&
      (tab === null || tab === '0') &&
      (page === null || /^\d+$/.test(page)) &&
      (pageNum === null || /^[1-9]\d*$/.test(pageNum))
  } catch {
    return false
  }
}

export function isNoteDetailApiUrl(value: unknown): boolean {
  try {
    if (typeof value !== 'string' || value.length > 2_048) return false
    const url = new URL(value)
    if (url.origin !== NOTE_DETAIL_ORIGIN || url.username || url.password || url.port || url.hash ||
      url.pathname !== XIAOHONGSHU_API_ENDPOINTS.noteDetail) return false
    for (const key of url.searchParams.keys()) {
      if (key !== 'note_id' && key !== 'edit_mode' && key !== 'source') return false
    }
    if (url.searchParams.getAll('note_id').length !== 1 ||
      url.searchParams.getAll('edit_mode').length !== 1 ||
      url.searchParams.getAll('source').length !== 1) return false
    const noteId = url.searchParams.get('note_id') ?? ''
    const editMode = url.searchParams.get('edit_mode') ?? ''
    const source = url.searchParams.get('source') ?? ''
    return ID_RE.test(noteId) && /^[A-Za-z0-9_-]{0,64}$/.test(editMode) &&
      /^[A-Za-z0-9_-]{0,64}$/.test(source)
  } catch {
    return false
  }
}

export function isCreatorNoteUpdateRoute(value: unknown): boolean {
  try {
    if (typeof value !== 'string' || value.length > 2_048) return false
    const url = new URL(value)
    if (url.origin !== CREATOR_ORIGIN || url.username || url.password || url.port || url.hash ||
      url.pathname !== '/publish/update') return false
    for (const key of url.searchParams.keys()) {
      if (key !== 'id' && key !== 'noteType') return false
    }
    return url.searchParams.getAll('id').length === 1 &&
      url.searchParams.getAll('noteType').length === 1 &&
      ID_RE.test(url.searchParams.get('id') ?? '') &&
      ['normal', 'video'].includes(url.searchParams.get('noteType') ?? '')
  } catch {
    return false
  }
}

function mergeContents(
  posted: readonly XiaohongshuContent[],
  analyzed: readonly XiaohongshuContent[],
  limit: number
): XiaohongshuContent[] {
  const analyzedById = new Map(analyzed.map((content) => [content.id, content]))
  const result = posted.map((content) => {
    const metrics = analyzedById.get(content.id)
    if (!metrics) return content
    analyzedById.delete(content.id)
    return {
      ...content,
      title: content.title || metrics.title,
      bodyExcerpt: content.bodyExcerpt || metrics.bodyExcerpt,
      postTime: content.postTime ?? metrics.postTime,
      type: content.type ?? metrics.type,
      readCount: metrics.readCount,
      likeCount: metrics.likeCount,
      favoriteCount: metrics.favoriteCount,
      commentCount: metrics.commentCount,
      shareCount: metrics.shareCount
    }
  })
  return result.slice(0, limit)
}

export function isNoteAnalyzeListUrl(value: string): boolean {
  try {
    if (typeof value !== 'string' || value.length > 2_048) return false
    const url = new URL(value, CREATOR_ORIGIN)
    return url.protocol === 'https:' && url.hostname === 'creator.xiaohongshu.com' &&
      !url.username && !url.password && !url.port &&
      url.pathname === XIAOHONGSHU_API_ENDPOINTS.noteAnalyzeList
  } catch {
    return false
  }
}

function parseMetricPeriod(value: unknown, path: string): XiaohongshuMetricPeriod {
  const period = objectValue(value, path)
  return {
    views: countValue(period.view_count, `${path}.view_count`),
    averageViewTimeMs: countValue(period.view_time_avg, `${path}.view_time_avg`),
    homeViews: countValue(period.home_view_count, `${path}.home_view_count`),
    likes: countValue(period.like_count, `${path}.like_count`),
    favorites: countValue(period.collect_count, `${path}.collect_count`),
    comments: countValue(period.comment_count, `${path}.comment_count`),
    danmaku: countValue(period.danmaku_count, `${path}.danmaku_count`),
    shares: countValue(period.share_count, `${path}.share_count`),
    newFollowers: countValue(period.rise_fans_count, `${path}.rise_fans_count`)
  }
}

function parseContent(value: unknown): XiaohongshuContent {
  const item = objectValue(value, 'note_analyze.data.note_infos[]')
  const id = cleanId(item.id, 'note.id')
  return {
    id,
    // The API can temporarily return an empty title for a newly published note.
    // Keep that API value instead of deriving text from the page.
    title: cleanString(item.title, 'note.title', 200, true),
    bodyExcerpt: safeExcerpt(item.desc),
    postTime: timestampValue(item.post_time, 'note.post_time'),
    readCount: countValue(item.read_count, 'note.read_count'),
    likeCount: countValue(item.like_count, 'note.like_count'),
    favoriteCount: countValue(item.fav_count, 'note.fav_count'),
    commentCount: countValue(item.comment_count, 'note.comment_count'),
    shareCount: item.share_count === undefined || item.share_count === null
      ? null
      : countValue(item.share_count, 'note.share_count'),
    type: contentType(item.type ?? item.note_type),
    url: publicNoteUrl(id)
  }
}

function parsePostedContent(value: unknown): XiaohongshuContent {
  const item = objectValue(value, 'posted_notes.data.notes[]')
  const id = cleanId(
    firstDefined(item, ['note_id', 'noteId', 'id', 'item_id', 'display_id']),
    'posted_note.id'
  )
  return {
    id,
    title: cleanString(
      firstDefined(item, ['display_title', 'title', 'note_title', 'name']) ?? '',
      'posted_note.title',
      200,
      true
    ),
    bodyExcerpt: safeExcerpt(item.desc),
    postTime: optionalTimestamp(
      firstDefined(item, ['post_time', 'publish_time', 'published_at', 'create_time', 'createTime', 'time']),
      'posted_note.publish_time'
    ),
    readCount: optionalCount(firstDefined(item, ['read_count', 'view_count', 'views']), 'posted_note.read_count'),
    likeCount: optionalCount(firstDefined(item, ['like_count', 'likes']), 'posted_note.like_count'),
    favoriteCount: optionalCount(
      firstDefined(item, ['fav_count', 'collect_count', 'collected_count', 'favorite_count']),
      'posted_note.favorite_count'
    ),
    commentCount: optionalCount(
      firstDefined(item, ['comment_count', 'comments_count', 'comments']),
      'posted_note.comment_count'
    ),
    shareCount: optionalCount(
      firstDefined(item, ['share_count', 'shared_count', 'shares']),
      'posted_note.share_count'
    ),
    type: contentType(firstDefined(item, ['type', 'note_type'])),
    url: publicNoteUrl(
      id,
      safeXsecToken(firstDefined(item, ['xsec_token', 'xsecToken'])),
      safeXsecSource(firstDefined(item, ['xsec_source', 'xsecSource']))
    )
  }
}

function publicNoteUrl(id: string, token: string | null = null, source: string | null = null): string {
  const url = new URL(`/explore/${encodeURIComponent(id)}`, PUBLIC_NOTE_ORIGIN)
  if (token) {
    url.searchParams.set('xsec_token', token)
    url.searchParams.set('xsec_source', source ?? 'pc_user')
  }
  return url.toString()
}

function creatorNoteUpdateUrl(content: Pick<XiaohongshuContent, 'id' | 'type'>): string {
  const url = new URL('/publish/update', CREATOR_ORIGIN)
  url.searchParams.set('id', content.id)
  url.searchParams.set('noteType', content.type === 'video' ? 'video' : 'normal')
  return url.toString()
}

function safeXsecToken(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const token = value.trim()
  if (token.length < 1 || token.length > 1_024 || /\s|[\u0000-\u001f\u007f]/u.test(token)) return null
  return /^[A-Za-z0-9._~+/_=-]+$/.test(token) ? token : null
}

function safeXsecSource(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const source = value.trim()
  return /^[A-Za-z0-9_-]{1,64}$/.test(source) ? source : null
}

export function normalizeXiaohongshuExcerpt(value: string): string {
  const normalized = value
    .replace(/[\u0000-\u001f\u007f-\u009f]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  return Array.from(normalized).slice(0, MAX_EXCERPT_CHARACTERS).join('')
}

function safeExcerpt(value: unknown): string {
  return typeof value === 'string' ? normalizeXiaohongshuExcerpt(value) : ''
}

function isRiskControlCode(value: unknown): boolean {
  const code = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value
  return code === 429 || code === 461 || code === 471
}

function waitFor(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function responseData(
  response: XiaohongshuJsonResponse,
  expectedPath: string,
  maximumBytes: number
): unknown {
  const record = objectValue(response, 'transport.response')
  if (!Number.isInteger(record.status) || (record.status as number) < 100 || (record.status as number) > 599) {
    malformed('transport.response.status 非法')
  }
  validateOfficialUrl(record.url, expectedPath)
  const status = record.status as number
  if (status === 401 || status === 403) {
    throw new XiaohongshuApiError('AUTH_REQUIRED', '小红书登录已失效，请在官方页面重新登录')
  }
  if (status === 406) {
    throw new XiaohongshuApiError('SIGNATURE_REQUIRED', '当前请求需要在账号浏览器中重新发起')
  }
  if (isRiskControlCode(status)) {
    throw new XiaohongshuApiError('RISK_CONTROL', '小红书暂时限制了数据请求')
  }
  if (status < 200 || status >= 300) {
    throw new XiaohongshuApiError('HTTP_STATUS', `小红书只读接口返回 HTTP ${status}`)
  }
  if (jsonBytes(record.json) > maximumBytes) tooLarge(`接口 ${expectedPath} 响应超过大小上限`)
  const envelope = objectValue(record.json, `${expectedPath}.response`)
  const code = envelope.code
  const success = envelope.success
  if ((code !== undefined && code !== 0 && code !== '0') || success === false) {
    const message = typeof envelope.msg === 'string' ? envelope.msg.slice(0, 200) : '平台拒绝请求'
    if (isRiskControlCode(code) || /(?:验证|风控|频繁|risk|captcha)/i.test(message)) {
      throw new XiaohongshuApiError('RISK_CONTROL', '小红书暂时限制了数据请求')
    }
    if (/(?:登录|login|auth|session)/i.test(message) || code === 401 || code === -100) {
      throw new XiaohongshuApiError('AUTH_REQUIRED', '小红书登录已失效，请在官方页面重新登录')
    }
    throw new XiaohongshuApiError('API_REJECTED', `小红书接口拒绝请求：${message}`)
  }
  if (!Object.prototype.hasOwnProperty.call(envelope, 'data')) malformed(`${expectedPath} 响应缺少 data`)
  return envelope.data
}

function validateOfficialUrl(value: unknown, expectedPath: string): void {
  if (typeof value !== 'string' || value.length > 2_048) malformed('接口 URL 非法')
  let url: URL
  try {
    url = new URL(value)
  } catch {
    malformed('接口 URL 非法')
  }
  if (url!.protocol !== 'https:' || url!.hostname !== 'creator.xiaohongshu.com' || url!.pathname !== expectedPath) {
    malformed('接口响应来源不在小红书官方只读白名单')
  }
}

function objectValue(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) malformed(`${path} 必须是对象`)
  return value as Record<string, unknown>
}

function optionalObject(value: unknown, path: string): Record<string, unknown> | null {
  if (value === undefined || value === null) return null
  return objectValue(value, path)
}

function firstArray(record: Record<string, unknown>, names: readonly string[]): unknown[] {
  for (const name of names) {
    if (Array.isArray(record[name])) return record[name]
  }
  malformed(`响应缺少数组字段：${names.join('/')}`)
}

function firstArraySource(
  records: readonly (Record<string, unknown> | null)[],
  names: readonly string[]
): Record<string, unknown> {
  for (const record of records) {
    if (record && names.some((name) => Array.isArray(record[name]))) return record
  }
  malformed(`响应缺少数组字段：${names.join('/')}`)
}

function cleanString(value: unknown, path: string, maximum: number, allowEmpty: boolean): string {
  if (typeof value !== 'string') malformed(`${path} 必须是字符串`)
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) malformed(`${path} 包含控制字符`)
  const text = value.trim()
  if ((!allowEmpty && text.length === 0) || text.length > maximum) malformed(`${path} 长度非法`)
  return text
}

function cleanId(value: unknown, path: string): string {
  if (typeof value !== 'string' && typeof value !== 'number') malformed(`${path} 必须是账号或作品 ID`)
  const id = String(value)
  if (!ID_RE.test(id)) malformed(`${path} 格式非法`)
  return id
}

function safeAvatarUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2_048) return null
  try {
    const url = new URL(value)
    const hostname = url.hostname.toLowerCase()
    const officialHost = ['xhscdn.com', 'xiaohongshu.com'].some((root) =>
      hostname === root || hostname.endsWith(`.${root}`)
    )
    if (
      url.protocol !== 'https:' || !officialHost || url.username || url.password || url.port
    ) return null
    url.hash = ''
    return url.toString()
  } catch {
    return null
  }
}

function countValue(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > MAX_COUNT) {
    malformed(`${path} 必须是非负安全整数`)
  }
  return value as number
}

function optionalCount(value: unknown, path: string): number | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value === 'string' && /^\d+$/.test(value)) value = Number(value)
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > MAX_COUNT) return null
  return value as number
}

function timestampValue(value: unknown, path: string): string {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) malformed(`${path} 必须是毫秒时间戳`)
  const date = new Date(value as number)
  const year = date.getUTCFullYear()
  if (!Number.isFinite(date.getTime()) || year < 2000 || year > 2100) malformed(`${path} 超出允许范围`)
  return date.toISOString()
}

function optionalTimestamp(value: unknown, path: string): string | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value === 'string' && /^\d+$/.test(value)) value = Number(value)
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (!Number.isFinite(parsed)) return null
    value = parsed
  }
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value < 10_000_000_000) {
    value *= 1_000
  }
  try {
    return timestampValue(value, path)
  } catch {
    return null
  }
}

function contentType(value: unknown): XiaohongshuContentType | null {
  if (value === undefined || value === null || value === '') return null
  if (value === 'post' || value === 'image' || value === 'video') return value
  if (value === 1 || value === '1' || value === 'normal') return 'image'
  if (value === 2 || value === '2') return 'video'
  return null
}

function firstDefined(record: Record<string, unknown>, names: readonly string[]): unknown {
  for (const name of names) {
    if (record[name] !== undefined && record[name] !== null && record[name] !== '') return record[name]
  }
  return undefined
}

function postedTagsTotal(record: Record<string, unknown>, path: string): number | undefined {
  if (record.tags === undefined || record.tags === null) return undefined
  if (!Array.isArray(record.tags)) malformed(`${path} 必须是数组`)
  let maximum: number | undefined
  for (const [index, value] of record.tags.entries()) {
    const tag = objectValue(value, `${path}[${index}]`)
    if (tag.notes_count === undefined || tag.notes_count === null) continue
    const count = countValue(tag.notes_count, `${path}[${index}].notes_count`)
    maximum = maximum === undefined ? count : Math.max(maximum, count)
  }
  return maximum
}

function postedPageHasMore(record: Record<string, unknown>, path: string): boolean {
  if (record.page === undefined || record.page === null) return false
  if (!Number.isSafeInteger(record.page) || (record.page as number) < -1) malformed(`${path} 非法`)
  return record.page !== -1
}

function assertExpectedIdentity(expected: string, actual: string): void {
  if (expected !== actual) {
    throw new XiaohongshuApiError(
      'IDENTITY_MISMATCH',
      `当前小红书登录身份 ${actual} 与本地绑定身份 ${expected} 不一致`
    )
  }
}

function assertLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_CONTENTS) malformed('作品同步上限必须是 1 到 100')
}

function pageNumber(value: string): number {
  try {
    const page = Number(new URL(value, CREATOR_ORIGIN).searchParams.get('page_num') || '1')
    return Number.isInteger(page) && page > 0 && page <= 100 ? page : 1
  } catch {
    return 1
  }
}

function capturePageNumber(value: string): number {
  try {
    const search = new URL(value, CREATOR_ORIGIN).searchParams
    const pageNum = Number(search.get('page_num') || '')
    if (Number.isInteger(pageNum) && pageNum > 0 && pageNum <= 100) return pageNum
    const page = Number(search.get('page') || '')
    return Number.isInteger(page) && page >= 0 && page < 100 ? page + 1 : 1
  } catch {
    return 1
  }
}

function jsonBytes(value: unknown): number {
  try {
    const serialized = JSON.stringify(value)
    if (serialized === undefined) malformed('接口响应不是 JSON 值')
    return Buffer.byteLength(serialized, 'utf8')
  } catch (error) {
    if (error instanceof XiaohongshuApiError) throw error
    malformed('接口响应无法序列化为 JSON')
  }
}

function malformed(message: string): never {
  throw new XiaohongshuApiError('MALFORMED_RESPONSE', message)
}

function tooLarge(message: string): never {
  throw new XiaohongshuApiError('RESPONSE_TOO_LARGE', message)
}
