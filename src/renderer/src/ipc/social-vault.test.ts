import { reactive } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import type { SocialVaultBridge } from '../../../shared/contracts'
import { createSocialVaultApi } from './social-vault'

describe('social vault renderer facade', () => {
  it('passes only a channel and serialized plain-data string to the contextBridge', async () => {
    const invoke = vi.fn(async (_channel: string, _serializedArgs: string) => ({ rawRetentionDays: 30 }))
    const bridge: SocialVaultBridge = {
      runtime: { platform: 'win32' },
      invoke,
      on: vi.fn(() => () => undefined)
    }
    const api = createSocialVaultApi(bridge)
    const reactiveInput = reactive({ rawRetentionDays: 30 })

    await api.settings.update(reactiveInput)

    expect(invoke).toHaveBeenCalledOnce()
    expect(invoke).toHaveBeenCalledWith('settings:update', '[{"rawRetentionDays":30}]')
    expect(typeof invoke.mock.calls[0]?.[1]).toBe('string')
  })

  it('rejects invalid values before calling the contextBridge', () => {
    const invoke = vi.fn(async (_channel: string, _serializedArgs: string) => undefined)
    const bridge: SocialVaultBridge = {
      runtime: { platform: 'win32' },
      invoke,
      on: vi.fn(() => () => undefined)
    }
    const api = createSocialVaultApi(bridge)

    expect(() => api.settings.update({ rawRetentionDays: (() => 30) as never })).toThrow()
    expect(invoke).not.toHaveBeenCalled()
  })

  it('exposes batch sync and task channels through the plain-data bridge', async () => {
    const invoke = vi.fn(async (_channel: string, _serializedArgs: string) => ({ items: [], total: 0 }))
    const bridge: SocialVaultBridge = {
      runtime: { platform: 'win32' },
      invoke,
      on: vi.fn(() => () => undefined)
    }
    const api = createSocialVaultApi(bridge)

    await api.accounts.previewSyncBatch({
      accountIds: ['account-1'],
      groupIds: [],
      requestedScope: 'recent_20'
    })
    await api.tasks.list({ statuses: ['queued'], limit: 50 })
    await api.tasks.markHandled({ source: 'job', taskId: 'job-1' })

    expect(invoke).toHaveBeenNthCalledWith(
      1,
      'accounts:preview-sync-batch',
      '[{"accountIds":["account-1"],"groupIds":[],"requestedScope":"recent_20"}]'
    )
    expect(invoke).toHaveBeenNthCalledWith(
      2,
      'tasks:list',
      '[{"statuses":["queued"],"limit":50}]'
    )
    expect(invoke).toHaveBeenNthCalledWith(
      3,
      'tasks:mark-handled',
      '[{"source":"job","taskId":"job-1"}]'
    )
  })

  it('queries account metric history through the analytics allowlist', async () => {
    const invoke = vi.fn(async () => ({ metricDefinitions: [], snapshots: [] }))
    const bridge: SocialVaultBridge = {
      runtime: { platform: 'win32' },
      invoke,
      on: vi.fn(() => () => undefined)
    }

    await createSocialVaultApi(bridge).analytics.accountMetrics({
      accountId: 'account-1',
      period: 'last_30_days',
      limit: 2
    })

    expect(invoke).toHaveBeenCalledWith(
      'analytics:account-metrics',
      '[{"accountId":"account-1","period":"last_30_days","limit":2}]'
    )
  })

  it('exposes saved content filter views through fixed plain-data channels', async () => {
    const invoke = vi.fn(async () => undefined)
    const bridge: SocialVaultBridge = {
      runtime: { platform: 'win32' },
      invoke,
      on: vi.fn(() => () => undefined)
    }
    const api = createSocialVaultApi(bridge)
    const state = {
      keyword: '',
      accountId: '',
      platformId: '' as const,
      groupId: '',
      type: '' as const,
      tags: [],
      tagMatch: 'all' as const,
      bookmark: 'all' as const,
      syncWarningOnly: false,
      publishedFrom: '',
      publishedTo: '',
      capturedFrom: '',
      capturedTo: '',
      sort: 'published' as const,
      order: 'desc' as const,
      pageSize: 50
    }

    await api.content.listFilterViews()
    await api.content.saveFilterView({ name: '默认视图', state })
    await api.content.deleteFilterView('view-1')

    expect(invoke).toHaveBeenNthCalledWith(1, 'content:list-filter-views', '[]')
    expect(invoke).toHaveBeenNthCalledWith(
      2,
      'content:save-filter-view',
      JSON.stringify([{ name: '默认视图', state }])
    )
    expect(invoke).toHaveBeenNthCalledWith(3, 'content:delete-filter-view', '["view-1"]')
  })

  it('serializes custom theme colors through the fixed appearance channel', async () => {
    const invoke = vi.fn(async () => ({
      preference: 'system',
      resolved: 'light',
      themeColor: '#0f8a80'
    }))
    const bridge: SocialVaultBridge = {
      runtime: { platform: 'win32' },
      invoke,
      on: vi.fn(() => () => undefined)
    }

    await createSocialVaultApi(bridge).appearance.setThemeColor('#0f8a80')

    expect(invoke).toHaveBeenCalledWith('appearance:set-theme-color', '["#0f8a80"]')
  })

  it('subscribes to task changes through the fixed event channel', () => {
    const listener = vi.fn()
    const on = vi.fn(() => () => undefined)
    const bridge: SocialVaultBridge = {
      runtime: { platform: 'win32' },
      invoke: vi.fn(async () => undefined),
      on
    }

    createSocialVaultApi(bridge).tasks.onChanged(listener)

    expect(on).toHaveBeenCalledWith('tasks:changed', expect.any(Function))
  })

  it('subscribes to background identity previews through a fixed event channel', () => {
    const listener = vi.fn()
    const on = vi.fn(() => () => undefined)
    const bridge: SocialVaultBridge = {
      runtime: { platform: 'win32' },
      invoke: vi.fn(async () => undefined),
      on
    }

    createSocialVaultApi(bridge).accounts.onIdentityPreview(listener)

    expect(on).toHaveBeenCalledWith('accounts:identity-preview', expect.any(Function))
  })
})
