import type {
  InstalledPluginPackage,
  PluginContribution,
  PluginContributionKind,
  PluginPackageSource,
  PluginPackageStatus,
  PluginPermission,
  PluginRunStatus,
  PluginScheduleCadence,
  PluginTriggerKind
} from '../../../../shared/contracts'

export const scheduleWeekdayOptions = [
  { value: 1, label: '周一' },
  { value: 2, label: '周二' },
  { value: 3, label: '周三' },
  { value: 4, label: '周四' },
  { value: 5, label: '周五' },
  { value: 6, label: '周六' },
  { value: 7, label: '周日' }
] as const

const contributionLabels: Record<PluginContributionKind, string> = {
  'platform.adapter': '平台适配器',
  action: '手动动作',
  'event.handler': '事件处理器',
  'scheduled.task': '定时任务'
}

const permissionLabels: Record<PluginPermission, string> = {
  'accounts.read': '读取账号列表',
  'profiles.read': '读取账号资料',
  'contents.read': '读取内容',
  'metrics.read': '读取统计指标',
  'platform.session-json': '调用绑定账号的平台 JSON 接口',
  'events.subscribe': '订阅业务事件',
  'scheduler.run': '按计划运行',
  'network.https': '访问已授权的公网 HTTPS 地址'
}

const packageStatusLabels: Record<PluginPackageStatus, string> = {
  active: '可用',
  disabled: '已停用',
  revoked: '已撤销',
  incompatible: '版本不兼容',
  failed: '加载失败'
}

const packageSourceLabels: Record<PluginPackageSource, string> = {
  builtin: '归页内置',
  catalog: '签名目录',
  local_development: '本地开发'
}

const runStatusLabels: Record<PluginRunStatus, string> = {
  queued: '等待运行',
  running: '运行中',
  succeeded: '成功',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '已中断'
}

const triggerLabels: Record<PluginTriggerKind, string> = {
  manual: '手动',
  event: '事件',
  schedule: '计划'
}

export function contributionKindLabel(kind: PluginContributionKind): string {
  return contributionLabels[kind]
}

export function permissionLabel(permission: PluginPermission): string {
  return permissionLabels[permission]
}

export function packageStatusLabel(status: PluginPackageStatus): string {
  return packageStatusLabels[status]
}

export function packageSourceLabel(source: PluginPackageSource): string {
  return packageSourceLabels[source]
}

export function runStatusLabel(status: PluginRunStatus): string {
  return runStatusLabels[status]
}

export function triggerLabel(trigger: PluginTriggerKind): string {
  return triggerLabels[trigger]
}

export function minimumScheduleMinutes(contribution: PluginContribution): number {
  if (contribution.kind === 'platform.adapter') return 60
  if (contribution.kind === 'scheduled.task') return contribution.minimumIntervalMinutes
  return 5
}

export function defaultScheduleMinutes(contribution: PluginContribution): number {
  if (contribution.kind === 'platform.adapter') {
    return Math.max(minimumScheduleMinutes(contribution), contribution.recommendedSyncIntervalHours * 60)
  }
  if (contribution.kind === 'scheduled.task') {
    return Math.max(minimumScheduleMinutes(contribution), contribution.defaultIntervalMinutes ?? 24 * 60)
  }
  return Math.max(minimumScheduleMinutes(contribution), 24 * 60)
}

export function scheduleCadenceLabel(cadence: PluginScheduleCadence): string {
  if (cadence.type === 'daily') return `每天 ${cadence.time}`
  if (cadence.type === 'weekly') {
    if (cadence.weekdays.length === 7) return `每天 ${cadence.time}`
    const selected = new Set(cadence.weekdays)
    const days = scheduleWeekdayOptions
      .filter((option) => selected.has(option.value))
      .map((option) => option.label.slice(1))
      .join('、')
    return `每周${days} ${cadence.time}`
  }
  if (cadence.type === 'monthly') {
    if (cadence.monthDays.length === 31) return `每天 ${cadence.time}`
    const days = cadence.monthDays.length > 6
      ? `${cadence.monthDays.slice(0, 3).join('、')} 等 ${cadence.monthDays.length} 天`
      : `${cadence.monthDays.join('、')} 日`
    return `每月 ${days} ${cadence.time}`
  }
  const minutes = cadence.intervalMinutes
  if (minutes % (7 * 24 * 60) === 0) return `每 ${minutes / (7 * 24 * 60)} 周`
  if (minutes % (24 * 60) === 0) return `每 ${minutes / (24 * 60)} 天`
  if (minutes % 60 === 0) return `每 ${minutes / 60} 小时`
  return `每 ${minutes} 分钟`
}

export function packageCanBeEnabled(plugin: InstalledPluginPackage): boolean {
  return plugin.status === 'active'
}

export function packageStatusTone(status: PluginPackageStatus): 'success' | 'neutral' | 'warning' | 'danger' {
  if (status === 'active') return 'success'
  if (status === 'disabled') return 'neutral'
  if (status === 'incompatible') return 'warning'
  return 'danger'
}

export function runStatusTone(status: PluginRunStatus): 'success' | 'neutral' | 'warning' | 'danger' | 'brand' {
  if (status === 'succeeded') return 'success'
  if (status === 'failed' || status === 'interrupted') return 'danger'
  if (status === 'running') return 'brand'
  if (status === 'queued') return 'warning'
  return 'neutral'
}
