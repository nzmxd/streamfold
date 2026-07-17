import { describe, expect, it } from 'vitest'
import { formatSandboxDiagnostic } from './sandbox-diagnostics'
import {
  PluginNetworkDiagnosticError,
  hasPluginApiError,
  normalizePluginNetworkError,
  pluginNetworkResponseError
} from './network-diagnostics'

describe('plugin network diagnostics', () => {
  it('keeps a bounded API error projection while dropping credentials and request metadata', () => {
    const error = pluginNetworkResponseError('remote API failed', {
      status: 429,
      contentType: 'Application/JSON; charset=utf-8',
      body: JSON.stringify({
        error: {
          code: 'RATE_LIMITED',
          message: 'try later',
          auth_token: 'secret-token',
          requestUrl: 'https://api.example.test/hook?account=owner&token=url-secret',
          headers: { Authorization: 'Bearer header-secret' },
          query: { account: 'owner' },
          params: { cursor: 'private-cursor' }
        },
        cookie: 'private-cookie'
      })
    })

    expect(error).toMatchObject({
      status: 429,
      contentType: 'application/json',
      responseBody: null,
      responseBytes: expect.any(Number),
      truncated: false
    })
    expect(error.apiError).toContain('RATE_LIMITED')
    expect(error.apiError).toContain('try later')
    const diagnostic = formatSandboxDiagnostic(error) ?? ''
    for (const visible of [
      'api.example.test', 'account=owner', 'requestUrl', 'headers', 'query', 'params', 'private-cursor'
    ]) expect(diagnostic).toContain(visible)
    for (const hidden of ['secret-token', 'url-secret', 'header-secret', 'private-cookie']) {
      expect(diagnostic).not.toContain(hidden)
    }
  })

  it('sanitizes and truncates a non-error response body', () => {
    const body = JSON.stringify({
      data: 'x'.repeat(20_000),
      accessToken: 'private-token',
      url: 'https://example.test/path?page=2&token=url-secret',
      headers: { 'X-Debug': 'trace-id', Authorization: 'Bearer header-secret' },
      params: { cursor: 'public-cursor' }
    })
    const error = pluginNetworkResponseError('invalid response', {
      status: 200,
      contentType: 'application/json',
      body
    })

    expect(error.apiError).toBeNull()
    expect(error.responseBody?.length).toBeLessThanOrEqual(8 * 1024)
    expect(error.responseBytes).toBe(Buffer.byteLength(body, 'utf8'))
    expect(error.truncated).toBe(true)
    expect(error.responseBody).not.toContain('private-token')
    expect(error.responseBody).not.toContain('url-secret')
    expect(error.responseBody).not.toContain('header-secret')
    expect(error.responseBody).toContain('https://example.test/path?page=2')
    expect(error.responseBody).toContain('trace-id')
    expect(error.responseBody).toContain('public-cursor')
  })

  it('removes common platform session fields from response projections', () => {
    const secrets = {
      ct0: 'X_CT0_SECRET',
      twid: 'X_TWID_SECRET',
      z_c0: 'ZHIHU_ZC0_SECRET',
      d_c0: 'ZHIHU_DC0_SECRET',
      q_c1: 'ZHIHU_QC1_SECRET',
      a1: 'XHS_A1_SECRET',
      web_session: 'XHS_SESSION_SECRET',
      webid: 'XHS_WEBID_SECRET'
    }
    const error = pluginNetworkResponseError('remote API failed', {
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'UPSTREAM_FAILED', ...secrets } })
    })
    const diagnostic = formatSandboxDiagnostic(error) ?? ''

    expect(diagnostic).toContain('UPSTREAM_FAILED')
    for (const secret of Object.values(secrets)) expect(diagnostic).not.toContain(secret)
  })

  it('normalizes transport failures without retaining the raw cause, URL, query or params', () => {
    const raw = new Error(
      'Failed https://api.example.test/path?token=secret headers={Authorization: Bearer hidden} params={cursor: private}'
    )
    const error = normalizePluginNetworkError(raw, 'platform request failed')

    expect(error).toBeInstanceOf(PluginNetworkDiagnosticError)
    expect(error.message).toBe('platform request failed')
    expect(error).not.toHaveProperty('cause')
    expect(error).toMatchObject({ status: null, contentType: '', responseBody: null, responseBytes: 0 })
    const diagnostic = formatSandboxDiagnostic(error) ?? ''
    expect(diagnostic).toContain('Failed')
    for (const hidden of ['api.example.test', 'secret', 'hidden', 'private', 'headers=', 'params=']) {
      expect(diagnostic).not.toContain(hidden)
    }
  })

  it('recognizes only meaningful API error envelopes', () => {
    expect(hasPluginApiError({ errors: [{ code: 88, message: 'limited' }] })).toBe(true)
    expect(hasPluginApiError({ success: false, code: 500, message: 'failed' })).toBe(true)
    expect(hasPluginApiError({ error_code: 403, message: 'denied' })).toBe(true)
    expect(hasPluginApiError({ errors: [], error: null, success: true })).toBe(false)
    expect(hasPluginApiError({ code: 0, data: { errorCount: 2 } })).toBe(false)
    expect(hasPluginApiError({ code: 200, message: 'ok' })).toBe(false)
  })

  it('preserves only fixed platform session messages for host classification', () => {
    expect(normalizePluginNetworkError(
      new Error('平台登录状态已失效，请重新登录 https://x.com/home?token=private'),
      'platform capture failed'
    ).message).toBe('平台登录状态已失效，请重新登录')
    expect(normalizePluginNetworkError(
      new Error('平台请求暂时受限，请稍后重试'),
      'platform capture failed'
    ).message).toBe('平台请求暂时受限，请稍后重试')
  })
})
