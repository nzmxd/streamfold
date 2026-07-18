import { describe, expect, it } from 'vitest'
import { formatSandboxDiagnostic, sanitizeSandboxDiagnostic } from './sandbox-diagnostics'

describe('sandbox diagnostics', () => {
  it('keeps plugin locations, response structure, aggregate errors and causes while removing credentials', () => {
    const ordinaryLongValue = 'r'.repeat(96)
    const cause = Object.assign(new Error('远端请求失败'), {
      statusCode: 503,
      response: {
        url: 'https://api.example.test/items?page=2&mode=full&auth_token=query-secret#section=timeline&cursor=public',
        headers: { cookie: 'private-cookie', 'content-type': 'application/json' },
        body: {
          reason: 'service unavailable',
          cursor: ordinaryLongValue,
          token: 'body-secret'
        }
      }
    })
    const error = Object.assign(
      new AggregateError([
        new Error('解析响应失败'),
        Object.assign(new Error('第二个响应失败'), { status: 422 })
      ], '插件执行失败', { cause }),
      { code: 'PLUGIN_SANDBOX_FAILED', status: 502, clientSecret: 'client-secret' }
    )
    const diagnostic = formatSandboxDiagnostic(error) ?? ''

    expect(diagnostic).toContain('PLUGIN_SANDBOX_FAILED')
    expect(diagnostic).toContain('statusCode')
    expect(diagnostic).toContain('503')
    expect(diagnostic).toContain('service unavailable')
    expect(diagnostic).toContain(ordinaryLongValue)
    expect(diagnostic).toContain('聚合错误 1')
    expect(diagnostic).toContain('解析响应失败')
    expect(diagnostic).toContain('聚合错误 2')
    expect(diagnostic).toContain('422')
    expect(diagnostic).toContain('原因')
    expect(diagnostic).toContain('page=2')
    expect(diagnostic).toContain('mode=full')
    expect(diagnostic).toContain('section=timeline')
    expect(diagnostic).toContain('cursor=public')
    expect(diagnostic).toContain('auth_token=[REDACTED]')
    for (const secret of ['query-secret', 'private-cookie', 'body-secret', 'client-secret']) {
      expect(diagnostic).not.toContain(secret)
    }
  })

  it('keeps reproducible plugin code locations and non-sensitive response fields', () => {
    const cause = new Error([
      'X 数据无效：UserTweets.data.user.result.timeline 缺失',
      'at parseTimelineResponse (streamfold:streamfold.x/streamfold.x.platform.js:314:9)',
      '{"screen_name":"owner","auth_token":"private-token","status":502,"body":"bad shape"}',
      'https://x.com/i/api/graphql/query/UserTweets?variables=public-shape&auth_token=private#panel=timeline'
    ].join('\n'))
    const error = new Error('插件执行失败', { cause })
    const diagnostic = formatSandboxDiagnostic(error) ?? ''

    expect(diagnostic).toContain('UserTweets.data.user.result.timeline 缺失')
    expect(diagnostic).toContain('streamfold.x.platform.js:314:9')
    expect(diagnostic).toContain('screen_name')
    expect(diagnostic).toContain('status')
    expect(diagnostic).toContain('502')
    expect(diagnostic).toContain('bad shape')
    expect(diagnostic).toContain('variables=public-shape')
    expect(diagnostic).toContain('panel=timeline')
    expect(diagnostic).toContain('auth_token=[REDACTED]')
    expect(diagnostic).not.toContain('private-token')
    expect(diagnostic).not.toContain('auth_token=private')
  })

  it('redacts escaped, encoded and unterminated short credentials without erasing ordinary values', () => {
    const ordinaryLongValue = 'z'.repeat(128)
    const diagnostic = sanitizeSandboxDiagnostic([
      `status=200 content_count=18 response=${ordinaryLongValue}`,
      'body={\\"token\\":\\"ESCAPED_TOKEN\\",\\"reason\\":\\"bad shape\\"}',
      'nested={\\"\\\\u0074oken\\":\\"DOUBLE_ESCAPED_TOKEN\\"}',
      'unfinished={\\"auth_token\\":\\"UNTERMINATED_ESCAPED_TOKEN',
      'token%3DURL_ENCODED_TOKEN',
      'page%3D2%26mode%3Dfull',
      '{"clientSecret":"UNTERMINATED_CLIENT_SECRET',
      "{'cookieJar':'UNTERMINATED_COOKIE_JAR",
      'Authorization: Bearer SHORT_BEARER',
      'ct0=SHORT_CT0',
      'hmacSecret=SHORT_HMAC',
      'https://api.example.test/items?page=2&password=QUERY_PASSWORD&mode=full' +
        '#section=timeline&access_token=FRAGMENT_TOKEN&cursor=public'
    ].join('\n'))

    expect(diagnostic).toContain('status=200 content_count=18')
    expect(diagnostic).toContain(ordinaryLongValue)
    expect(diagnostic).toContain('bad shape')
    expect(diagnostic).toContain('page%3D2%26mode%3Dfull')
    expect(diagnostic).toContain('page=2')
    expect(diagnostic).toContain('mode=full')
    expect(diagnostic).toContain('section=timeline')
    expect(diagnostic).toContain('cursor=public')
    for (const secret of [
      'ESCAPED_TOKEN', 'DOUBLE_ESCAPED_TOKEN', 'UNTERMINATED_ESCAPED_TOKEN',
      'URL_ENCODED_TOKEN', 'UNTERMINATED_CLIENT_SECRET',
      'UNTERMINATED_COOKIE_JAR', 'SHORT_BEARER', 'SHORT_CT0', 'SHORT_HMAC',
      'QUERY_PASSWORD', 'FRAGMENT_TOKEN'
    ]) expect(diagnostic).not.toContain(secret)
  })

  it('redacts common platform session keys in objects and URLs', () => {
    const diagnostic = formatSandboxDiagnostic(Object.assign(new Error('platform response failed'), {
      response: {
        status: 502,
        body: {
          ct0: 'X_CT0_SECRET',
          twid: 'X_TWID_SECRET',
          z_c0: 'ZHIHU_ZC0_SECRET',
          d_c0: 'ZHIHU_DC0_SECRET',
          q_c1: 'ZHIHU_QC1_SECRET',
          a1: 'XHS_A1_SECRET',
          web_session: 'XHS_SESSION_SECRET',
          webid: 'XHS_WEBID_SECRET'
        },
        url: 'https://api.example.test/items?page=2&ct0=URL_CT0_SECRET&web_session=URL_SESSION_SECRET'
      }
    })) ?? ''

    expect(diagnostic).toContain('status')
    expect(diagnostic).toContain('502')
    expect(diagnostic).toContain('page=2')
    for (const secret of [
      'X_CT0_SECRET', 'X_TWID_SECRET', 'ZHIHU_ZC0_SECRET', 'ZHIHU_DC0_SECRET',
      'ZHIHU_QC1_SECRET', 'XHS_A1_SECRET', 'XHS_SESSION_SECRET', 'XHS_WEBID_SECRET',
      'URL_CT0_SECRET', 'URL_SESSION_SECRET'
    ]) expect(diagnostic).not.toContain(secret)
  })

  it('redacts prefixed, quoted and multi-part credential assignments', () => {
    const diagnostic = sanitizeSandboxDiagnostic([
      'x_access_key=ACCESS PART TWO',
      "client_session_key='SESSION PART TWO' reason=upstream",
      'oauth_signature=OAUTH,SECOND',
      'guest_id_ads -> GUEST VALUE',
      'laravel_session=LARAVEL COOKIE',
      'PHPSESSID=PHP COOKIE',
      '__Secure-3PSIDTS=GOOGLE_COOKIE',
      'request_signature="UNTERMINATED SIGNATURE'
    ].join('\n'))

    for (const secret of [
      'ACCESS PART TWO', 'SESSION PART TWO', 'OAUTH,SECOND', 'GUEST VALUE',
      'LARAVEL COOKIE', 'PHP COOKIE', 'GOOGLE_COOKIE', 'UNTERMINATED SIGNATURE'
    ]) expect(diagnostic).not.toContain(secret)
  })

  it('bounds hostile, circular and deeply nested diagnostic properties', () => {
    const hostile = new Proxy({}, {
      getOwnPropertyDescriptor: () => { throw new Error('descriptor trap') },
      getPrototypeOf: () => { throw new Error('prototype trap') },
      ownKeys: () => { throw new Error('keys trap') }
    })
    expect(() => formatSandboxDiagnostic(hostile)).not.toThrow()

    const root: Record<string, unknown> = {}
    let current = root
    for (let depth = 0; depth < 10; depth += 1) {
      const next: Record<string, unknown> = {}
      current[`level${depth}`] = next
      current = next
    }
    root.circular = root
    root.items = Array.from({ length: 60 }, (_, index) => ({ index, body: `response-${index}` }))
    for (let index = 0; index < 80; index += 1) root[`property${index}`] = index
    const diagnostic = formatSandboxDiagnostic(Object.assign(new Error('deep failure'), { response: root })) ?? ''

    expect(diagnostic.length).toBeLessThanOrEqual(16_000)
    expect(diagnostic).toMatch(/Circular|Maximum depth|truncated|exhausted/i)
  })
})
