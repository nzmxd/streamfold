import { describe, expect, it, vi } from 'vitest'
import {
  XiaohongshuApi,
  XiaohongshuApiError,
  XIAOHONGSHU_API_ENDPOINTS,
  XIAOHONGSHU_API_ROUTES,
  isNoteAnalyzeListUrl,
  isPostedNotesUrl,
  parseAccountMetrics,
  parseAnalyzeCaptures,
  parsePersonalInfo,
  parsePostedCaptures,
  parseUserInfo,
  type XiaohongshuApiTransport,
  type XiaohongshuJsonResponse
} from './xiaohongshu-api'

const origin = 'https://creator.xiaohongshu.com'

function response(path: string, json: unknown, status = 200): XiaohongshuJsonResponse {
  return { status, url: `${origin}${path}`, json }
}

function profile(
  id = '5605904194',
  name = '测试本人账号',
  bio = '本人账号简介'
): XiaohongshuJsonResponse {
  return response(XIAOHONGSHU_API_ENDPOINTS.personalInfo, {
    code: 0,
    data: {
      red_num: id,
      name,
      fans_count: 12,
      follow_count: 119,
      faved_count: 122,
      personal_desc: bio,
      grow_info: { level: 3 }
    }
  })
}

function userInfo(
  id = '5605904194',
  name = '测试本人账号',
  avatar: unknown = 'https://sns-avatar-qc.xhscdn.com/avatar/test.webp'
): XiaohongshuJsonResponse {
  return response(XIAOHONGSHU_API_ENDPOINTS.userInfo, {
    code: 0,
    data: {
      redId: id,
      userName: name,
      userAvatar: avatar,
      userDesc: '备用本人账号简介'
    }
  })
}

function directResponse(endpoint: string): XiaohongshuJsonResponse {
  if (endpoint === XIAOHONGSHU_API_ENDPOINTS.personalInfo) return profile()
  if (endpoint === XIAOHONGSHU_API_ENDPOINTS.userInfo) return userInfo()
  return stats()
}

function period(seed: number): Record<string, number> {
  return {
    view_count: seed + 1,
    view_time_avg: seed + 2,
    home_view_count: seed + 3,
    like_count: seed + 4,
    collect_count: seed + 5,
    comment_count: seed + 6,
    danmaku_count: seed + 7,
    share_count: seed + 8,
    rise_fans_count: seed + 9
  }
}

function stats(): XiaohongshuJsonResponse {
  return response(XIAOHONGSHU_API_ENDPOINTS.accountStats, {
    code: 0,
    data: { seven: period(0), thirty: period(100) }
  })
}

function note(
  id = 'aaaaaaaaaaaaaaaaaaaaaaaa',
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id,
    title: 'API 返回的测试笔记',
    post_time: Date.parse('2026-03-18T12:01:00.000Z'),
    read_count: 521,
    like_count: 18,
    fav_count: 10,
    comment_count: 7,
    share_count: 2,
    type: 1,
    ...overrides
  }
}

function capture(
  items: unknown[],
  total = items.length,
  page = 1
): XiaohongshuJsonResponse {
  return response(
    `${XIAOHONGSHU_API_ENDPOINTS.noteAnalyzeList}?type=0&page_size=10&page_num=${page}`,
    { code: 0, data: { total, note_infos: items } }
  )
}

function postedCapture(
  items: unknown[],
  total = items.length
): XiaohongshuJsonResponse {
  return response(
    `${XIAOHONGSHU_API_ENDPOINTS.postedNotes}?tab=0&page=0`,
    { code: 0, success: true, data: { total, notes: items, has_more: false } }
  )
}

function postedNote(
  id = 'aaaaaaaaaaaaaaaaaaaaaaaa',
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    note_id: id,
    display_title: 'API 返回的测试笔记',
    publish_time: Date.parse('2026-03-18T12:01:00.000Z'),
    type: 1,
    ...overrides
  }
}

function expectCode(action: () => unknown, code: string): void {
  try {
    action()
    throw new Error('expected XiaohongshuApiError')
  } catch (error) {
    expect(error).toBeInstanceOf(XiaohongshuApiError)
    expect((error as XiaohongshuApiError).code).toBe(code)
  }
}

describe('XiaohongshuApi JSON-only adapter', () => {
  it('maps personal_info, note_detail_new and signed analyze JSON', async () => {
    const directJson = vi.fn(async (endpoint: string) => directResponse(endpoint))
    const captureSignedJson = vi.fn(async (
      route: string,
      _selector: string | ((url: string) => boolean)
    ) => route === XIAOHONGSHU_API_ROUTES.noteManager
      ? [postedCapture([postedNote()])]
      : [capture([note()])])
    const api = new XiaohongshuApi({ directJson, captureSignedJson })

    await expect(api.collect('5605904194', 20)).resolves.toEqual({
      identity: { remoteId: '5605904194', remoteName: '测试本人账号' },
      profile: {
        remoteId: '5605904194',
        remoteName: '测试本人账号',
        avatarUrl: 'https://sns-avatar-qc.xhscdn.com/avatar/test.webp',
        followers: 12,
        following: 119,
        likesAndFavorites: 122,
        bio: '本人账号简介',
        creatorLevel: 3
      },
      accountMetrics: {
        seven: {
          views: 1,
          averageViewTimeMs: 2,
          homeViews: 3,
          likes: 4,
          favorites: 5,
          comments: 6,
          danmaku: 7,
          shares: 8,
          newFollowers: 9
        },
        thirty: {
          views: 101,
          averageViewTimeMs: 102,
          homeViews: 103,
          likes: 104,
          favorites: 105,
          comments: 106,
          danmaku: 107,
          shares: 108,
          newFollowers: 109
        }
      },
      contents: [{
        id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
        title: 'API 返回的测试笔记',
        postTime: '2026-03-18T12:01:00.000Z',
        readCount: 521,
        likeCount: 18,
        favoriteCount: 10,
        commentCount: 7,
        shareCount: 2,
        type: 'image',
        url: `${origin}/statistics/note-detail?noteId=aaaaaaaaaaaaaaaaaaaaaaaa`
      }]
    })
    expect(captureSignedJson).toHaveBeenNthCalledWith(
      1,
      XIAOHONGSHU_API_ROUTES.noteManager,
      'posted_notes',
      20
    )
    expect(captureSignedJson).toHaveBeenNthCalledWith(
      2,
      XIAOHONGSHU_API_ROUTES.noteAnalytics,
      'note_analyze_list',
      20
    )
    expect(directJson).toHaveBeenCalledTimes(5)
  })

  it('keeps a fresh note empty title without using a page fallback', () => {
    expect(parseAnalyzeCaptures([capture([note(undefined, { title: '', share_count: undefined })])], 1)[0])
      .toMatchObject({ title: '', shareCount: null })
  })

  it('merges the full posted-note list with available analytics by note id', async () => {
    const oldId = 'bbbbbbbbbbbbbbbbbbbbbbbb'
    const api = new XiaohongshuApi({
      directJson: vi.fn(async (endpoint) => directResponse(endpoint)),
      captureSignedJson: vi.fn(async (route) => route === XIAOHONGSHU_API_ROUTES.noteManager
        ? [postedCapture([
            postedNote(),
            postedNote(oldId, { display_title: '较早作品', publish_time: 1_700_000_000 })
          ])]
        : [capture([
            note(),
            note('cccccccccccccccccccccccc', { title: '不在作品管理列表中的旧分析项' })
          ], 2)])
    })

    const result = await api.collect('5605904194', 20)
    expect(result.contents).toHaveLength(2)
    expect(result.contents[0]).toMatchObject({ id: 'aaaaaaaaaaaaaaaaaaaaaaaa', readCount: 521 })
    expect(result.contents[1]).toMatchObject({
      id: oldId,
      title: '较早作品',
      postTime: '2023-11-14T22:13:20.000Z',
      readCount: null,
      likeCount: null
    })
    expect(result.contents.some((item) => item.id === 'cccccccccccccccccccccccc')).toBe(false)
  })

  it('reports HTTP login expiry and API login expiry', () => {
    expectCode(() => parsePersonalInfo(response(
      XIAOHONGSHU_API_ENDPOINTS.personalInfo,
      {},
      401
    )), 'AUTH_REQUIRED')
    expectCode(() => parsePersonalInfo(response(XIAOHONGSHU_API_ENDPOINTS.personalInfo, {
      code: -100,
      msg: '登录状态已过期',
      data: null
    })), 'AUTH_REQUIRED')
  })

  it('reports 406 without falling back to DOM', () => {
    expectCode(() => parseAnalyzeCaptures([
      response(`${XIAOHONGSHU_API_ENDPOINTS.noteAnalyzeList}?page_num=1`, {}, 406)
    ], 1), 'SIGNATURE_REQUIRED')
  })

  it('rejects malformed fields, non-official URLs and excessive values', () => {
    expectCode(() => parsePersonalInfo(response(XIAOHONGSHU_API_ENDPOINTS.personalInfo, {
      code: 0,
      data: { user_id: 'bad id', name: '测试', fans_count: 1, follow_count: 2, faved_count: 3 }
    })), 'MALFORMED_RESPONSE')
    expectCode(() => parseAccountMetrics({
      ...stats(),
      url: 'https://attacker.example/api/galaxy/creator/data/note_detail_new'
    }), 'MALFORMED_RESPONSE')
    expectCode(() => parseAnalyzeCaptures([
      capture([note(undefined, { read_count: 1_000_000_000_001 })])
    ], 1), 'MALFORMED_RESPONSE')
  })

  it('cross-checks user_info identity and accepts only official HTTPS avatar hosts', async () => {
    expect(parseUserInfo(userInfo())).toMatchObject({
      remoteId: '5605904194',
      remoteName: '测试本人账号',
      avatarUrl: 'https://sns-avatar-qc.xhscdn.com/avatar/test.webp'
    })
    for (const avatar of [
      'http://sns-avatar-qc.xhscdn.com/avatar/test.webp',
      'https://xhscdn.com.evil.example/avatar/test.webp',
      'https://user@xhscdn.com/avatar/test.webp',
      'https://xhscdn.com:444/avatar/test.webp',
      'not a url'
    ]) {
      expect(parseUserInfo(userInfo('5605904194', '测试本人账号', avatar)).avatarUrl).toBeNull()
    }

    const api = new XiaohongshuApi({
      directJson: vi.fn(async (endpoint) => endpoint === XIAOHONGSHU_API_ENDPOINTS.personalInfo
        ? profile()
        : userInfo('other-account', '另一个账号')),
      captureSignedJson: vi.fn()
    })
    await expect(api.getProfile()).rejects.toMatchObject({ code: 'IDENTITY_MISMATCH' })

    const fallback = new XiaohongshuApi({
      directJson: vi.fn(async (endpoint) => endpoint === XIAOHONGSHU_API_ENDPOINTS.personalInfo
        ? profile('5605904194', '测试本人账号', '')
        : userInfo()),
      captureSignedJson: vi.fn()
    })
    await expect(fallback.getProfile()).resolves.toMatchObject({ bio: '备用本人账号简介' })
  })

  it('rejects an identity switch before returning a snapshot', async () => {
    let profileReads = 0
    const transport: XiaohongshuApiTransport = {
      directJson: vi.fn(async (endpoint) => {
        if (endpoint === XIAOHONGSHU_API_ENDPOINTS.accountStats) return stats()
        if (endpoint === XIAOHONGSHU_API_ENDPOINTS.personalInfo) {
          profileReads += 1
          return profileReads === 1 ? profile() : profile('other-account', '另一个账号')
        }
        return profileReads === 1 ? userInfo() : userInfo('other-account', '另一个账号')
      }),
      captureSignedJson: vi.fn(async (route) => route === XIAOHONGSHU_API_ROUTES.noteManager
        ? [postedCapture([postedNote()])]
        : [capture([note()])])
    }
    await expect(new XiaohongshuApi(transport).collect('5605904194', 1)).rejects.toMatchObject({
      code: 'IDENTITY_MISMATCH'
    })
  })

  it('rejects duplicate content ids across captured pages', () => {
    expectCode(() => parseAnalyzeCaptures([
      capture([note()], 2, 1),
      capture([note()], 2, 2)
    ], 2), 'DUPLICATE_CONTENT')
  })

  it('rejects partial captures and all configured upper-bound violations', async () => {
    expectCode(() => parseAnalyzeCaptures([capture([note()], 5)], 5), 'INCOMPLETE_CAPTURE')
    expectCode(() => parseAnalyzeCaptures([
      capture(Array.from({ length: 101 }, (_, index) => note(String(index).padStart(24, '0'))), 101)
    ], 100), 'MALFORMED_RESPONSE')
    expectCode(() => parsePersonalInfo(response(XIAOHONGSHU_API_ENDPOINTS.personalInfo, {
      code: 0,
      data: {
        user_id: '5605904194',
        name: '测试账号',
        fans_count: 1,
        follow_count: 2,
        faved_count: 3,
        personal_desc: 'x'.repeat(257 * 1024)
      }
    })), 'RESPONSE_TOO_LARGE')

    const api = new XiaohongshuApi({
      directJson: vi.fn(),
      captureSignedJson: vi.fn()
    })
    await expect(api.getContents(101)).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
  })

  it('only accepts the exact official analyze endpoint', () => {
    expect(isNoteAnalyzeListUrl(`${origin}${XIAOHONGSHU_API_ENDPOINTS.noteAnalyzeList}?page_num=1`)).toBe(true)
    expect(isNoteAnalyzeListUrl('http://creator.xiaohongshu.com/api/galaxy/creator/datacenter/note/analyze/list')).toBe(false)
    expect(isNoteAnalyzeListUrl('https://creator.xiaohongshu.com.evil.test/api/galaxy/creator/datacenter/note/analyze/list')).toBe(false)
    expect(isNoteAnalyzeListUrl(`${origin}/api/galaxy/creator/datacenter/note/analyze/list/extra`)).toBe(false)
    expect(isPostedNotesUrl(`${origin}${XIAOHONGSHU_API_ENDPOINTS.postedNotes}?tab=0&page=0`)).toBe(true)
    expect(isPostedNotesUrl(`${origin}${XIAOHONGSHU_API_ENDPOINTS.postedNotesLegacy}?tab=0&page=0`)).toBe(true)
    expect(isPostedNotesUrl(`${origin}${XIAOHONGSHU_API_ENDPOINTS.postedNotes}?tab=1&page=0`)).toBe(false)
    expect(isPostedNotesUrl(`https://user@creator.xiaohongshu.com${XIAOHONGSHU_API_ENDPOINTS.postedNotes}?tab=0`)).toBe(false)
    expect(isPostedNotesUrl(`https://evil.example${XIAOHONGSHU_API_ENDPOINTS.postedNotes}`)).toBe(false)
  })

  it('rejects incomplete posted-note captures', () => {
    expectCode(() => parsePostedCaptures([postedCapture([postedNote()], 5)], 5), 'INCOMPLETE_CAPTURE')
  })

  it('sorts posted pages, accepts nested response data and tolerates unknown optional fields', () => {
    const first = response(`${XIAOHONGSHU_API_ENDPOINTS.postedNotes}?tab=0&page=0`, {
      code: 0,
      success: true,
      data: {
        data: {
          total: 2,
          has_more: true,
          notes: [postedNote('aaaaaaaaaaaaaaaaaaaaaaaa', {
            read_count: '12',
            type: 'new-kind'
          })]
        }
      }
    })
    const second = response(`${XIAOHONGSHU_API_ENDPOINTS.postedNotes}?tab=0&page=1`, {
      code: 0,
      success: true,
      data: {
        data: {
          total: 2,
          has_more: false,
          notes: [postedNote('bbbbbbbbbbbbbbbbbbbbbbbb', {
            display_title: '第二页',
            read_count: 'not-a-number',
            publish_time: 'not-a-date'
          })]
        }
      }
    })

    const result = parsePostedCaptures([second, first], 2)
    expect(result.map((item) => item.id)).toEqual([
      'aaaaaaaaaaaaaaaaaaaaaaaa',
      'bbbbbbbbbbbbbbbbbbbbbbbb'
    ])
    expect(result[0]).toMatchObject({ readCount: 12, type: null })
    expect(result[1]).toMatchObject({ readCount: null, postTime: null })
  })
})
