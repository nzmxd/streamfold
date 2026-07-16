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
    expect(entry).toMatchObject({ code: '401', details: 'remote rejection stack' })
    expect(entry?.message).not.toContain('user:pass')
    expect(entry?.message).not.toContain('CODESECRET')
    expect(entry?.message).not.toContain('STATESECRET')
    expect(entry?.message).toContain('REDACTED')
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
