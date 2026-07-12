export interface StorageOverview {
  appVersion: string
  electronVersion: string
  chromiumVersion: string
  nodeVersion: string
  databaseBytes: number
  accountCount: number
  contentCount: number
  contentSnapshotCount: number
  accountSnapshotCount: number
  jobCount: number
  importCount: number
  rawRetentionDays: number
  lastExportAt: string | null
}

export interface UpdateSettingsInput {
  rawRetentionDays?: number
}

export interface ExportDataInput {
  format: 'json' | 'csv'
  accountId?: string
}

export interface ExportDataResult {
  cancelled: boolean
  fileName: string | null
  exportedContentCount: number
}
