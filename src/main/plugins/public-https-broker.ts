import { promises as dns } from 'node:dns'
import { request } from 'node:https'
import { BlockList, isIP } from 'node:net'

export interface PublicHttpsResponse {
  status: number
  contentType: string
  body: string
  retryAfter: string | null
}

export interface PublicHttpsBinaryResponse {
  status: number
  contentType: string
  body: Buffer
}

export interface PublicHttpsRequest {
  url: string
  method: 'GET' | 'POST'
  headers?: Record<string, string>
  jsonBody?: unknown
  timeoutMs?: number
  maximumResponseBytes?: number
}

const blocked = new BlockList()
for (const [network, prefix, type] of [
  ['0.0.0.0', 8, 'ipv4'], ['10.0.0.0', 8, 'ipv4'], ['100.64.0.0', 10, 'ipv4'],
  ['127.0.0.0', 8, 'ipv4'], ['169.254.0.0', 16, 'ipv4'], ['172.16.0.0', 12, 'ipv4'],
  ['192.0.0.0', 24, 'ipv4'], ['192.0.2.0', 24, 'ipv4'], ['192.168.0.0', 16, 'ipv4'],
  ['198.18.0.0', 15, 'ipv4'], ['198.51.100.0', 24, 'ipv4'], ['203.0.113.0', 24, 'ipv4'],
  ['224.0.0.0', 4, 'ipv4'], ['240.0.0.0', 4, 'ipv4'],
  ['::', 128, 'ipv6'], ['::1', 128, 'ipv6'], ['fc00::', 7, 'ipv6'], ['fe80::', 10, 'ipv6'],
  ['ff00::', 8, 'ipv6'], ['2001:db8::', 32, 'ipv6']
] as const) blocked.addSubnet(network, prefix, type)

export class PublicHttpsBroker {
  async request(input: PublicHttpsRequest): Promise<PublicHttpsResponse> {
    const target = normalizeTarget(input.url)
    const addresses = await resolvePublicAddresses(target.hostname)
    const body = input.jsonBody === undefined ? null : Buffer.from(JSON.stringify(input.jsonBody), 'utf8')
    if (body && body.byteLength > 1024 * 1024) throw new Error('插件 HTTPS 请求正文超过 1 MiB')
    const timeoutMs = clamp(input.timeoutMs ?? 15_000, 1_000, 30_000)
    const maximumResponseBytes = clamp(input.maximumResponseBytes ?? 64 * 1024, 1, 512 * 1024)
    try {
      return await new Promise<PublicHttpsResponse>((resolve, reject) => {
        let addressIndex = 0
        const req = request(target, {
          method: input.method,
          headers: normalizeHeaders(input.headers, body),
          timeout: timeoutMs,
          lookup: (_hostname, options, callback) => {
            const address = addresses[addressIndex++ % addresses.length]!
            const family = typeof options === 'object' && options.family
            if (family === 4 || family === 6) {
              const matching = addresses.find((item) => item.family === family)
              if (!matching) {
                callback(new Error('目标域名没有允许的地址'), '', family)
                return
              }
              callback(null, matching.address, matching.family)
              return
            }
            callback(null, address.address, address.family)
          }
        }, (response) => {
          const chunks: Buffer[] = []
          let total = 0
          response.on('data', (chunk: Buffer | string) => {
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
            total += bytes.byteLength
            if (total > maximumResponseBytes) {
              response.destroy(new Error('插件 HTTPS 响应超过允许上限'))
              return
            }
            chunks.push(bytes)
          })
          response.on('end', () => resolve({
            status: response.statusCode ?? 0,
            contentType: String(response.headers['content-type'] ?? ''),
            body: Buffer.concat(chunks).toString('utf8'),
            retryAfter: typeof response.headers['retry-after'] === 'string' ? response.headers['retry-after'] : null
          }))
          response.on('error', reject)
        })
        req.on('timeout', () => req.destroy(new Error('插件 HTTPS 请求超时')))
        req.on('error', reject)
        if (body) req.write(body)
        req.end()
      })
    } finally {
      body?.fill(0)
    }
  }

  /** Used by the signed catalog installer, never exposed to plugin RPC. */
  async download(url: string, maximumResponseBytes = 10 * 1024 * 1024): Promise<PublicHttpsBinaryResponse> {
    const target = normalizeTarget(url)
    const addresses = await resolvePublicAddresses(target.hostname)
    const limit = clamp(maximumResponseBytes, 1, 10 * 1024 * 1024)
    return await new Promise<PublicHttpsBinaryResponse>((resolve, reject) => {
      let addressIndex = 0
      const req = request(target, {
        method: 'GET',
        headers: { Accept: 'application/octet-stream, application/json', 'User-Agent': 'Streamfold-Plugin-Catalog/1' },
        timeout: 30_000,
        lookup: (_hostname, options, callback) => {
          const family = typeof options === 'object' && options.family
          const address = family === 4 || family === 6
            ? addresses.find((item) => item.family === family)
            : addresses[addressIndex++ % addresses.length]
          if (!address) return callback(new Error('目标域名没有允许的地址'), '', typeof family === 'number' ? family : undefined)
          callback(null, address.address, address.family)
        }
      }, (response) => {
        const chunks: Buffer[] = []
        let total = 0
        response.on('data', (chunk: Buffer | string) => {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          total += bytes.byteLength
          if (total > limit) return response.destroy(new Error('下载内容超过允许上限'))
          chunks.push(bytes)
        })
        response.on('end', () => resolve({
          status: response.statusCode ?? 0,
          contentType: String(response.headers['content-type'] ?? ''),
          body: Buffer.concat(chunks, total)
        }))
        response.on('error', reject)
      })
      req.on('timeout', () => req.destroy(new Error('下载请求超时')))
      req.on('error', reject)
      req.end()
    })
  }
}

function normalizeTarget(value: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('插件 HTTPS 地址无效')
  }
  if (url.protocol !== 'https:' || url.username || url.password || !url.hostname || url.hash) {
    throw new Error('插件网络只允许公网 HTTPS')
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '')
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || isIP(hostname)) {
    throw new Error('插件网络拒绝本机、局域网和 IP 地址目标')
  }
  url.hostname = hostname
  return url
}

async function resolvePublicAddresses(hostname: string): Promise<Array<{ address: string; family: 4 | 6 }>> {
  let addresses: Array<{ address: string; family: number }>
  try {
    addresses = await dns.lookup(hostname, { all: true, verbatim: true })
  } catch {
    throw new Error('插件 HTTPS 目标域名无法解析')
  }
  if (addresses.length === 0 || addresses.length > 16) throw new Error('插件 HTTPS 目标域名解析结果异常')
  const normalized = addresses.map((item) => ({
    address: item.address,
    family: item.family as 4 | 6
  }))
  if (normalized.some((item) => (
    (item.family !== 4 && item.family !== 6) || blocked.check(item.address, `ipv${item.family}` as 'ipv4' | 'ipv6')
  ))) throw new Error('插件网络拒绝本机、局域网或保留地址')
  return normalized
}

function normalizeHeaders(input: Record<string, string> | undefined, body: Buffer | null): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent': 'Streamfold-Plugin-Host/1'
  }
  for (const [name, value] of Object.entries(input ?? {})) {
    const normalized = name.toLowerCase()
    if (!/^[a-z0-9-]{1,64}$/.test(normalized) || [
      'host', 'connection', 'content-length', 'cookie', 'set-cookie', 'proxy-authorization',
      'transfer-encoding', 'upgrade'
    ].includes(normalized)) throw new Error('插件 HTTPS 请求头不受支持')
    if (typeof value !== 'string' || value.length > 4_096 || /[\r\n\u0000]/.test(value)) {
      throw new Error('插件 HTTPS 请求头无效')
    }
    headers[name] = value
  }
  if (body) {
    headers['Content-Type'] = 'application/json; charset=utf-8'
    headers['Content-Length'] = String(body.byteLength)
  }
  return headers
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum
  return Math.max(minimum, Math.min(maximum, Math.trunc(value)))
}
