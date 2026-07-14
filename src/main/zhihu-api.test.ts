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
  parseZhihuCreatorContent,
  parseZhihuIdentity,
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
  type: 'answer' | 'article',
  id: string,
  createdTime: number
): Record<string, unknown> {
  return {
    type,
    data: {
      id,
      title: type === 'answer' ? '创作中心里的回答' : '创作中心里的文章',
      excerpt: '<p>创作中心 <b>JSON</b> 摘要</p>',
      created_time: createdTime,
      updated_time: createdTime + 60,
      ...(type === 'answer' ? { question_id: '778899' } : {})
    },
    reaction: {
      read_count: 66,
      vote_up_count: 7,
      like_count: 99,
      comment_count: 3,
      collect_count: 4
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
      ZHIHU_API_ENDPOINTS.creatorContents().replace('need_co_creation=1', 'need_co_creation=0')
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
      readCount: null,
      likeCount: 18,
      commentCount: 2,
      shareCount: null,
      favoriteCount: null
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
      readCount: 66,
      likeCount: 7,
      commentCount: 3,
      shareCount: null,
      favoriteCount: 4
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
      likeCount: 7,
      favoriteCount: 4
    })
    expectCode(() => parseZhihuCreatorContent({
      ...creatorContent('article', '99887766', 1_720_000_000),
      type: 'zvideo'
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
