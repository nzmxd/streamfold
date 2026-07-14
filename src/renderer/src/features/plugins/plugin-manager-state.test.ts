import { describe, expect, it } from 'vitest'
import type { Account, PluginContribution } from '../../../../shared/contracts'
import {
  accountsForContribution,
  availableDataScopes,
  parseNetworkOrigins,
  requiresAccountScope,
  toggleListValue
} from './plugin-manager-state'

describe('plugin manager state', () => {
  it('updates checkbox lists without mutating the source', () => {
    const source = ['first']
    expect(toggleListValue(source, 'second')).toEqual(['first', 'second'])
    expect(toggleListValue(source, 'first')).toEqual([])
    expect(source).toEqual(['first'])
  })

  it('derives account and data scopes from declared permissions', () => {
    expect(requiresAccountScope(['network.https'])).toBe(false)
    expect(requiresAccountScope(['profiles.read'])).toBe(true)
    expect(availableDataScopes(['profiles.read', 'metrics.read'])).toEqual([
      { id: 'profile', label: '个人资料' },
      { id: 'metrics', label: '统计指标' }
    ])
  })

  it('normalizes newline, whitespace, and comma separated network origins', () => {
    expect(parseNetworkOrigins('https://one.example\n https://two.example,https://three.example')).toEqual([
      'https://one.example',
      'https://two.example',
      'https://three.example'
    ])
  })

  it('limits platform adapters to accounts on the declared platform', () => {
    const accounts = [
      { id: 'xhs', platformId: 'xiaohongshu' },
      { id: 'zhihu', platformId: 'zhihu' }
    ] as Account[]
    const adapter = {
      kind: 'platform.adapter',
      platform: { id: 'zhihu' }
    } as PluginContribution
    expect(accountsForContribution(adapter, accounts).map((account) => account.id)).toEqual(['zhihu'])
  })
})
