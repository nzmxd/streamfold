import { basename } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { dialog, type BrowserWindow } from 'electron'
import type {
  Account,
  AccountSnapshot,
  ContentDetail,
  ContentQuery,
  ContentSummary,
  ExportDataInput,
  ExportDataResult,
  Group
} from '../shared/contracts'
import { collectAllContents, serializeContentCsv } from './export-format'

interface ExportDatabase {
  listAccounts(): Account[]
  listGroups(): Group[]
  listAccountSnapshots(accountId?: string): AccountSnapshot[]
  listContents(query?: ContentQuery): ContentSummary[]
  getContentDetail(id: string): ContentDetail
}

export class ExportService {
  constructor(
    private readonly owner: BrowserWindow,
    private readonly database: ExportDatabase
  ) {}

  async exportData(input: ExportDataInput): Promise<ExportDataResult> {
    if (input.accountId && !this.database.listAccounts().some((account) => account.id === input.accountId)) {
      throw new Error('导出账号不存在')
    }
    const contents = collectAllContents(this.database, input.accountId)
    const date = new Date().toISOString().slice(0, 10)
    const extension = input.format
    const result = await dialog.showSaveDialog(this.owner, {
      title: input.format === 'json' ? '导出归页数据' : '导出内容 CSV',
      defaultPath: `streamfold-${date}.${extension}`,
      filters: input.format === 'json'
        ? [{ name: 'JSON 数据', extensions: ['json'] }]
        : [{ name: 'CSV 表格', extensions: ['csv'] }],
      properties: ['createDirectory', 'showOverwriteConfirmation']
    })
    if (result.canceled || !result.filePath) {
      return { cancelled: true, fileName: null, exportedContentCount: 0 }
    }

    const output = input.format === 'json'
      ? this.toJson(contents, input.accountId)
      : serializeContentCsv(contents)
    try {
      await writeFile(result.filePath, output, { encoding: 'utf8', mode: 0o600 })
    } catch {
      throw new Error('导出文件写入失败，请检查目标目录权限')
    }
    return {
      cancelled: false,
      fileName: basename(result.filePath),
      exportedContentCount: contents.length
    }
  }

  private toJson(contents: ContentSummary[], accountId?: string): string {
    const accounts = this.database.listAccounts()
      .filter((account) => !accountId || account.id === accountId)
      .map(({ sessionPartition: _partition, ...account }) => account)
    const accountIds = new Set(accounts.map((account) => account.id))
    const groups = this.database.listGroups()
      .filter((group) => accounts.some((account) => account.groupIds.includes(group.id)))
    const details = contents.map((content) => this.database.getContentDetail(content.id))
    return `${JSON.stringify({
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      scope: accountId ? 'account' : 'all',
      accounts,
      groups,
      accountSnapshots: this.database.listAccountSnapshots(accountId),
      contents: details.filter((content) => accountIds.has(content.accountId))
    }, null, 2)}\n`
  }

}
