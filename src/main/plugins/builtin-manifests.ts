import type { PlatformAdapterContribution, PluginManifestV2 } from '../../shared/plugin-host-contracts'

export const XIAOHONGSHU_PLATFORM_CONTRIBUTION_ID = 'xiaohongshu-session-api.platform'
export const ZHIHU_PLATFORM_CONTRIBUTION_ID = 'zhihu-session-api.platform'

export const xiaohongshuPluginManifestV2: PluginManifestV2 = Object.freeze({
  schemaVersion: 2,
  id: 'xiaohongshu-session-api',
  name: '小红书数据同步',
  version: '0.4.0',
  description: '使用当前账号的登录会话，同步本人资料、作品摘要和统计指标。',
  license: 'builtin',
  publisher: { id: 'streamfold', name: '归页', keyId: 'streamfold-builtin' },
  minimumAppVersion: '0.5.0',
  sdkVersion: '1.0.0',
  contributions: [Object.freeze({
    id: XIAOHONGSHU_PLATFORM_CONTRIBUTION_ID,
    kind: 'platform.adapter',
    name: '小红书账号适配器',
    description: '小红书创作服务平台本人账号只读同步。',
    entry: 'entries/xiaohongshu.js',
    runtime: 'builtin',
    permissions: ['platform.session-json', 'scheduler.run'],
    platform: {
      id: 'xiaohongshu',
      name: '小红书',
      shortName: '红',
      loginUrl: 'https://creator.xiaohongshu.com/',
      homeUrl: 'https://creator.xiaohongshu.com/',
      navigationHosts: ['creator.xiaohongshu.com', 'www.xiaohongshu.com'],
      imageHosts: ['ci.xiaohongshu.com', 'sns-avatar-qc.xhscdn.com', 'sns-avatar-hw.xhscdn.com'],
      contentUrls: [{
        remoteIdTemplate: '{remoteId}',
        origin: 'https://www.xiaohongshu.com',
        pathTemplate: '/explore/{remoteId}',
        queryParameters: ['xsec_token', 'xsec_source']
      }],
      riskNote: '仅打开小红书官方创作服务平台；出现验证时由用户手动完成。'
    },
    endpoints: [
      endpoint('personal-info', 'https://creator.xiaohongshu.com', '/api/galaxy/creator/home/personal_info', 256 * 1024),
      endpoint('user-info', 'https://creator.xiaohongshu.com', '/api/galaxy/user/info', 256 * 1024),
      endpoint('account-stats', 'https://creator.xiaohongshu.com', '/api/galaxy/creator/data/note_detail_new', 256 * 1024)
    ],
    captures: [
      capture('posted-notes', 'https://creator.xiaohongshu.com/new/note-manager', 'https://creator.xiaohongshu.com', '/api/galaxy/v2/creator/note/user/posted', 'page-down'),
      capture('note-analysis', 'https://creator.xiaohongshu.com/statistics/data-analysis?source=official', 'https://creator.xiaohongshu.com', '/api/galaxy/creator/datacenter/note/analyze/list', 'none'),
      capture('note-detail', 'https://creator.xiaohongshu.com/new/note-manager', 'https://edith.xiaohongshu.com', '/web_api/sns/capa/postgw/note/detail', 'none')
    ],
    minimumIntervalSeconds: 60,
    recommendedSyncIntervalHours: 24
  } satisfies PlatformAdapterContribution)]
})

export const zhihuPluginManifestV2: PluginManifestV2 = Object.freeze({
  schemaVersion: 2,
  id: 'zhihu-session-api',
  name: '知乎数据同步',
  version: '0.5.0',
  description: '使用当前账号的登录会话，同步本人资料及创作中心中的回答、文章和统计指标。',
  license: 'builtin',
  publisher: { id: 'streamfold', name: '归页', keyId: 'streamfold-builtin' },
  minimumAppVersion: '0.5.0',
  sdkVersion: '1.0.0',
  contributions: [Object.freeze({
    id: ZHIHU_PLATFORM_CONTRIBUTION_ID,
    kind: 'platform.adapter',
    name: '知乎账号适配器',
    description: '知乎本人账号及创作中心内容只读同步。',
    entry: 'entries/zhihu.js',
    runtime: 'builtin',
    permissions: ['platform.session-json', 'scheduler.run'],
    platform: {
      id: 'zhihu',
      name: '知乎',
      shortName: '知',
      loginUrl: 'https://www.zhihu.com/signin?next=%2Fcreator',
      homeUrl: 'https://www.zhihu.com/creator',
      navigationHosts: ['www.zhihu.com', 'zhuanlan.zhihu.com'],
      imageHosts: ['picx.zhimg.com', 'pic1.zhimg.com', 'pic2.zhimg.com', 'pic3.zhimg.com', 'pic4.zhimg.com'],
      contentUrls: [
        { remoteIdTemplate: 'answer:{questionId}:{answerId}', origin: 'https://www.zhihu.com', pathTemplate: '/question/{questionId}/answer/{answerId}' },
        { remoteIdTemplate: 'article:{articleId}', origin: 'https://zhuanlan.zhihu.com', pathTemplate: '/p/{articleId}' },
        { remoteIdTemplate: 'pin:{pinId}', origin: 'https://www.zhihu.com', pathTemplate: '/pin/{pinId}' },
        { remoteIdTemplate: 'zvideo:{videoId}', origin: 'https://www.zhihu.com', pathTemplate: '/zvideo/{videoId}' }
      ],
      riskNote: '仅打开知乎官方登录与创作页面；不自动填写登录信息。'
    },
    endpoints: [
      endpoint('identity', 'https://www.zhihu.com', '/api/v4/me', 512 * 1024),
      endpoint('profile', 'https://www.zhihu.com', '/api/v4/members/{handle}', 512 * 1024),
      endpoint('creations', 'https://www.zhihu.com', '/api/v4/creators/creations/v2/all', 512 * 1024),
      endpoint('member-aggr', 'https://www.zhihu.com', '/api/v4/creators/analysis/realtime/member/aggr', 512 * 1024),
      endpoint('member-daily', 'https://www.zhihu.com', '/api/v4/creators/analysis/realtime/member/daily', 512 * 1024),
      endpoint('content-list', 'https://www.zhihu.com', '/api/v4/creators/analysis/realtime/content/list', 512 * 1024),
      endpoint('content-aggr', 'https://www.zhihu.com', '/api/v4/creators/analysis/realtime/content/aggr', 512 * 1024),
      endpoint('content-daily', 'https://www.zhihu.com', '/api/v4/creators/analysis/realtime/content/daily', 512 * 1024)
    ],
    captures: [],
    minimumIntervalSeconds: 300,
    recommendedSyncIntervalHours: 24
  } satisfies PlatformAdapterContribution)]
})

export const builtinPluginManifestsV2 = Object.freeze([
  xiaohongshuPluginManifestV2,
  zhihuPluginManifestV2
])

function endpoint(
  id: string,
  origin: string,
  pathTemplate: string,
  maximumResponseBytes: number
) {
  return { id, origin, pathTemplate, maximumResponseBytes }
}

function capture(
  id: string,
  route: string,
  responseOrigin: string,
  responsePath: string,
  pagination: 'none' | 'page-down'
) {
  return {
    id,
    route,
    responseOrigin,
    responsePath,
    resourceTypes: ['Fetch', 'XHR'] as Array<'Fetch' | 'XHR'>,
    method: 'GET' as const,
    pagination,
    maximumResponses: 100,
    maximumResponseBytes: 512 * 1024,
    maximumTotalBytes: 2 * 1024 * 1024
  }
}
