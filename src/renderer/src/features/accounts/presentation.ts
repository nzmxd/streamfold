import type {
  Account,
  AccountStatus,
  ConnectionStatus,
  OwnershipStatus,
  SyncMode,
  SyncStatus
} from '../../../../shared/contracts'

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

export function accountHealthPresentation(account: Account): { label: string; tone: string } {
  if (['expired', 'mismatch'].includes(account.connectionStatus)) {
    return { label: connectionStatusLabel(account.connectionStatus), tone: 'danger' }
  }
  if (account.connectionStatus === 'disconnected') return { label: '会话已断开', tone: 'muted' }
  if (account.syncStatus === 'failed') return { label: '同步失败', tone: 'danger' }
  if (!account.syncEnabled) return { label: '同步已暂停', tone: 'muted' }
  if (account.syncStatus === 'unsupported') return { label: '当前插件不支持', tone: 'muted' }
  if (account.syncStatus === 'cooldown' || account.connectionStatus === 'pending') {
    return { label: account.syncStatus === 'cooldown' ? '同步冷却中' : '等待登录', tone: 'warning' }
  }
  return { label: '状态正常', tone: 'success' }
}

export function syncModeLabel(mode: SyncMode): string {
  const values: Record<SyncMode, string> = {
    profile_only: '仅账号资料',
    recent_20: '最近 20 条作品',
    recent_100: '最近 100 条作品',
    disabled: '不允许平台同步'
  }
  return values[mode]
}

export function connectionStatusLabel(status: ConnectionStatus): string {
  const values: Record<ConnectionStatus, string> = {
    pending: '等待登录',
    ready: '会话有效',
    expired: '登录已过期',
    mismatch: '登录身份不匹配',
    disconnected: '会话已断开'
  }
  return values[status]
}

export function ownershipStatusLabel(status: OwnershipStatus): string {
  const values: Record<OwnershipStatus, string> = {
    unconfirmed: '尚未确认',
    user_confirmed: '本人已确认',
    plugin_verified: '已核验'
  }
  return values[status]
}

export function syncStatusLabel(status: SyncStatus): string {
  const values: Record<SyncStatus, string> = {
    idle: '空闲',
    queued: '等待同步',
    running: '同步中',
    cooldown: '冷却中',
    failed: '同步失败',
    unsupported: '当前插件不支持'
  }
  return values[status]
}
