import type { PlatformDefinition, PlatformId } from '../shared/contracts'

const definitions: Record<PlatformId, PlatformDefinition> = {
  xiaohongshu: {
    id: 'xiaohongshu',
    name: '小红书',
    shortName: '红',
    loginUrl: 'https://creator.xiaohongshu.com/',
    homeUrl: 'https://creator.xiaohongshu.com/',
    officialHosts: ['creator.xiaohongshu.com', 'www.xiaohongshu.com'],
    riskNote: '仅打开小红书官方创作服务平台；出现验证时由用户手动完成。'
  },
  weibo: {
    id: 'weibo',
    name: '微博',
    shortName: '微',
    loginUrl: 'https://weibo.com/',
    homeUrl: 'https://weibo.com/',
    officialHosts: ['weibo.com', 'www.weibo.com', 'passport.weibo.com', 'login.sina.com.cn'],
    riskNote: '仅打开微博及新浪官方认证域名；当前版本不执行自动采集。'
  },
  douyin: {
    id: 'douyin',
    name: '抖音',
    shortName: '抖',
    loginUrl: 'https://creator.douyin.com/',
    homeUrl: 'https://creator.douyin.com/',
    officialHosts: ['creator.douyin.com', 'www.douyin.com'],
    riskNote: '仅打开抖音官方创作者中心；不修改浏览器指纹或 User-Agent。'
  },
  zhihu: {
    id: 'zhihu',
    name: '知乎',
    shortName: '知',
    loginUrl: 'https://www.zhihu.com/signin',
    homeUrl: 'https://www.zhihu.com/creator',
    officialHosts: ['www.zhihu.com'],
    riskNote: '仅打开知乎官方登录与创作页面；不自动填写登录信息。'
  }
}

export function listPlatforms(): PlatformDefinition[] {
  return Object.values(definitions).map((platform) => ({
    ...platform,
    officialHosts: [...platform.officialHosts]
  }))
}

export function getPlatform(id: PlatformId): PlatformDefinition {
  const platform = definitions[id]
  if (!platform) throw new Error('不支持的平台')
  return platform
}

export function isOfficialUrl(platformId: PlatformId, value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }

  if (url.protocol !== 'https:') return false
  if (url.username || url.password) return false
  if (url.port && url.port !== '443') return false

  const hostname = url.hostname.toLowerCase().replace(/\.$/, '')
  if (!hostname || hostname === 'localhost' || isIpAddress(hostname)) return false

  return definitions[platformId].officialHosts.includes(hostname)
}

function isIpAddress(hostname: string): boolean {
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) return true
  return hostname.includes(':')
}
