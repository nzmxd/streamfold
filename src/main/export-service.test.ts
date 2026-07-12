import { describe, expect, it } from 'vitest'
import type { ContentSummary } from '../shared/contracts'
import { collectAllContents, serializeContentCsv } from './export-format'

describe('CSV export safety', () => {
  it('quotes fields and neutralizes spreadsheet formulas', () => {
    const content: ContentSummary = {
      id: 'content', accountId: 'account', accountAlias: '+工作号', platformId: 'weibo',
      remoteId: 'remote', type: 'post', title: '=1+1', bodyExcerpt: '含有,"引号"',
      url: 'https://weibo.com/1', publishedAt: null, firstCapturedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z', note: '', tags: [],
      latestSnapshot: null, previousSnapshot: null
    }
    const csv = serializeContentCsv([content])
    expect(csv).toContain('"\'+工作号"')
    expect(csv).toContain('"\'=1+1"')
    expect(csv).toContain('"含有,""引号"""')
  })

  it('collects every page instead of truncating at 5000 contents', () => {
    const template: ContentSummary = {
      id: '0', accountId: 'account', accountAlias: '账号', platformId: 'weibo',
      remoteId: 'remote', type: 'post', title: '', bodyExcerpt: '', url: '',
      publishedAt: null, firstCapturedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z', note: '', tags: [],
      latestSnapshot: null, previousSnapshot: null
    }
    const all = Array.from({ length: 5_001 }, (_, index) => ({
      ...template, id: String(index), remoteId: `remote-${index}`
    }))
    const offsets: number[] = []
    const contents = collectAllContents({
      listContents: (query) => {
        const offset = query.offset ?? 0
        offsets.push(offset)
        return all.slice(offset, offset + (query.limit ?? 100))
      }
    })
    expect(contents).toHaveLength(5_001)
    expect(offsets).toEqual([0, 5_000])
  })
})
