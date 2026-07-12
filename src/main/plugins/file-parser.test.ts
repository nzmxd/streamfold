import { describe, expect, it } from 'vitest'
import { SafeImportError } from './errors'
import {
  MAX_IMPORT_ROWS,
  MAX_IMPORT_WARNINGS,
  parseCsvImport,
  parseJsonImport,
  stableRemoteIdForUrl
} from './file-parser'

const options = { capturedAt: '2026-07-13T08:00:00.000Z' }

describe('generic file import parser', () => {
  it('normalizes camelCase and snake_case JSON shapes', () => {
    const payload = parseJsonImport(JSON.stringify({
      captured_at: '2026-07-12T08:00:00Z',
      account: {
        remote_id: 'owner-1',
        remoteName: '本人账号',
        followers: 12,
        content_count: 1,
        views_total: 120
      },
      contents: [{
        remote_id: 'post-1',
        type: 'article',
        title: '标题',
        body_excerpt: '摘要',
        url: 'https://example.com/posts/1#section',
        published_at: '2026-07-10',
        snapshots: [{
          captured_at: '2026-07-12T08:00:00Z',
          views: 100,
          likes: 10,
          comments: 2,
          shares: 1,
          favorites: 7
        }]
      }]
    }), options)

    expect(payload.capturedAt).toBe('2026-07-12T08:00:00.000Z')
    expect(payload.profile).toEqual({
      remoteId: 'owner-1',
      remoteName: '本人账号',
      followers: 12,
      following: null,
      contentCount: 1,
      viewsTotal: 120
    })
    expect(payload.contents[0]).toMatchObject({
      remoteId: 'post-1',
      type: 'article',
      title: '标题',
      bodyExcerpt: '摘要',
      url: 'https://example.com/posts/1',
      publishedAt: '2026-07-10T00:00:00.000Z'
    })
    expect(payload.contents[0]?.snapshots[0]?.views).toBe(100)
  })

  it('parses quoted commas, escaped quotes and quoted newlines in CSV', () => {
    const source = [
      'remote_id,type,title,body_excerpt,url,published_at,views,likes',
      'p-1,post,"A, B","line 1\nline 2",https://example.com/p/1,2026-07-01,10,2',
      'p-2,article,"He said ""hello""",body,https://example.com/p/2,2026-07-02,20,3'
    ].join('\r\n')
    const payload = parseCsvImport(source, options)

    expect(payload.contents).toHaveLength(2)
    expect(payload.contents[0]?.title).toBe('A, B')
    expect(payload.contents[0]?.bodyExcerpt).toBe('line 1\nline 2')
    expect(payload.contents[1]?.title).toBe('He said "hello"')
    expect(payload.contents[1]?.snapshots[0]).toMatchObject({ views: 20, likes: 3 })
  })

  it('creates a stable remote id only from a safe HTTPS URL', () => {
    const first = stableRemoteIdForUrl('https://EXAMPLE.com/post/1?b=2&a=1#fragment')
    const second = stableRemoteIdForUrl('https://example.com/post/1?a=1&b=2')
    expect(first).toBe(second)

    const payload = parseJsonImport(JSON.stringify([{
      type: 'post',
      title: '无 ID',
      url: 'https://example.com/post/1'
    }]), options)
    expect(payload.contents[0]?.remoteId).toMatch(/^url-sha256:[a-f0-9]{64}$/)

    expect(() => parseJsonImport(JSON.stringify([{
      type: 'post',
      title: '不安全',
      url: 'http://example.com/post/1'
    }]), options)).toThrowError(expect.objectContaining({ code: 'INVALID_URL' }))
  })

  it('rejects signed URLs and keeps only public identifier parameters', () => {
    expect(() => parseJsonImport(JSON.stringify([{
      remoteId: 'post-1',
      type: 'post',
      url: 'https://cdn.example.com/file?id=1&signature=SECRET'
    }]), options)).toThrowError(expect.objectContaining({ code: 'SENSITIVE_FIELD' }))

    expect(() => parseJsonImport(JSON.stringify([{
      remoteId: 'post-fragment',
      type: 'post',
      url: 'https://example.com/post#signature=SECRET'
    }]), options)).toThrowError(expect.objectContaining({ code: 'SENSITIVE_FIELD' }))

    expect(() => parseJsonImport(JSON.stringify([{
      remoteId: 'post-route-fragment',
      type: 'post',
      url: 'https://example.com/post#/route?x=1&x-amz-signature=SECRET'
    }]), options)).toThrowError(expect.objectContaining({ code: 'SENSITIVE_FIELD' }))

    const payload = parseJsonImport(JSON.stringify([{
      remoteId: 'post-2',
      type: 'post',
      url: 'https://example.com/post?id=42&utm_source=share&tracking=abc#fragment'
    }]), options)
    expect(payload.contents[0]?.url).toBe('https://example.com/post?id=42')
  })

  it.each([
    [{ account: { remoteId: 'a', remoteName: 'n', cookie: 'secret' }, contents: [] }],
    [{ contents: [{ remoteId: '1', type: 'post', title: 'x', access_token: 'secret' }] }],
    [{ contents: [], nested: { password: 'secret' } }]
  ])('rejects sensitive JSON keys anywhere in the document', (value) => {
    expect(() => parseJsonImport(JSON.stringify(value), options)).toThrowError(
      expect.objectContaining({ code: 'SENSITIVE_FIELD' })
    )
  })

  it('rejects sensitive CSV columns before reading values', () => {
    expect(() => parseCsvImport(
      'remote_id,type,title,cookie\np-1,post,title,secret',
      options
    )).toThrowError(expect.objectContaining({ code: 'SENSITIVE_FIELD' }))
  })

  it.each([
    ['negative JSON metric', JSON.stringify([{ remoteId: '1', type: 'post', title: 'x', views: -1 }]), 'json'],
    ['fractional JSON metric', JSON.stringify([{ remoteId: '1', type: 'post', title: 'x', likes: 1.5 }]), 'json'],
    ['oversized CSV metric', 'remote_id,type,title,views\n1,post,x,9007199254740992', 'csv'],
    ['invalid content type', JSON.stringify([{ remoteId: '1', type: 'unknown', title: 'x' }]), 'json']
  ])('rejects %s', (_name, source, format) => {
    const action = (): unknown => format === 'json'
      ? parseJsonImport(source, options)
      : parseCsvImport(source, options)
    expect(action).toThrow(SafeImportError)
  })

  it('enforces the 5000-row limit', () => {
    const rows = Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, index) =>
      `${index},post,title`
    )
    expect(() => parseCsvImport(
      ['remote_id,type,title', ...rows].join('\n'),
      options
    )).toThrowError(expect.objectContaining({ code: 'IMPORT_ROW_LIMIT_EXCEEDED' }))
  })

  it('rejects normalized-but-impossible calendar dates', () => {
    expect(() => parseJsonImport(JSON.stringify([{
      remoteId: '1',
      type: 'post',
      title: 'x',
      publishedAt: '2026-02-30'
    }]), options)).toThrowError(expect.objectContaining({ code: 'INVALID_DATE' }))
  })

  it('caps warnings without rejecting otherwise valid content', () => {
    const contents = Array.from({ length: MAX_IMPORT_WARNINGS + 25 }, (_, index) => ({
      remoteId: String(index),
      type: 'post'
    }))
    const payload = parseJsonImport(JSON.stringify(contents), options)
    expect(payload.warnings).toHaveLength(MAX_IMPORT_WARNINGS)
    expect(payload.warnings.at(-1)).toBe('其余警告已省略')
  })
})
