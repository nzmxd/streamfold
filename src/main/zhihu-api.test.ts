import { describe, expect, it, vi } from 'vitest'
import {
  ZHIHU_API_ENDPOINTS,
  ZhihuApi,
  type ZhihuApiErrorCode,
  type ZhihuApiTransport,
  type ZhihuJsonResponse,
  normalizeZhihuApiEndpoint,
  parseZhihuAnswer,
  parseZhihuArticle,
  parseZhihuContentAggregate,
  parseZhihuContentAnalysisList,
  parseZhihuCreatorContent,
  parseZhihuDailyAnalytics,
  parseZhihuIdentity,
  parseZhihuMemberAggregate,
  parseZhihuPin,
  parseZhihuProfile
} from './zhihu-api'

const origin = 'https://www.zhihu.com'
const handle = 'test-user-42'
const remoteId = '00000000-1111-2222-3333-444444444444'

function response(endpoint: string, json: unknown, status = 200): ZhihuJsonResponse {
  return {
    status,
    url: new URL(endpoint, origin).toString(),
    json
  }
}

function identity(
  id = remoteId,
  token = handle,
  name = '知乎测试账号'
): ZhihuJsonResponse {
  return response(ZHIHU_API_ENDPOINTS.identity, { id, url_token: token, name })
}

function profile(overrides: Record<string, unknown> = {}): ZhihuJsonResponse {
  return response(ZHIHU_API_ENDPOINTS.profile(handle), {
    id: remoteId,
    url_token: handle,
    name: '知乎测试账号',
    avatar_url: 'https://pic1.zhimg.com/v2-test_xl.jpg',
    headline: '只同步自己的数据',
    follower_count: 12,
    following_count: 119,
    answer_count: 3,
    articles_count: 2,
    pins_count: 4,
    question_count: 1,
    voteup_count: 124,
    thanked_count: 9,
    favorited_count: 7,
    ...overrides
  })
}

function answer(id = '9007199254740993001', created = 1_720_000_000): Record<string, unknown> {
  return {
    id,
    question: { id: '66442211', title: '怎样验证纯 JSON 采集？' },
    excerpt: '这是接口直接返回的摘要。',
    content: '<p>不应读取或解析这段完整正文</p>',
    voteup_count: 18,
    comment_count: 2,
    created_time: created,
    updated_time: created + 60
  }
}

function article(id = '123456789'): Record<string, unknown> {
  return {
    id,
    title: '一篇测试文章',
    excerpt: '文章摘要',
    voteup_count: 7,
    comment_count: 1,
    created: 1_710_000_000,
    updated: 1_710_000_100
  }
}

function pin(id = '9007199254740993999'): Record<string, unknown> {
  return {
    id,
    excerpt_title: '一条测试想法',
    like_count: 5,
    comment_count: 3,
    repin_count: 2,
    created: 1_700_000_000
  }
}

function creatorContent(
  type: 'answer' | 'article' | 'pin' | 'zvideo',
  id: string,
  createdTime: number
): Record<string, unknown> {
  return {
    type,
    data: {
      id,
      ...(type === 'pin'
        ? { content: [{ type: 'text', own_text: '创作中心里的想法正文' }] }
        : { title: type === 'answer' ? '创作中心里的回答' : type === 'article'
          ? '创作中心里的文章' : '创作中心里的视频' }),
      ...(type === 'pin' ? {} : { excerpt: '<p>创作中心 <b>JSON</b> 摘要</p>' }),
      created_time: createdTime,
      updated_time: createdTime + 60,
      ...(type === 'answer' ? { question_id: '778899' } : {})
    },
    reaction: {
      show_count: 88,
      read_count: 66,
      play_count: 55,
      vote_up_count: 7,
      like_count: 99,
      comment_count: 3,
      collect_count: 4,
      share_count: 2,
      re_pin: 1
    }
  }
}

function list(
  endpoint: string,
  data: unknown[],
  options: {
    isEnd?: boolean
    next?: string | null
    status?: number
    totals?: number
    totalsReal?: number
  } = {}
): ZhihuJsonResponse {
  const isEnd = options.isEnd ?? true
  return response(endpoint, {
    data,
    paging: {
      is_end: isEnd,
      next: options.next ?? null,
      totals: options.totals ?? data.length,
      totals_real: options.totalsReal ?? options.totals ?? data.length
    }
  }, options.status ?? 200)
}

function legacyNext(endpoint: string): string {
  const url = new URL(endpoint, origin)
  return `https://api.zhihu.com${url.pathname.replace('/api/v4', '')}${url.search}`
}

function analyticsMetrics(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pv: 120,
    show: 300,
    play: 40,
    upvote: 12,
    like: 8,
    comment: 5,
    collect: 4,
    share: 3,
    reaction: 2,
    re_pin: 1,
    like_and_reaction: 10,
    new_upvote: 2,
    new_like: 1,
    new_incr_upvote_num: 3,
    new_desc_upvote_num: 1,
    new_incr_like_num: 2,
    new_desc_like_num: 1,
    publish_cnt: 2,
    click_rate: 12.5,
    read_finished_rate: 0.5,
    play_finished_rate: '25%',
    advanced: {
      positive_interact_percent: 0.2,
      follower_translate: -2,
      status: 'normal'
    },
    ...overrides
  }
}

function contentAnalysisItem(token: string, id: string): Record<string, unknown> {
  return {
    type: 'article',
    data: { id, url_token: token, title: `文章 ${id}` },
    reaction: analyticsMetrics()
  }
}

function expectCode(action: () => unknown, code: ZhihuApiErrorCode): void {
  expect(action).toThrowError(expect.objectContaining({ code }))
}

describe('Zhihu JSON API adapter', () => {
  it('normalizes only fixed read-only endpoints and legacy paging.next URLs', () => {
    const answers = ZHIHU_API_ENDPOINTS.answers(handle, 20)
    expect(normalizeZhihuApiEndpoint(`${origin}${answers}`)).toBe(answers)
    expect(normalizeZhihuApiEndpoint(`http://www.zhihu.com${answers}`)).toBe(answers)
    expect(normalizeZhihuApiEndpoint(legacyNext(answers))).toBe(answers)
    expect(normalizeZhihuApiEndpoint(ZHIHU_API_ENDPOINTS.profile(handle))).toBe(
      ZHIHU_API_ENDPOINTS.profile(handle)
    )
    expect(normalizeZhihuApiEndpoint(
      `${origin}${ZHIHU_API_ENDPOINTS.creatorContents(20)}`
    )).toBe(ZHIHU_API_ENDPOINTS.creatorContents(20))
    expect(normalizeZhihuApiEndpoint(
      `${origin}${ZHIHU_API_ENDPOINTS.memberAggregate('2026-07-01', '2026-07-14')}`
    )).toBe(ZHIHU_API_ENDPOINTS.memberAggregate('2026-07-01', '2026-07-14'))
    expect(normalizeZhihuApiEndpoint(ZHIHU_API_ENDPOINTS.memberAggregate()))
      .toBe(ZHIHU_API_ENDPOINTS.memberAggregate())
    expect(normalizeZhihuApiEndpoint(
      ZHIHU_API_ENDPOINTS.memberDaily('2026-07-01', '2026-07-14')
    )).toBe(ZHIHU_API_ENDPOINTS.memberDaily('2026-07-01', '2026-07-14'))
    expect(normalizeZhihuApiEndpoint(ZHIHU_API_ENDPOINTS.contentAnalysisList('article', 20)))
      .toBe(ZHIHU_API_ENDPOINTS.contentAnalysisList('article', 20))
    expect(normalizeZhihuApiEndpoint(ZHIHU_API_ENDPOINTS.contentAggregate('answer', 'answer_42')))
      .toBe(ZHIHU_API_ENDPOINTS.contentAggregate('answer', 'answer_42'))
    expect(normalizeZhihuApiEndpoint(
      ZHIHU_API_ENDPOINTS.contentDaily('zvideo', 'video-42', '2026-07-01', '2026-07-14')
    )).toBe(ZHIHU_API_ENDPOINTS.contentDaily('zvideo', 'video-42', '2026-07-01', '2026-07-14'))

    for (const unsafe of [
      'http://www.zhihu.com/api/v4/me?include=url_token',
      `http://api.zhihu.com${answers}`,
      'https://www.zhihu.com.evil.test/api/v4/me?include=url_token',
      'https://user@www.zhihu.com/api/v4/me?include=url_token',
      'https://www.zhihu.com:443/api/v4/me?include=url_token',
      '/api/v4/me?include=url_token&extra=1',
      `/api/v4/members/${handle}/answers?limit=100&offset=0`,
      `${ZHIHU_API_ENDPOINTS.answers(handle)}&offset=20`,
      `/api/v4/members/${handle}/answers?limit=20&offset=10`,
      `/api/v4/members/${handle}/followers?limit=20&offset=0`,
      `/api/v4/members/${handle}/answers/extra?limit=20&offset=0`,
      `${ZHIHU_API_ENDPOINTS.creatorContents()}&sort_type=updated`,
      ZHIHU_API_ENDPOINTS.creatorContents().replace('limit=20', 'limit=10'),
      ZHIHU_API_ENDPOINTS.creatorContents().replace('need_co_creation=1', 'need_co_creation=0'),
      '/api/v4/creators/analysis/realtime/member/aggr?tab=all&start=2026-07-01',
      '/api/v4/creators/analysis/realtime/member/daily?tab=all&start=2026-07-01&end=2026-10-15',
      ZHIHU_API_ENDPOINTS.contentAnalysisList('article').replace('limit=20', 'limit=10'),
      ZHIHU_API_ENDPOINTS.contentAnalysisList('article').replace('offset=0', 'offset=100'),
      ZHIHU_API_ENDPOINTS.contentAggregate('answer', 'answer_42').replace('type=answer', 'type=question'),
      `${ZHIHU_API_ENDPOINTS.contentDaily('answer', 'answer_42', '2026-07-01', '2026-07-14')}&cookie=1`
    ]) {
      expectCode(() => normalizeZhihuApiEndpoint(unsafe), 'MALFORMED_RESPONSE')
    }
  })

  it('maps identity and profile metrics while keeping platform IDs as strings', () => {
    expect(parseZhihuIdentity(identity())).toEqual({
      remoteId,
      remoteHandle: handle,
      remoteName: '知乎测试账号'
    })
    expect(parseZhihuIdentity(identity('900719925474099312345'))).toMatchObject({
      remoteId: '900719925474099312345'
    })

    expect(parseZhihuProfile(profile(), parseZhihuIdentity(identity()))).toEqual({
      remoteId,
      remoteHandle: handle,
      remoteName: '知乎测试账号',
      avatarUrl: 'https://pic1.zhimg.com/v2-test_xl.jpg',
      bio: '只同步自己的数据',
      followers: 12,
      following: 119,
      answerCount: 3,
      articleCount: 2,
      pinCount: 4,
      questionCount: 1,
      voteupCount: 124,
      thankedCount: 9,
      favoriteCount: 7,
      contentCount: 9,
      likesAndFavoritesTotal: 131
    })
  })

  it('keeps missing profile metrics null instead of fabricating zero', () => {
    const result = parseZhihuProfile(profile({
      follower_count: undefined,
      following_count: undefined,
      answer_count: undefined,
      articles_count: undefined,
      pins_count: undefined,
      voteup_count: undefined,
      favorited_count: undefined
    }))
    expect(result).toMatchObject({
      followers: null,
      following: null,
      answerCount: null,
      articleCount: null,
      pinCount: null,
      voteupCount: null,
      favoriteCount: null,
      contentCount: null,
      likesAndFavoritesTotal: null
    })
  })

  it('maps account aggregates, signed follower conversion and percentage metrics', () => {
    const endpoint = ZHIHU_API_ENDPOINTS.memberAggregate('2026-07-01', '2026-07-14')
    const result = parseZhihuMemberAggregate(response(endpoint, {
      ...analyticsMetrics(),
      today: analyticsMetrics({ pv: 7 }),
      yesterday: analyticsMetrics({ pv: 5 }),
      updated: '2026-07-15 10:30'
    }), endpoint)

    expect(result.metrics).toMatchObject({
      views: 120,
      impressions: 300,
      plays: 40,
      upvotes: 12,
      likes: 8,
      comments: 5,
      favorites: 4,
      shares: 3,
      reposts: 1,
      publishCount: 2,
      clickRate: 0.125,
      readCompletionRate: 0.5,
      playCompletionRate: 0.25,
      advanced: {
        positiveInteractionRate: 0.002,
        followerConversion: -2,
        status: 'normal'
      }
    })
    expect(result.today?.views).toBe(7)
    expect(result.yesterday?.views).toBe(5)
  })

  it('nulls advanced metrics for official unavailable statuses and never fabricates missing values', () => {
    for (const status of ['unnormal_by_level', 'unnormal_by_pv', 'updating']) {
      const endpoint = ZHIHU_API_ENDPOINTS.memberAggregate()
      const result = parseZhihuMemberAggregate(response(endpoint, analyticsMetrics({
        advanced: {
          positive_interact_percent: 2.5,
          follower_translate: 10,
          status
        }
      })), endpoint)
      expect(result.metrics.advanced).toEqual({
        positiveInteractionRate: null,
        followerConversion: null,
        status
      })
    }

    const endpoint = ZHIHU_API_ENDPOINTS.memberAggregate()
    expect(parseZhihuMemberAggregate(response(endpoint, {}), endpoint).metrics).toMatchObject({
      views: null,
      upvotes: null,
      likes: null,
      advanced: { positiveInteractionRate: null, followerConversion: null, status: null }
    })
  })

  it('parses account and content daily history inside the requested date range', () => {
    const memberEndpoint = ZHIHU_API_ENDPOINTS.memberDaily('2026-07-01', '2026-07-02')
    expect(parseZhihuDailyAnalytics(response(memberEndpoint, {
      data: [
        { p_date: '2026-07-02', ...analyticsMetrics({ pv: 2 }) },
        { p_date: '2026-07-01', ...analyticsMetrics({ pv: 1 }) }
      ]
    }), memberEndpoint).map((item) => [item.date, item.views])).toEqual([
      ['2026-07-01', 1],
      ['2026-07-02', 2]
    ])

    const contentEndpoint = ZHIHU_API_ENDPOINTS.contentDaily(
      'article',
      'article-42',
      '2026-07-01',
      '2026-07-02'
    )
    expect(parseZhihuDailyAnalytics(response(contentEndpoint, [
      { p_date: '2026-07-01', pv: 9, like: 2, share: null }
    ]), contentEndpoint)[0]).toMatchObject({ date: '2026-07-01', views: 9, likes: 2, shares: null })
  })

  it('parses content aggregates and paginates analysis lists without requiring paging.next', async () => {
    const aggregateEndpoint = ZHIHU_API_ENDPOINTS.contentAggregate('article', 'article-42')
    expect(parseZhihuContentAggregate(
      response(aggregateEndpoint, { data: analyticsMetrics({ pv: 42 }) }),
      'article',
      'article-42'
    )).toMatchObject({ views: 42, upvotes: 12, likes: 8 })

    const first = ZHIHU_API_ENDPOINTS.contentAnalysisList('article', 0)
    const second = ZHIHU_API_ENDPOINTS.contentAnalysisList('article', 20)
    const getJson = vi.fn(async (endpoint: string) => endpoint === first
      ? list(endpoint, [contentAnalysisItem('token-1', '1')], {
          isEnd: false,
          next: null,
          totals: 2,
          totalsReal: 2
        })
      : list(endpoint, [contentAnalysisItem('token-2', '2')], {
          totals: 2,
          totalsReal: 2
        }))
    const result = await new ZhihuApi({ getJson }).getContentAnalysisItems('article', 2)
    expect(result.map((item) => item.contentToken)).toEqual(['token-1', 'token-2'])
    expect(result[0]?.metrics).toMatchObject({ views: 120, upvotes: 12, likes: 8 })
    expect(getJson.mock.calls.map(([endpoint]) => endpoint)).toEqual([first, second])
  })

  it('prefers explicit analysis tokens and normalizes safe numeric response tokens', () => {
    const endpoint = ZHIHU_API_ENDPOINTS.contentAnalysisList('article')
    const parsed = parseZhihuContentAnalysisList(response(endpoint, {
      data: [{
        type: 'article',
        content_token: 'official-token-42',
        data: { id: 42, url_token: 'nested-token-42', title: '外层 token 的文章' },
        reaction: analyticsMetrics()
      }, {
        content_type: 'article',
        content_token: 43,
        content_id: 43,
        content_title: '数字 token 的文章',
        ...analyticsMetrics()
      }],
      paging: { is_end: true, totals: 2, totals_real: 2, next: null }
    }), 'article', endpoint)

    expect(parsed.items).toEqual([
      expect.objectContaining({ contentToken: 'official-token-42', contentId: '42' }),
      expect.objectContaining({ contentToken: '43', contentId: '43' })
    ])
  })

  it('rejects unsafe or malformed numeric analysis tokens', () => {
    const endpoint = ZHIHU_API_ENDPOINTS.contentAnalysisList('article')
    for (const contentToken of [Number.MAX_SAFE_INTEGER + 1, -1, 1.5, {}, 'bad token!']) {
      expectCode(() => parseZhihuContentAnalysisList(response(endpoint, {
        data: [{
          content_type: 'article',
          content_token: contentToken,
          content_id: '42',
          content_title: '非法 token 的文章'
        }],
        paging: { is_end: true, totals: 1, totals_real: 1, next: null }
      }), 'article', endpoint), 'MALFORMED_RESPONSE')
    }
  })

  it('rejects analysis dates outside the request and unsafe content-list paging', () => {
    const endpoint = ZHIHU_API_ENDPOINTS.memberDaily('2026-07-01', '2026-07-02')
    expectCode(() => parseZhihuDailyAnalytics(response(endpoint, [
      { p_date: '2026-07-03', pv: 1 }
    ]), endpoint), 'MALFORMED_RESPONSE')

    const listEndpoint = ZHIHU_API_ENDPOINTS.contentAnalysisList('article')
    expectCode(() => parseZhihuContentAnalysisList(response(listEndpoint, {
      data: [contentAnalysisItem('token-1', '1')],
      paging: { is_end: false, totals: 2, totals_real: 2, next: '/api/v4/me?include=url_token' }
    }), 'article', listEndpoint), 'MALFORMED_RESPONSE')
  })

  it('maps answers, articles and pins to namespaced IDs and canonical original URLs', () => {
    expect(parseZhihuAnswer(answer())).toEqual({
      id: 'answer:66442211:9007199254740993001',
      platformContentId: '9007199254740993001',
      type: 'answer',
      title: '怎样验证纯 JSON 采集？',
      bodyExcerpt: '这是接口直接返回的摘要。',
      url: 'https://www.zhihu.com/question/66442211/answer/9007199254740993001',
      publishedAt: '2024-07-03T09:46:40.000Z',
      updatedAt: '2024-07-03T09:47:40.000Z',
      impressionCount: null,
      readCount: null,
      playCount: null,
      voteUpCount: 18,
      likeCount: null,
      commentCount: 2,
      shareCount: null,
      favoriteCount: null,
      repostCount: null
    })
    expect(parseZhihuArticle(article())).toMatchObject({
      id: 'article:123456789',
      platformContentId: '123456789',
      type: 'article',
      url: 'https://zhuanlan.zhihu.com/p/123456789',
      readCount: null,
      favoriteCount: null
    })
    expect(parseZhihuPin(pin())).toMatchObject({
      id: 'pin:9007199254740993999',
      platformContentId: '9007199254740993999',
      type: 'post',
      url: 'https://www.zhihu.com/pin/9007199254740993999',
      likeCount: 5,
      commentCount: 3,
      shareCount: 2,
      favoriteCount: null
    })
  })

  it('maps authenticated creator rows with owner-only read and collection metrics', () => {
    expect(parseZhihuCreatorContent(creatorContent(
      'answer',
      '9007199254740993555',
      1_730_000_000
    ))).toEqual({
      id: 'answer:778899:9007199254740993555',
      platformContentId: '9007199254740993555',
      type: 'answer',
      title: '创作中心里的回答',
      bodyExcerpt: '创作中心 JSON 摘要',
      url: 'https://www.zhihu.com/question/778899/answer/9007199254740993555',
      publishedAt: '2024-10-27T03:33:20.000Z',
      updatedAt: '2024-10-27T03:34:20.000Z',
      impressionCount: 88,
      readCount: 66,
      playCount: 55,
      voteUpCount: 7,
      likeCount: 99,
      commentCount: 3,
      shareCount: 2,
      favoriteCount: 4,
      repostCount: 1
    })
    expect(parseZhihuCreatorContent(creatorContent(
      'article',
      '99887766',
      1_720_000_000
    ))).toMatchObject({
      id: 'article:99887766',
      type: 'article',
      url: 'https://zhuanlan.zhihu.com/p/99887766',
      readCount: 66,
      voteUpCount: 7,
      likeCount: 99,
      favoriteCount: 4
    })
    expect(parseZhihuCreatorContent(creatorContent(
      'pin',
      '9007199254740993999',
      1_720_000_000
    ))).toMatchObject({
      id: 'pin:9007199254740993999',
      type: 'post',
      title: '创作中心里的想法正文',
      bodyExcerpt: '创作中心里的想法正文',
      url: 'https://www.zhihu.com/pin/9007199254740993999'
    })
    expect(parseZhihuCreatorContent(creatorContent(
      'zvideo',
      '1234567890',
      1_720_000_000
    ))).toMatchObject({
      id: 'zvideo:1234567890',
      type: 'video',
      url: 'https://www.zhihu.com/zvideo/1234567890',
      playCount: 55
    })
    expectCode(() => parseZhihuCreatorContent({
      ...creatorContent('article', '99887766', 1_720_000_000),
      type: 'question'
    }), 'MALFORMED_RESPONSE')
  })

  it('uses only the API excerpt and never falls back to the HTML content field', () => {
    expect(parseZhihuAnswer(answer()).bodyExcerpt).toBe('这是接口直接返回的摘要。')
    expect(parseZhihuAnswer({ ...answer(), excerpt: undefined }).bodyExcerpt).toBe('')
    expect(parseZhihuPin({ ...pin(), excerpt_title: undefined })).toMatchObject({
      title: '无标题想法',
      bodyExcerpt: ''
    })
  })

  it('normalizes markup from JSON excerpts and reads the current reaction like field', () => {
    expect(parseZhihuArticle({
      ...article(),
      excerpt_title: '先看 <b>Node.js &amp; TypeScript</b><br><a href="https://example.test">文档</a>',
      voteup_count: undefined
    })).toMatchObject({
      bodyExcerpt: '先看 Node.js & TypeScript 文档',
      likeCount: null
    })
    expect(parseZhihuAnswer({
      ...answer(),
      voteup_count: undefined,
      reaction: { statistics: { like_count: 26 } }
    })).toMatchObject({ likeCount: 26 })
  })

  it('uses the article update time when the creation time is absent', () => {
    expect(parseZhihuArticle({
      ...article(),
      created: undefined,
      updated: 1_710_000_100
    }).publishedAt).toBe('2024-03-09T16:01:40.000Z')
  })

  it('uses the authenticated creator list as the content source and follows its paging', async () => {
    const firstPage = ZHIHU_API_ENDPOINTS.creatorContents(0)
    const nextPage = ZHIHU_API_ENDPOINTS.creatorContents(20)
    const getJson = vi.fn(async (endpoint: string) => {
      if (endpoint === firstPage) {
        return list(endpoint, [creatorContent('article', '100', 1_700_000_000)], {
          isEnd: false,
          next: `${origin}${nextPage}`,
          totals: 2
        })
      }
      if (endpoint === nextPage) {
        return list(endpoint, [creatorContent('answer', '101', 1_730_000_000)], { totals: 2 })
      }
      throw new Error(`unexpected endpoint: ${endpoint}`)
    })
    const result = await new ZhihuApi({ getJson }).getContents(handle, 2)

    expect(result.map((item) => item.id)).toEqual([
      'article:100',
      'answer:778899:101'
    ])
    expect(getJson.mock.calls.map(([endpoint]) => endpoint)).toEqual([
      firstPage,
      nextPage
    ])
  })

  it('does not silently fall back to public lists when the creator endpoint fails', async () => {
    const getJson = vi.fn(async (endpoint: string) => response(endpoint, {}, 404))
    await expect(new ZhihuApi({ getJson }).getContents(handle, 20)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: '知乎内容管理接口不可用，未返回当前账号的内容数据'
    })
    expect(getJson).toHaveBeenCalledTimes(1)
    expect(getJson).toHaveBeenCalledWith(ZHIHU_API_ENDPOINTS.creatorContents())
  })

  it('rejects incomplete creator pages and totals that change between pages', async () => {
    const firstPage = ZHIHU_API_ENDPOINTS.creatorContents(0)
    const nextPage = ZHIHU_API_ENDPOINTS.creatorContents(20)
    const incomplete = new ZhihuApi({
      getJson: vi.fn(async (endpoint) => list(endpoint, [creatorContent(
        'article',
        '100',
        1_700_000_000
      )], { totals: 2 }))
    })
    await expect(incomplete.getCreatorContents(20)).rejects.toMatchObject({
      code: 'INCOMPLETE_PAGINATION'
    })

    const changing = new ZhihuApi({
      getJson: vi.fn(async (endpoint) => endpoint === firstPage
        ? list(endpoint, [creatorContent('article', '100', 1_700_000_000)], {
            isEnd: false,
            next: `${origin}${nextPage}`,
            totals: 2
          })
        : list(endpoint, [creatorContent('answer', '101', 1_730_000_000)], { totals: 3 }))
    })
    await expect(changing.getCreatorContents(20)).rejects.toMatchObject({
      code: 'MALFORMED_RESPONSE'
    })
  })

  it('accepts valid empty content lists', async () => {
    const transport: ZhihuApiTransport = {
      getJson: vi.fn(async (endpoint) => list(endpoint, []))
    }
    await expect(new ZhihuApi(transport).getContents(handle, 20)).resolves.toEqual([])
  })

  it('rejects unsafe pagination changes, repeated IDs and incomplete pagination', async () => {
    const first = ZHIHU_API_ENDPOINTS.answers(handle, 0)
    const malicious = new ZhihuApi({
      getJson: vi.fn(async (endpoint) => list(endpoint, [answer('100')], {
        isEnd: false,
        next: `https://evil.example/api/v4/members/${handle}/answers?limit=20&offset=20`
      }))
    })
    await expect(malicious.getAnswers(handle, 2)).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })

    const duplicate = new ZhihuApi({
      getJson: vi.fn(async (endpoint) => endpoint === first
        ? list(endpoint, [answer('100')], {
            isEnd: false,
            next: legacyNext(ZHIHU_API_ENDPOINTS.answers(handle, 20))
          })
        : list(endpoint, [answer('100')]))
    })
    await expect(duplicate.getAnswers(handle, 2)).rejects.toMatchObject({ code: 'DUPLICATE_CONTENT' })

    const incomplete = new ZhihuApi({
      getJson: vi.fn(async (endpoint) => {
        const url = new URL(endpoint, origin)
        const offset = Number(url.searchParams.get('offset'))
        return list(endpoint, [], {
          isEnd: false,
          next: legacyNext(ZHIHU_API_ENDPOINTS.answers(handle, offset + 20))
        })
      })
    })
    await expect(incomplete.getAnswers(handle, 1)).rejects.toMatchObject({
      code: 'INCOMPLETE_PAGINATION'
    })
  })

  it('classifies authentication, rate-limit, missing and other HTTP failures', () => {
    for (const [status, code] of [
      [401, 'AUTH_REQUIRED'],
      [403, 'AUTH_REQUIRED'],
      [429, 'RATE_LIMITED'],
      [404, 'NOT_FOUND'],
      [500, 'HTTP_STATUS']
    ] as const) {
      expectCode(() => parseZhihuIdentity(response(
        ZHIHU_API_ENDPOINTS.identity,
        {},
        status
      )), code)
    }
    expectCode(() => parseZhihuMemberAggregate(response(
      ZHIHU_API_ENDPOINTS.memberAggregate(),
      { msg: 'no auth', code: '403' }
    )), 'AUTH_REQUIRED')
    expectCode(() => parseZhihuContentAggregate(response(
      ZHIHU_API_ENDPOINTS.contentAggregate('article', 'article-42'),
      { msg: 'no auth', code: 403 }
    ), 'article', 'article-42'), 'AUTH_REQUIRED')
  })

  it('rejects malformed IDs, counters, response origins and oversized JSON', () => {
    expectCode(() => parseZhihuIdentity(identity('bad id')), 'MALFORMED_RESPONSE')
    expectCode(() => parseZhihuIdentity(identity(9_007_199_254_740_992 as unknown as string)), 'MALFORMED_RESPONSE')
    expectCode(() => parseZhihuProfile(profile({ follower_count: -1 })), 'MALFORMED_RESPONSE')
    expectCode(() => parseZhihuProfile(profile({
      avatar_url: 'https://pic1.zhimg.com.evil.example/avatar.jpg'
    })), 'MALFORMED_RESPONSE')
    expectCode(() => parseZhihuIdentity({
      ...identity(),
      url: 'https://attacker.example/api/v4/me?include=url_token'
    }), 'MALFORMED_RESPONSE')
    expectCode(() => parseZhihuIdentity(response(ZHIHU_API_ENDPOINTS.identity, {
      id: remoteId,
      url_token: handle,
      name: '账号',
      padding: 'x'.repeat(257 * 1024)
    })), 'RESPONSE_TOO_LARGE')
  })

  it('checks identity before and after collection and rejects account switches', async () => {
    let identityReads = 0
    const transport: ZhihuApiTransport = {
      getJson: vi.fn(async (endpoint) => {
        if (endpoint === ZHIHU_API_ENDPOINTS.identity) {
          identityReads += 1
          return identityReads === 1 ? identity() : identity('another-account-id', 'another-user')
        }
        if (endpoint === ZHIHU_API_ENDPOINTS.profile(handle)) return profile()
        return list(endpoint, [])
      })
    }
    await expect(new ZhihuApi(transport).collect(remoteId, 20)).rejects.toMatchObject({
      code: 'IDENTITY_MISMATCH'
    })
  })

  it('rejects a profile that does not belong to the verified identity', () => {
    expectCode(() => parseZhihuProfile(
      profile({ id: 'different-id' }),
      parseZhihuIdentity(identity())
    ), 'IDENTITY_MISMATCH')
  })
})
