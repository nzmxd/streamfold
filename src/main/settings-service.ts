import { stat } from 'node:fs/promises'
import type { StorageOverview, UpdateSettingsInput } from '../shared/contracts'

export interface StorageCounts {
  accountCount: number
  contentCount: number
  contentSnapshotCount: number
  accountSnapshotCount: number
  jobCount: number
}

interface SettingsDatabase {
  getStorageCounts(): StorageCounts
  getSetting(key: string): string | null
  setSetting(key: string, value: string): void
}

export interface RuntimeVersions {
  appVersion: string
  electronVersion: string
  chromiumVersion: string
  nodeVersion: string
}

export class SettingsService {
  constructor(
    private readonly database: SettingsDatabase,
    private readonly databasePath: string,
    private readonly versions: RuntimeVersions
  ) {}

  async overview(): Promise<StorageOverview> {
    const counts = this.database.getStorageCounts()
    return {
      ...this.versions,
      databaseBytes: await fileSize(this.databasePath),
      ...counts,
      rawRetentionDays: readIntegerSetting(this.database, 'raw_retention_days', 7),
      autoCheckUpdates: readBooleanSetting(this.database, 'updates.auto_check', true),
      lastExportAt: this.database.getSetting('last_export_at'),
      lastBackupAt: this.database.getSetting('last_backup_at'),
      lastRestoreAt: this.database.getSetting('last_restore_at')
    }
  }

  async update(input: UpdateSettingsInput): Promise<StorageOverview> {
    if (input.rawRetentionDays !== undefined) {
      this.database.setSetting('raw_retention_days', String(input.rawRetentionDays))
    }
    if (input.autoCheckUpdates !== undefined) {
      this.database.setSetting('updates.auto_check', String(input.autoCheckUpdates))
    }
    return this.overview()
  }

  markExportCompleted(): void {
    this.database.setSetting('last_export_at', new Date().toISOString())
  }
}

function readBooleanSetting(database: SettingsDatabase, key: string, fallback: boolean): boolean {
  const stored = database.getSetting(key)
  if (stored === 'true') return true
  if (stored === 'false') return false
  return fallback
}

async function fileSize(path: string): Promise<number> {
  if (path === ':memory:') return 0
  try {
    return (await stat(path)).size
  } catch {
    return 0
  }
}

function readIntegerSetting(database: SettingsDatabase, key: string, fallback: number): number {
  const stored = database.getSetting(key)
  if (stored === null) return fallback
  const value = Number(stored)
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback
}
