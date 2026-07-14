import type { PlatformDefinition, PlatformId } from '../shared/contracts'

const definitions: Record<string, PlatformDefinition> = {}

export function listPlatforms(): PlatformDefinition[] {
  return Object.values(definitions).map((platform) => ({
    ...platform,
    officialHosts: [...platform.officialHosts],
    ...(platform.contentUrls ? { contentUrls: structuredClone(platform.contentUrls) } : {})
  }))
}

export function registerPlatformDefinition(platform: PlatformDefinition): void {
  if (!/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/.test(platform.id)) throw new Error('平台 ID 非法')
  if (platform.officialHosts.length === 0) throw new Error('平台必须声明官方域名')
  const normalized: PlatformDefinition = {
    ...platform,
    officialHosts: [...new Set(platform.officialHosts.map((host) => host.toLowerCase()))],
    ...(platform.contentUrls ? { contentUrls: structuredClone(platform.contentUrls) } : {})
  }
  if (!normalized.officialHosts.every(isValidHost)) throw new Error('平台官方域名非法')
  definitions[platform.id] = normalized
}

export function registerManifestPlatforms(platforms: readonly PlatformDefinition[]): void {
  for (const id of Object.keys(definitions)) delete definitions[id]
  for (const platform of platforms) registerPlatformDefinition(platform)
}

export function getPlatform(id: PlatformId): PlatformDefinition {
  const platform = definitions[id]
  if (!platform) throw new Error('不支持的平台')
  return {
    ...platform,
    officialHosts: [...platform.officialHosts],
    ...(platform.contentUrls ? { contentUrls: structuredClone(platform.contentUrls) } : {})
  }
}

export function isOfficialUrl(platformId: PlatformId, value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }

  if (url.protocol !== 'https:' || hasExplicitPort(value)) return false
  if (url.username || url.password) return false
  if (url.port && url.port !== '443') return false

  const hostname = url.hostname.toLowerCase().replace(/\.$/, '')
  if (!hostname || hostname === 'localhost' || isIpAddress(hostname)) return false

  return definitions[platformId]?.officialHosts.includes(hostname) ?? false
}

export function shouldBlockRemoteNavigation(
  platformId: PlatformId,
  value: string,
  isMainFrame: boolean
): boolean {
  if (isMainFrame) return !isOfficialUrl(platformId, value)

  try {
    const url = new URL(value)
    if (url.protocol === 'https:') return false
    if (url.protocol === 'about:') return url.pathname !== 'blank' && url.pathname !== 'srcdoc'
    if (url.protocol === 'blob:' && url.origin !== 'null') {
      return new URL(url.origin).protocol !== 'https:'
    }
    return true
  } catch {
    return true
  }
}

export function isOfficialContentUrl(
  platformId: PlatformId,
  value: string,
  remoteId: string
): boolean {
  if (!isOfficialUrl(platformId, value)) return false
  return definitions[platformId]?.contentUrls?.some((template) => matchesContentTemplate(template, value, remoteId)) ?? false
}

function matchesContentTemplate(
  template: NonNullable<PlatformDefinition['contentUrls']>[number],
  value: string,
  remoteId: string
): boolean {
  const names: string[] = []
  const pattern = template.remoteIdTemplate.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
    names.push(name)
    return '([A-Za-z0-9._~-]+)'
  })
  const match = new RegExp(`^${escapeTemplateLiterals(pattern)}$`).exec(remoteId)
  if (!match) return false
  let path = template.pathTemplate
  names.forEach((name, index) => {
    path = path.split(`{${name}}`).join(encodeURIComponent(match[index + 1]!))
  })
  try {
    const actual = new URL(value)
    const expected = new URL(path, template.origin)
    if (actual.origin !== expected.origin || actual.pathname !== expected.pathname || actual.hash) return false
    const keys = [...actual.searchParams.keys()]
    const allowed = template.queryParameters ?? []
    return keys.every((key) => allowed.includes(key)) && new Set(keys).size === keys.length &&
      [...actual.searchParams.values()].every((item) => (
        item.length > 0 && item.length <= 1_024 && /^[A-Za-z0-9._~+/_=-]+$/.test(item)
      ))
  } catch {
    return false
  }
}

function escapeTemplateLiterals(value: string): string {
  // Preserve the capture groups inserted above while escaping manifest literals.
  return value.split('([A-Za-z0-9._~-]+)').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('([A-Za-z0-9._~-]+)')
}

function hasExplicitPort(value: string): boolean {
  const authority = /^https:\/\/([^/?#]+)/i.exec(value)?.[1] ?? ''
  return /:\d+$/.test(authority)
}

function isIpAddress(hostname: string): boolean {
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) return true
  return hostname.includes(':')
}

function isValidHost(hostname: string): boolean {
  return hostname.length <= 253 && /^[a-z0-9.-]+$/.test(hostname) &&
    !hostname.startsWith('.') && !hostname.endsWith('.') && !hostname.includes('..') &&
    hostname !== 'localhost' && !isIpAddress(hostname)
}
