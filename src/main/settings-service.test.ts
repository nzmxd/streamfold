import { describe, expect, it } from 'vitest'
import { SettingsService, type StorageCounts } from './settings-service'

describe('SettingsService', () => {
  it('reads and updates local retention settings', async () => {
    const values = new Map<string, string>()
    const counts: StorageCounts = {
      accountCount: 2,
      contentCount: 3,
      contentSnapshotCount: 4,
      accountSnapshotCount: 1,
      jobCount: 5,
      importCount: 2
    }
    const service = new SettingsService({
      getStorageCounts: () => counts,
      getSetting: (key) => values.get(key) ?? null,
      setSetting: (key, value) => { values.set(key, value) }
    }, ':memory:', {
      appVersion: '0.2.0', electronVersion: '43', chromiumVersion: '144', nodeVersion: '24'
    })

    expect((await service.overview()).rawRetentionDays).toBe(7)
    expect((await service.overview()).autoCheckUpdates).toBe(true)
    const updated = await service.update({ rawRetentionDays: 0, autoCheckUpdates: false })
    expect(updated.rawRetentionDays).toBe(0)
    expect(updated.autoCheckUpdates).toBe(false)
    service.markExportCompleted()
    expect((await service.overview()).lastExportAt).toMatch(/^\d{4}-/)
  })
})
