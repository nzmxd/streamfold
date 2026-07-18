import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  Account,
  AccountMetricHistory,
  AccountMetricSnapshot,
  ContentSummary
} from '../shared/contracts'

const { showSaveDialog, writeFile } = vi.hoisted(() => ({
  showSaveDialog: vi.fn(),
  writeFile: vi.fn()
}))

vi.mock('electron', () => ({ dialog: { showSaveDialog } }))
vi.mock('node:fs/promises', () => ({ writeFile }))

import { ExportService } from './export-service'

describe('ExportService JSON export', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: 'C:\\exports\\streamfold.json' })
    writeFile.mockResolvedValue(undefined)
  })

  it('exports schema v3 account metric history without truncating at one database page', async () => {
    const account = {
      id: 'account-1',
      platformId: 'zhihu',
      sessionPartition: 'persist:social:account-1',
      groupIds: []
    } as unknown as Account
    const snapshot = (index: number): AccountMetricSnapshot => ({
      accountId: account.id,
      period: 'daily',
      periodStart: '2026-07-15',
      periodEnd: '2026-07-15',
      status: null,
      metrics: { views: index },
      capturedAt: `2026-07-15T00:00:${String(index % 60).padStart(2, '0')}.000Z`
    })
    const firstPage = Array.from({ length: 5_000 }, (_, index) => snapshot(index))
    const lastPage = [snapshot(5_000)]
    const offsets: number[] = []
    const database = {
      listAccounts: () => [account],
      listGroups: () => [],
      listAccountSnapshots: () => [],
      getAccountMetricHistory: ({ offset = 0 }: { accountId: string; limit?: number; offset?: number }): AccountMetricHistory => {
        offsets.push(offset)
        return {
          accountId: account.id,
          platformId: account.platformId,
          metricDefinitions: [{
            id: 'views', label: '浏览量', valueKind: 'count', unit: 'count', group: 'reach', sortOrder: 10
          }],
          snapshots: offset === 0 ? firstPage : lastPage
        }
      },
      listContents: () => [],
      searchContents: () => ({
        items: [], total: 0, offset: 0, limit: 100, hasMore: false, searchMode: 'none' as const
      }),
      getContentDetail: () => { throw new Error('unexpected content detail read') }
    }

    await expect(new ExportService({} as never, database).exportData({ format: 'json' }))
      .resolves.toMatchObject({ cancelled: false, exportedContentCount: 0 })

    expect(offsets).toEqual([0, 5_000])
    const output = writeFile.mock.calls[0]?.[1] as string
    const parsed = JSON.parse(output) as Record<string, unknown>
    expect(parsed.schemaVersion).toBe(3)
    expect(parsed.accounts).toEqual([expect.not.objectContaining({ sessionPartition: expect.anything() })])
    expect((parsed.accountMetricHistories as AccountMetricHistory[])[0]?.snapshots).toHaveLength(5_001)
  })

  it('exports every page in the current content filter', async () => {
    const template: ContentSummary = {
      id: 'content-0', accountId: 'account-1', accountAlias: '测试账号', platformId: 'zhihu',
      remoteId: 'remote-0', type: 'article', title: '筛选结果', bodyExcerpt: '', url: '',
      publishedAt: null, firstCapturedAt: '2026-07-15T00:00:00.000Z',
      lastCapturedAt: '2026-07-15T01:00:00.000Z', updatedAt: '2026-07-15T01:00:00.000Z',
      note: '', tags: ['研究'], isBookmarked: true, latestSnapshot: null, previousSnapshot: null
    }
    const contents = Array.from({ length: 5_001 }, (_, index) => ({
      ...template,
      id: `content-${index}`,
      remoteId: `remote-${index}`
    }))
    const queries: Array<{ offset?: number; limit?: number; syncWarningOnly?: boolean }> = []
    const database = {
      listAccounts: () => [],
      listGroups: () => [],
      listAccountSnapshots: () => [],
      getAccountMetricHistory: () => { throw new Error('unexpected account metric read') },
      listContents: () => [],
      searchContents: (query: { offset?: number; limit?: number; syncWarningOnly?: boolean }) => {
        queries.push({ ...query })
        const { offset = 0, limit = 100 } = query
        const items = contents.slice(offset, offset + limit)
        return { items, total: contents.length, offset, limit, hasMore: offset + items.length < contents.length, searchMode: 'none' as const }
      },
      getContentDetail: () => { throw new Error('unexpected content detail read') }
    }

    await expect(new ExportService({} as never, database).exportFiltered({
      query: { keyword: '筛选', syncWarningOnly: true },
      format: 'csv'
    })).resolves.toMatchObject({ cancelled: false, exportedContentCount: 5_001 })

    expect(queries).toEqual([
      { keyword: '筛选', syncWarningOnly: true, offset: 0, limit: 5_000 },
      { keyword: '筛选', syncWarningOnly: true, offset: 5_000, limit: 5_000 }
    ])
    expect(writeFile.mock.calls[0]?.[1]).toContain('is_bookmarked')
  })
})
