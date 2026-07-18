import { describe, expect, it } from 'vitest'
import { createTestHost, type PluginTestHost } from '../../../packages/plugin-sdk/src/test-host'
import type { JsonValue } from '../../../packages/plugin-sdk/src/contracts'
import { executeQuickJsContribution } from './quickjs-engine'
import { DEFAULT_SANDBOX_LIMITS } from './sandbox-protocol'
import {
  X_PLATFORM_CONTRIBUTION_ID,
  X_PLUGIN_ID,
  xEntrySource,
  xPluginManifest
} from './builtin-x.test-fixture'

const OWNER_ID = '900719925474099312345678901'
const OTHER_ID = '900719925474099312345678902'

describe('built-in X platform adapter', () => {
  it('declares only the bounded signed-in web-session surface', () => {
    expect(xPluginManifest.id).toBe(X_PLUGIN_ID)
    expect(xPluginManifest).toMatchObject({ version: '1.2.0', minimumAppVersion: '0.7.11' })
    const contribution = xPluginManifest.contributions[0]
    expect(contribution).toMatchObject({
      id: X_PLATFORM_CONTRIBUTION_ID,
      kind: 'platform.adapter',
      permissions: ['platform.session-json', 'scheduler.run'],
      configSchema: {
        required: ['manualCollectionIntervalMinutes'],
        properties: {
          manualCollectionIntervalMinutes: { default: 5, minimum: 5, maximum: 1440 }
        }
      },
      minimumIntervalSeconds: 300,
      recommendedSyncIntervalHours: 24,
      platform: {
        id: 'x',
        loginUrl: 'https://x.com/i/flow/login',
        homeUrl: 'https://x.com/home',
        navigationHosts: ['x.com'],
        imageHosts: ['pbs.twimg.com'],
        contentUrls: [{
          remoteIdTemplate: '{remoteId}',
          origin: 'https://x.com',
          pathTemplate: '/i/web/status/{remoteId}'
        }]
      }
    })
    if (!contribution || contribution.kind !== 'platform.adapter') throw new Error('Expected platform adapter')
    expect(contribution.endpoints).toEqual([])
    expect(contribution.captures.map(({ id, graphqlOperationName }) => ({ id, graphqlOperationName }))).toEqual([
      { id: 'x.identity.settings', graphqlOperationName: undefined },
      { id: 'x.identity.profile.initial', graphqlOperationName: 'UserByScreenName' },
      { id: 'x.contents.tweets.bound', graphqlOperationName: 'UserTweets' }
    ])
    expect(contribution.captures.find(({ id }) => id === 'x.contents.tweets.bound'))
      .toMatchObject({ maximumResponses: 20 })
  })

  it('proves the authenticated handle before binding the current live profile shape', async () => {
    const host = hostWith({
      'x.identity.settings': [{ screen_name: 'current_handle' }],
      'x.identity.profile.initial': [profileResponse({
        remoteId: OWNER_ID,
        handle: 'Current_Handle',
        name: 'Current owner',
        currentShape: true
      })]
    })

    await expect(invoke(host, 'readIdentity', { expectedRemoteId: null })).resolves.toEqual({
      remoteId: OWNER_ID,
      remoteName: 'Current owner',
      profile: {
        remoteId: OWNER_ID,
        remoteName: 'Current owner',
        avatarUrl: 'https://pbs.twimg.com/profile_images/current.jpg',
        bio: 'Current profile bio',
        creatorLevel: null,
        followers: 123,
        following: 45,
        contentCount: 678,
        viewsTotal: null,
        likesAndFavoritesTotal: null
      }
    })
    expect(host.calls).toEqual([
      {
        operation: 'platform.captureJson',
        payload: { captureId: 'x.identity.settings', params: {}, limit: 1 }
      },
      {
        operation: 'platform.captureJson',
        payload: {
          captureId: 'x.identity.profile.initial',
          params: { handle: 'current_handle' },
          limit: 1
        }
      }
    ])
  })

  it('keeps a large stable ID across handle changes and supports the legacy profile fallback', async () => {
    const host = hostWith({
      'x.identity.settings': [{ screen_name: 'renamed_owner' }],
      'x.identity.profile.initial': [profileResponse({
        remoteId: OWNER_ID,
        handle: 'renamed_owner',
        name: 'Renamed owner',
        currentShape: true,
        root: 'screen-name'
      })]
    })

    const result = await invoke(host, 'readIdentity', { expectedRemoteId: OWNER_ID })
    expect(result).toMatchObject({ remoteId: OWNER_ID, remoteName: 'Renamed owner' })
    expect(host.calls.slice(1)).toEqual([
      {
        operation: 'platform.captureJson',
        payload: {
          captureId: 'x.identity.profile.initial',
          params: { handle: 'renamed_owner' },
          limit: 1
        }
      }
    ])
  })

  it('returns the observed login identity so the host can mark a bound account mismatch', async () => {
    const host = hostWith({
      'x.identity.settings': [{ screen_name: 'other_owner' }],
      'x.identity.profile.initial': [profileResponse({
        remoteId: OTHER_ID,
        handle: 'other_owner',
        name: 'Other owner',
        currentShape: true
      })]
    })

    await expect(invoke(host, 'readIdentity', { expectedRemoteId: OWNER_ID })).resolves.toMatchObject({
      remoteId: OTHER_ID,
      remoteName: 'Other owner'
    })
    expect(host.calls.map((call) => call.payload.captureId)).toEqual([
      'x.identity.settings',
      'x.identity.profile.initial'
    ])
  })

  it('reports empty settings and current-profile captures with bounded stage envelopes', async () => {
    await expect(invoke(hostWith({
      'x.identity.settings': []
    }), 'readIdentity', { expectedRemoteId: null })).resolves.toEqual({
      __streamfoldFailure: 'X_IDENTITY_SETTINGS_EMPTY'
    })

    await expect(invoke(hostWith({
      'x.identity.settings': [{ screen_name: 'authenticated' }],
      'x.identity.profile.initial': []
    }), 'readIdentity', { expectedRemoteId: null })).resolves.toEqual({
      __streamfoldFailure: 'X_IDENTITY_CURRENT_PROFILE_EMPTY'
    })
  })

  it('reports unsupported identity response structures without returning upstream text', async () => {
    const mismatched = hostWith({
      'x.identity.settings': [{ screen_name: 'authenticated' }],
      'x.identity.profile.initial': [profileResponse({
        remoteId: OWNER_ID,
        handle: 'someone_else',
        name: 'Other profile',
        currentShape: true
      })]
    })
    await expect(invoke(mismatched, 'readIdentity', { expectedRemoteId: null }))
      .resolves.toEqual({ __streamfoldFailure: 'X_IDENTITY_RESPONSE_INVALID' })

    const graphqlError = hostWith({
      'x.identity.settings': [{ screen_name: 'authenticated' }],
      'x.identity.profile.initial': [{ errors: [{ message: 'sensitive upstream response body' }] }]
    })
    const result = await invoke(graphqlError, 'readIdentity', { expectedRemoteId: null })
    expect(result).toEqual({ __streamfoldFailure: 'X_IDENTITY_RESPONSE_INVALID' })
    expect(JSON.stringify(result)).not.toContain('sensitive upstream response body')
  })

  it('uses the authenticated current profile as the stable-ID proof without a reverse lookup', async () => {
    const host = hostWith({
      'x.identity.settings': [{ screen_name: 'authenticated' }],
      'x.identity.profile.initial': [profileResponse({
        remoteId: OWNER_ID,
        handle: 'authenticated',
        name: 'Authenticated owner',
        currentShape: true
      })]
    })

    await expect(invoke(host, 'readIdentity', { expectedRemoteId: OWNER_ID })).resolves.toMatchObject({
      remoteId: OWNER_ID,
      remoteName: 'Authenticated owner'
    })
    expect(host.calls.map((call) => call.payload.captureId)).toEqual([
      'x.identity.settings',
      'x.identity.profile.initial'
    ])
  })

  it('does not convert capture host rejections into guest stage envelopes', async () => {
    const hostFailure = new Error('host capture rejection')
    const host = createTestHost({
      hostCall: async () => { throw hostFailure }
    })

    await expect(invoke(host, 'readIdentity', { expectedRemoteId: null })).rejects.toBe(hostFailure)
  })

  it('returns a bounded identity stage envelope through the actual QuickJS sandbox', async () => {
    const output = await executeQuickJsContribution({
      protocolVersion: 1,
      type: 'invoke',
      invocationId: 'xidentity_test_0001',
      pluginId: X_PLUGIN_ID,
      contributionId: X_PLATFORM_CONTRIBUTION_ID,
      entrySource: xEntrySource,
      method: 'readIdentity',
      input: { expectedRemoteId: null },
      context: { pluginId: X_PLUGIN_ID, contributionId: X_PLATFORM_CONTRIBUTION_ID },
      allowedOperations: ['platform.captureJson'],
      limits: { ...DEFAULT_SANDBOX_LIMITS }
    }, async (operation, payload) => {
      expect(operation).toBe('platform.captureJson')
      expect(payload).toEqual({ captureId: 'x.identity.settings', params: {}, limit: 1 })
      return []
    })

    expect(output).toEqual({ __streamfoldFailure: 'X_IDENTITY_SETTINGS_EMPTY' })
  }, 20_000)

  it('maps own original and quote posts while filtering replies, retweets and other authors', async () => {
    const longText = `${'长'.repeat(82)}\nwith   whitespace`
    const original = tweet({
      remoteId: '900719925474099399999999991',
      text: 'legacy fallback text',
      noteText: longText,
      media: 'video'
    })
    const quote = tweet({
      remoteId: '900719925474099399999999992',
      text: 'A quoted post',
      media: 'photo',
      quote: true,
      visibilityWrapper: true
    })
    const response = timelineResponse([
      tweetEntry(original),
      moduleEntry(quote),
      tweetEntry(tweet({ remoteId: '900719925474099399999999993', text: 'reply', reply: true })),
      tweetEntry(tweet({ remoteId: '900719925474099399999999994', text: 'retweet', retweet: true })),
      tweetEntry(tweet({ remoteId: '900719925474099399999999995', text: 'other', authorId: OTHER_ID })),
      tweetEntry({ __typename: 'TweetTombstone' })
    ], {
      variant: 'timeline',
      includeRootRemoteId: false,
      extraInstructions: [{ type: 'TimelineSetNewTweetsPill' }]
    })
    const host = hostWith({ 'x.contents.tweets.bound': [response] })

    const output = asRecord(await invoke(host, 'collect', {
      scope: 'recent_20',
      boundRemoteId: OWNER_ID
    }))
    expect(output.profile).toBeNull()
    expect(output.warnings).toEqual(['已忽略 X 时间线中的非内容指令。'])
    expect(output.contentMetricDefinitions).toEqual([{
      id: 'quotes',
      label: '引用',
      valueKind: 'count',
      unit: 'count',
      group: 'engagement',
      sortOrder: 60,
      measurementKind: 'cumulative',
      standardMetricId: null
    }])
    const contents = output.contents as Array<Record<string, unknown>>
    expect(contents).toHaveLength(2)
    expect(contents[0]).toMatchObject({
      remoteId: '900719925474099399999999991',
      type: 'video',
      title: '长'.repeat(80),
      bodyExcerpt: `${'长'.repeat(82)} with whitespace`,
      url: 'https://x.com/i/web/status/900719925474099399999999991',
      publishedAt: '2018-10-10T20:19:24.000Z'
    })
    expect((contents[0]!.snapshots as unknown[])[0]).toMatchObject({
      views: 1234,
      likes: 12,
      comments: 3,
      shares: 4,
      favorites: 5,
      metrics: { quotes: 6 }
    })
    expect(contents[1]).toMatchObject({
      remoteId: '900719925474099399999999992',
      type: 'image',
      title: 'A quoted post'
    })
    expect(host.calls).toEqual([{
      operation: 'platform.captureJson',
      payload: {
        captureId: 'x.contents.tweets.bound',
        params: { remoteId: OWNER_ID },
        limit: 5
      }
    }])
  })

  it('executes the live timeline shape in the actual QuickJS sandbox', async () => {
    const response = timelineResponse([
      tweetEntry(tweet({ remoteId: '850000000000000000001', text: 'QuickJS post' }))
    ], { variant: 'timeline', includeRootRemoteId: false })
    const output = await executeQuickJsContribution({
      protocolVersion: 1,
      type: 'invoke',
      invocationId: 'xadapter_test_0001',
      pluginId: X_PLUGIN_ID,
      contributionId: X_PLATFORM_CONTRIBUTION_ID,
      entrySource: xEntrySource,
      method: 'collect',
      input: { scope: 'recent_20', boundRemoteId: OWNER_ID },
      context: { pluginId: X_PLUGIN_ID, contributionId: X_PLATFORM_CONTRIBUTION_ID },
      allowedOperations: ['platform.captureJson'],
      limits: { ...DEFAULT_SANDBOX_LIMITS }
    }, async (operation, payload) => {
      expect(operation).toBe('platform.captureJson')
      expect(payload).toEqual({
        captureId: 'x.contents.tweets.bound',
        params: { remoteId: OWNER_ID },
        limit: 5
      })
      return [response]
    })
    expect(asRecord(output).contents).toEqual([
      expect.objectContaining({
        remoteId: '850000000000000000001',
        title: 'QuickJS post',
        publishedAt: '2018-10-10T20:19:24.000Z'
      })
    ])
  }, 20_000)

  it('keeps astral Unicode excerpts within the host UTF-16 limits', async () => {
    const host = hostWith({
      'x.contents.tweets.bound': [timelineResponse([
        tweetEntry(tweet({
          remoteId: '850000000000000000002',
          text: '😀'.repeat(3_000)
        }))
      ])]
    })

    const output = asRecord(await invoke(host, 'collect', {
      scope: 'recent_20',
      boundRemoteId: OWNER_ID
    }))
    const content = (output.contents as Array<Record<string, unknown>>)[0]!
    expect(Array.from(String(content.title))).toHaveLength(80)
    expect(String(content.bodyExcerpt)).toHaveLength(4_000)
    expect(Array.from(String(content.bodyExcerpt))).toHaveLength(2_000)
  })

  it('collects up to 100 unique posts across current and legacy timeline variants', async () => {
    const responses = Array.from({ length: 5 }, (_, page) => timelineResponse(
      Array.from({ length: 20 }, (_, index) => tweetEntry(tweet({
        remoteId: `80000000000000000000${String(page * 20 + index).padStart(3, '0')}`,
        text: `Post ${page * 20 + index}`
      }))),
      {
        variant: page % 2 === 0 ? 'timeline' : 'timeline_v2',
        includeRootRemoteId: page % 2 !== 0,
        cursor: page === 4 ? undefined : `cursor-${page}`
      }
    ))
    const host = hostWith({ 'x.contents.tweets.bound': responses })

    const output = asRecord(await invoke(host, 'collect', {
      scope: 'recent_100',
      boundRemoteId: OWNER_ID
    }))
    expect(output.contents).toHaveLength(100)
    expect((output.contents as Array<Record<string, unknown>>)[99]!.remoteId)
      .toBe('80000000000000000000099')
    expect(host.calls[0]?.payload.limit).toBe(20)
  })

  it('returns verified owner content with a warning when the response limit is exhausted', async () => {
    const responses = Array.from({ length: 5 }, (_, page) => timelineResponse([
      tweetEntry(tweet({
        remoteId: `71000000000000000000${page}`,
        text: `Verified post ${page}`
      }))
    ], { cursor: `cursor-${page}` }))
    const host = hostWith({ 'x.contents.tweets.bound': responses })

    const output = asRecord(await invoke(host, 'collect', {
      scope: 'recent_20',
      boundRemoteId: OWNER_ID
    }))
    expect(output.contents).toHaveLength(5)
    expect(output.warnings).toEqual([
      'X 时间线在完整捕获窗口内读取 5/5 个响应后仍有更多内容；本次已保存 5 条已验证本人内容，少于请求的 20 条。'
    ])
    expect(host.calls[0]?.payload.limit).toBe(5)
  })

  it('returns verified partial data after the full capture window when a next page remains', async () => {
    const incomplete = hostWith({
      'x.contents.tweets.bound': [timelineResponse([
        tweetEntry(tweet({ remoteId: '700000000000000000001', text: 'only one' }))
      ], { cursor: 'more' })]
    })
    const output = asRecord(await invoke(
      incomplete,
      'collect',
      { scope: 'recent_20', boundRemoteId: OWNER_ID }
    ))
    expect(output.contents).toHaveLength(1)
    expect(output.warnings).toEqual([
      'X 时间线在完整捕获窗口内读取 1/5 个响应后仍有更多内容；本次已保存 1 条已验证本人内容，少于请求的 20 条。'
    ])
  })

  it('merges replayed pagination while rejecting conflicting duplicates within one response', async () => {
    const replayedId = '700000000000000000001'
    const replayed = hostWith({
      'x.contents.tweets.bound': [
        timelineResponse([tweetEntry(tweet({ remoteId: replayedId, text: 'replayed post' }))], { cursor: 'same' }),
        timelineResponse([tweetEntry(tweet({
          remoteId: replayedId,
          text: 'replayed post',
          favoriteCount: 13
        }))], { cursor: 'same' })
      ]
    })
    const output = asRecord(await invoke(replayed, 'collect', {
      scope: 'recent_20',
      boundRemoteId: OWNER_ID
    }))
    expect(output.contents).toHaveLength(1)
    expect((((output.contents as JsonValue[])[0] as Record<string, JsonValue>)
      .snapshots as Array<Record<string, JsonValue>>)[0]?.likes).toBe(13)
    expect(output.warnings).toEqual([
      'X 时间线捕获到 1 个重复分页游标；已合并重复响应并继续保存可验证内容。',
      'X 时间线在完整捕获窗口内读取 2/5 个响应后仍有更多内容；本次已保存 1 条已验证本人内容，少于请求的 20 条。'
    ])

    const duplicateId = '700000000000000000002'
    const conflict = hostWith({
      'x.contents.tweets.bound': [timelineResponse([
        tweetEntry(tweet({ remoteId: duplicateId, text: 'first value' })),
        tweetEntry(tweet({ remoteId: duplicateId, text: 'changed value' }))
      ])]
    })
    await expect(invoke(conflict, 'collect', { scope: 'recent_20', boundRemoteId: OWNER_ID }))
      .rejects.toThrow('重复 tweet 数据冲突')
  })

  it('rejects malformed query results and does no capture for profile-only sync', async () => {
    const wrongOwner = hostWith({
      'x.contents.tweets.bound': [timelineResponse([
        tweetEntry(tweet({ remoteId: '600000000000000000001', text: 'post' }))
      ], { includeRootRemoteId: true, rootRemoteId: OTHER_ID })]
    })
    await expect(invoke(wrongOwner, 'collect', { scope: 'recent_20', boundRemoteId: OWNER_ID }))
      .rejects.toThrow('UserTweets 用户与已绑定账号不一致')

    const graphqlError = hostWith({
      'x.contents.tweets.bound': [{ errors: [{ message: 'do not expose me' }] }]
    })
    await expect(invoke(graphqlError, 'collect', { scope: 'recent_20', boundRemoteId: OWNER_ID }))
      .rejects.toThrow('UserTweets返回错误')

    const profileOnly = hostWith({})
    const output = asRecord(await invoke(profileOnly, 'collect', {
      scope: 'profile_only',
      boundRemoteId: OWNER_ID
    }))
    expect(output.contents).toEqual([])
    expect(profileOnly.calls).toEqual([])
  })
})

function hostWith(captures: Record<string, JsonValue>): PluginTestHost {
  return createTestHost({
    hostCall: async (operation, payload) => {
      if (operation !== 'platform.captureJson') throw new Error(`Unexpected operation: ${operation}`)
      const captureId = String(payload.captureId)
      if (!(captureId in captures)) throw new Error(`Missing fixture for ${captureId}`)
      return captures[captureId]!
    }
  })
}

function invoke(host: PluginTestHost, method: 'readIdentity' | 'collect', input: JsonValue): Promise<JsonValue> {
  return host.invoke({
    entrySource: xEntrySource,
    method,
    context: { pluginId: X_PLUGIN_ID, contributionId: X_PLATFORM_CONTRIBUTION_ID },
    input
  })
}

function asRecord(value: JsonValue): Record<string, JsonValue> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected object')
  return value
}

interface ProfileFixtureOptions {
  remoteId: string
  handle: string
  name: string
  currentShape: boolean
  root?: 'user' | 'screen-name' | 'rest-id'
}

function profileResponse(options: ProfileFixtureOptions): JsonValue {
  const legacy: Record<string, JsonValue> = {
    followers_count: 123,
    friends_count: 45,
    statuses_count: 678
  }
  const result: Record<string, JsonValue> = {
    __typename: 'User',
    rest_id: options.remoteId,
    legacy
  }
  if (options.currentShape) {
    result.core = { screen_name: options.handle, name: options.name }
    result.avatar = { image_url: 'https://pbs.twimg.com/profile_images/current.jpg' }
    result.profile_bio = { description: 'Current\nprofile   bio' }
  } else {
    legacy.screen_name = options.handle
    legacy.name = options.name
    legacy.profile_image_url_https = 'https://pbs.twimg.com/profile_images/legacy.jpg'
    legacy.description = 'Legacy profile bio'
  }
  const user = { result: { result } }
  if (options.root === 'screen-name') return { data: { user_result_by_screen_name: user } }
  if (options.root === 'rest-id') return { data: { user_result_by_rest_id: user } }
  return { data: { user } }
}

interface TweetOptions {
  remoteId: string
  text: string
  noteText?: string
  authorId?: string
  media?: 'video' | 'photo'
  reply?: boolean
  retweet?: boolean
  quote?: boolean
  visibilityWrapper?: boolean
  favoriteCount?: number
}

function tweet(options: TweetOptions): Record<string, JsonValue> {
  const legacy: Record<string, JsonValue> = {
    full_text: options.text,
    created_at: 'Wed Oct 10 20:19:24 +0000 2018',
    favorite_count: options.favoriteCount ?? 12,
    reply_count: 3,
    retweet_count: 4,
    bookmark_count: 5,
    quote_count: 6
  }
  if (options.media) legacy.extended_entities = { media: [{ type: options.media }] }
  if (options.reply) legacy.in_reply_to_status_id_str = '500000000000000000001'
  if (options.retweet) legacy.retweeted_status_result = { result: { rest_id: '500000000000000000002' } }
  if (options.quote) legacy.quoted_status_id_str = '500000000000000000003'
  const value: Record<string, JsonValue> = {
    __typename: 'Tweet',
    rest_id: options.remoteId,
    core: {
      user_results: {
        result: { __typename: 'User', rest_id: options.authorId ?? OWNER_ID }
      }
    },
    legacy,
    views: { count: '1234' }
  }
  if (options.noteText) value.note_tweet = { note_tweet_results: { result: { text: options.noteText } } }
  if (options.quote) value.quoted_status_result = { result: { __typename: 'Tweet', rest_id: '500000000000000000003' } }
  return options.visibilityWrapper
    ? { __typename: 'TweetWithVisibilityResults', tweet: value }
    : value
}

function tweetEntry(result: JsonValue): Record<string, JsonValue> {
  return {
    entryId: 'tweet-entry',
    content: {
      __typename: 'TimelineTimelineItem',
      itemContent: { __typename: 'TimelineTweet', tweet_results: { result } }
    }
  }
}

function moduleEntry(result: JsonValue): Record<string, JsonValue> {
  return {
    entryId: 'module-entry',
    content: {
      __typename: 'TimelineTimelineModule',
      items: [{
        item: {
          itemContent: { __typename: 'TimelineTweet', tweet_results: { result } }
        }
      }]
    }
  }
}

interface TimelineOptions {
  variant?: 'timeline' | 'timeline_v2'
  includeRootRemoteId?: boolean
  rootRemoteId?: string
  cursor?: string
  terminate?: boolean
  extraInstructions?: JsonValue[]
}

function timelineResponse(entries: JsonValue[], options: TimelineOptions = {}): JsonValue {
  const timelineEntries = [...entries]
  if (options.cursor) {
    timelineEntries.push({
      entryId: 'cursor-bottom',
      content: {
        __typename: 'TimelineTimelineCursor',
        cursorType: 'Bottom',
        value: options.cursor
      }
    })
  }
  const instructions: JsonValue[] = [
    { type: 'TimelineAddEntries', entries: timelineEntries },
    ...(options.extraInstructions ?? [])
  ]
  if (options.terminate) instructions.push({ type: 'TimelineTerminateTimeline', direction: 'Bottom' })
  const result: Record<string, JsonValue> = { __typename: 'User' }
  if (options.includeRootRemoteId) result.rest_id = options.rootRemoteId ?? OWNER_ID
  const timeline = { timeline: { instructions } }
  result[options.variant === 'timeline_v2' ? 'timeline_v2' : 'timeline'] = timeline
  return { data: { user: { result } } }
}
