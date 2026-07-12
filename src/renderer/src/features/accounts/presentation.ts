import type { AccountStatus, SyncMode } from '../../../../shared/contracts'

export function statusPresentation(status: AccountStatus): { label: string; tone: string } {
  const values: Record<AccountStatus, { label: string; tone: string }> = {
    pending: { label: '待登录', tone: 'warning' },
    ready: { label: '正常', tone: 'success' },
    paused: { label: '已暂停', tone: 'muted' },
    expired: { label: '需登录', tone: 'danger' },
    mismatch: { label: '身份不匹配', tone: 'danger' },
    cooldown: { label: '冷却中', tone: 'warning' },
    unsupported: { label: '暂不支持', tone: 'muted' }
  }
  return values[status]
}

export function syncModeLabel(mode: SyncMode): string {
  const values: Record<SyncMode, string> = {
    profile_only: '仅账号资料',
    recent_20: '最近 20 条',
    recent_100: '最近 100 条',
    disabled: '暂不同步'
  }
  return values[mode]
}
