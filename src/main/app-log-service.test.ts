import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { AppLogService } from './app-log-service'

describe('AppLogService', () => {
  it('stores structured entries, filters them and redacts secrets', () => {
    const directory = mkdtempSync(join(tmpdir(), 'streamfold-logs-'))
    const service = new AppLogService(directory)
    service.info('app', '启动完成')
    service.error('sync', '请求失败 password=plain', {
      code: 'SYNC_FAILED',
      details: 'Authorization: Bearer abc.def',
      context: { accountId: 'account-1', accessToken: 'hidden' }
    })

    const result = service.list({ level: 'error', search: 'sync_failed' })
    expect(result.total).toBe(1)
    expect(result.items[0]).toMatchObject({
      level: 'error',
      scope: 'sync',
      code: 'SYNC_FAILED',
      context: { accountId: 'account-1' }
    })
    expect(result.items[0]?.message).toContain('password=[REDACTED]')
    expect(result.items[0]?.details).toContain('[REDACTED]')
    expect(result.items[0]?.details).not.toContain('abc.def')
    expect(result.items[0]?.context).not.toHaveProperty('accessToken')
  })

  it('redacts JSON, header and context credential variants', () => {
    const directory = mkdtempSync(join(tmpdir(), 'streamfold-logs-'))
    const service = new AppLogService(directory)
    service.error(
      'network',
      'failed {"cookie":"cookie-value","apiKey":"api-value","refresh_token":"refresh-value"}',
      {
        details: 'Cookie: session-value\nX-Api-Key: header-value\n{"csrfToken":"csrf-value"}',
        context: {
          sessionId: 'session-id-value',
          apiKey: 'context-api-value',
          csrf: 'context-csrf-value',
          accountId: 'account-1'
        }
      }
    )

    const serialized = JSON.stringify(service.list().items[0])
    for (const secret of [
      'cookie-value', 'api-value', 'refresh-value', 'session-value', 'header-value',
      'csrf-value', 'session-id-value', 'context-api-value', 'context-csrf-value'
    ]) expect(serialized).not.toContain(secret)
    expect(service.list().items[0]?.context).toEqual({ accountId: 'account-1' })
  })

  it('redacts URL credentials and preserves structured non-Error rejection details', () => {
    const directory = mkdtempSync(join(tmpdir(), 'streamfold-logs-'))
    const service = new AppLogService(directory)
    service.captureError('oauth', {
      message: 'callback https://user:pass@example.com/cb?auth_code=CODESECRET&state=STATESECRET',
      stack: 'remote rejection stack',
      code: 401
    })

    const entry = service.list().items[0]
    expect(entry).toMatchObject({ code: '401' })
    expect(entry?.details).toContain('remote rejection stack')
    expect(entry?.message).not.toContain('user:pass')
    expect(entry?.message).not.toContain('CODESECRET')
    expect(entry?.message).not.toContain('STATESECRET')
    expect(entry?.message).toContain('REDACTED')
  })

  it('redacts generic tokens, authorization schemes, URL fragments and truncated secret text', () => {
    const directory = mkdtempSync(join(tmpdir(), 'streamfold-logs-'))
    const service = new AppLogService(directory)
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhY2NvdW50In0.signature123'
    service.error(
      'network',
      [
        'token=GENERIC_TOKEN',
        'authorization=Basic BASIC_CREDENTIAL',
        `standalone ${jwt}`,
        'https://example.com/callback#access_token=FRAGMENT_TOKEN&state=FRAGMENT_STATE',
        'Authorization=Digest username="user", response="DIGEST_SECRET"'
      ].join('\n'),
      {
        details: `{"xsec_token":"XSEC_TOKEN"}\nCookie: web_session=COOKIE_VALUE\n` +
          `cookieJar=first=COOKIE_ONE; second=COOKIE_TWO\n` +
          `loose_a=COOKIE_THREE; loose_b=COOKIE_FOUR\n` +
          `{"cookieValue":"${'UNFINISHED_COOKIE '.repeat(2_000)}`,
        context: {
          token: 'CONTEXT_TOKEN',
          confirmationToken: 'CONFIRMATION_TOKEN',
          authToken: 'AUTH_TOKEN',
          accountId: 'account-1'
        }
      }
    )

    const serialized = JSON.stringify(service.list().items[0])
    for (const secret of [
      'GENERIC_TOKEN', 'BASIC_CREDENTIAL', jwt, 'FRAGMENT_TOKEN', 'FRAGMENT_STATE',
      'DIGEST_SECRET', 'XSEC_TOKEN', 'COOKIE_VALUE', 'COOKIE_ONE', 'COOKIE_TWO',
      'COOKIE_THREE', 'COOKIE_FOUR', 'UNFINISHED_COOKIE', 'CONTEXT_TOKEN',
      'CONFIRMATION_TOKEN', 'AUTH_TOKEN'
    ]) expect(serialized).not.toContain(secret)
    expect(service.list().items[0]?.context).toEqual({ accountId: 'account-1' })
  })

  it('captures error properties, causes and aggregate failures without leaking nested credentials', () => {
    const directory = mkdtempSync(join(tmpdir(), 'streamfold-logs-'))
    const service = new AppLogService(directory)
    const cause = Object.assign(new Error('远端请求失败'), {
      statusCode: 503,
      response: {
        url: 'https://example.com/api?token=RESPONSE_TOKEN',
        headers: { cookie: 'REMOTE_COOKIE' },
        body: { reason: 'service unavailable' }
      }
    })
    const error = Object.assign(
      new AggregateError([new Error('解析响应失败')], '同步失败', { cause }),
      { code: 'SYNC_FAILED', status: 502, request: { method: 'GET', requestId: 'request-1' } }
    )

    service.captureError('sync', error, { jobId: 'job-1' })
    const entry = service.list().items[0]
    expect(entry).toMatchObject({ code: 'SYNC_FAILED', context: { jobId: 'job-1' } })
    expect(entry?.details).toContain('statusCode')
    expect(entry?.details).toContain('503')
    expect(entry?.details).toContain('原因')
    expect(entry?.details).toContain('聚合错误 1')
    expect(entry?.details).toContain('request-1')
    expect(entry?.details).not.toContain('RESPONSE_TOKEN')
    expect(entry?.details).not.toContain('REMOTE_COOKIE')
  })

  it('redacts dotted, encoded, folded and nested credential formats', () => {
    const directory = mkdtempSync(join(tmpdir(), 'streamfold-logs-'))
    const service = new AppLogService(directory)
    service.error('security', [
      'password=correct horse battery staple',
      'password="quoted password value"',
      '{"auth.token":"DOTTED_TOKEN","headers.authorization":"DOTTED_AUTH","cookie.value":"DOTTED_COOKIE"}',
      '{"access token":"SPACED_TOKEN","\\u0074oken":"UNICODE_TOKEN"}',
      'token%3DURLENCODED_TOKEN',
      'password%3DPASSENC_A+PASSENC_B+PASSENC_C',
      'Cookie%3A%20sid%3DENCODED_COOKIE',
      '[sid=BRACKET_COOKIE_A; foo=BRACKET_COOKIE_B]',
      'token -> TOKEN_ARROW_SECRET',
      'token is TOKEN_NARRATIVE_SECRET',
      'Authorization: Digest',
      ' response=FOLDED_DIGEST_SECRET',
      'Digest username="user", nonce="nonce", response="STANDALONE_DIGEST_SECRET"'
    ].join('\n'))
    service.error('security', '-----BEGIN PRIVATE KEY-----\nTRUNCATED_PRIVATE_KEY_SECRET')

    service.captureError('network', Object.assign(new Error('response failed'), {
      status: 502,
      response: {
        body: '{"token":"NESTED_BODY_TOKEN","cookie":"NESTED_BODY_COOKIE"}',
        form: 'access_token=NESTED_FORM_TOKEN&state=STATE_VALUE',
        values: ['sid=NESTED_COOKIE_A; foo=NESTED_COOKIE_B']
      }
    }))

    const serialized = JSON.stringify(service.list().items)
    for (const secret of [
      'correct horse battery staple', 'quoted password value', 'DOTTED_TOKEN', 'DOTTED_AUTH',
      'DOTTED_COOKIE', 'SPACED_TOKEN', 'UNICODE_TOKEN', 'URLENCODED_TOKEN', 'ENCODED_COOKIE',
      'PASSENC_A', 'PASSENC_B', 'PASSENC_C',
      'BRACKET_COOKIE_A', 'BRACKET_COOKIE_B', 'FOLDED_DIGEST_SECRET',
      'TOKEN_ARROW_SECRET', 'TOKEN_NARRATIVE_SECRET', 'TRUNCATED_PRIVATE_KEY_SECRET',
      'STANDALONE_DIGEST_SECRET', 'NESTED_BODY_TOKEN', 'NESTED_BODY_COOKIE',
      'NESTED_FORM_TOKEN', 'NESTED_COOKIE_A', 'NESTED_COOKIE_B'
    ]) expect(serialized).not.toContain(secret)
    expect(serialized).toContain('502')
  })

  it('handles hostile errors and bounds deeply nested diagnostic data', () => {
    const directory = mkdtempSync(join(tmpdir(), 'streamfold-logs-'))
    const service = new AppLogService(directory)
    const hostile = new Proxy({}, {
      get: () => { throw new Error('get trap') },
      getOwnPropertyDescriptor: () => { throw new Error('descriptor trap') },
      getPrototypeOf: () => { throw new Error('prototype trap') },
      ownKeys: () => { throw new Error('keys trap') }
    })
    expect(() => service.captureError('plugin', hostile)).not.toThrow()

    const tree = (depth: number): Record<string, unknown> => depth === 0
      ? { value: 'leaf' }
      : Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`branch${index}`, tree(depth - 1)]))
    const startedAt = performance.now()
    const entry = service.captureError('plugin', Object.assign(new Error('deep failure'), { tree: tree(4) }))
    expect(performance.now() - startedAt).toBeLessThan(1_000)
    expect(entry.details?.length).toBeLessThanOrEqual(64_000)
    expect(entry.details).toContain('diagnosticTruncated')
  })

  it('sanitizes historical JSONL on startup and keeps list and export output safe', () => {
    const directory = mkdtempSync(join(tmpdir(), 'streamfold-logs-'))
    const currentPath = join(directory, 'app.jsonl')
    writeFileSync(currentPath, `${JSON.stringify({
      id: 'legacy-entry',
      timestamp: new Date().toISOString(),
      level: 'error',
      scope: 'legacy',
      message: 'token=LEGACY_TOKEN',
      code: 'LEGACY_FAILURE',
      details: 'Authorization: Bearer LEGACY_BEARER\nCookie: LEGACY_COOKIE\n' +
        'body={\\"auth.token\\":\\"LEGACY_ESCAPED_TOKEN\\"}',
      context: { authToken: 'LEGACY_CONTEXT_TOKEN', jobId: 'job-1' }
    })}\n`, 'utf8')

    const service = new AppLogService(directory)
    service.sanitizeStoredLogs()
    const exportPath = join(directory, 'safe-export.jsonl')
    service.exportTo(exportPath)
    const output = `${JSON.stringify(service.list().items)}\n${readFileSync(currentPath, 'utf8')}\n${readFileSync(exportPath, 'utf8')}`
    for (const secret of [
      'LEGACY_TOKEN', 'LEGACY_BEARER', 'LEGACY_COOKIE', 'LEGACY_CONTEXT_TOKEN',
      'LEGACY_ESCAPED_TOKEN'
    ]) {
      expect(output).not.toContain(secret)
    }
    expect(service.list().items[0]?.context).toEqual({ jobId: 'job-1' })
  })

  it('notifies listeners, exports JSONL and clears previous entries', () => {
    const directory = mkdtempSync(join(tmpdir(), 'streamfold-logs-'))
    const service = new AppLogService(directory)
    const listener = vi.fn()
    service.onChanged(listener)
    service.warn('plugin', '运行被暂停')
    expect(listener).toHaveBeenCalledOnce()

    const exportPath = join(directory, 'export.jsonl')
    expect(service.exportTo(exportPath)).toMatchObject({ exportedCount: 1 })
    expect(readFileSync(exportPath, 'utf8')).toContain('运行被暂停')

    service.clear()
    const remaining = service.list()
    expect(remaining.total).toBe(1)
    expect(remaining.items[0]?.message).toBe('诊断日志已清空')
  })

  it('exports every matching entry instead of truncating at the UI list limit', () => {
    const directory = mkdtempSync(join(tmpdir(), 'streamfold-logs-'))
    const entries = Array.from({ length: 2_005 }, (_, index) => JSON.stringify({
      id: `entry-${index}`,
      timestamp: new Date(1_700_000_000_000 + index).toISOString(),
      level: 'info',
      scope: 'bulk',
      message: `entry-${index}`,
      code: null,
      details: null,
      context: {}
    }))
    writeFileSync(join(directory, 'app.jsonl'), `${entries.join('\n')}\n`, 'utf8')
    const service = new AppLogService(directory)

    const exportPath = join(directory, 'all.jsonl')
    expect(service.exportTo(exportPath, { scope: 'bulk' }).exportedCount).toBe(2_005)
    expect(readFileSync(exportPath, 'utf8').trim().split('\n')).toHaveLength(2_005)
  })
})
