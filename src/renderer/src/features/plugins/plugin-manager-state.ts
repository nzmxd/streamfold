import type {
  Account,
  PluginContribution,
  PluginPermission
} from '../../../../shared/contracts'

export type PluginManagerSection = 'permissions' | 'config' | 'schedules'
export type PluginDataScope = 'account' | 'profile' | 'content' | 'metrics'

const accountScopedPermissions = new Set<PluginPermission>([
  'accounts.read',
  'profiles.read',
  'contents.read',
  'metrics.read',
  'platform.session-json'
])

const dataScopeDefinitions: Array<{
  id: PluginDataScope
  label: string
  permission: PluginPermission
}> = [
  { id: 'account', label: '账号基本信息', permission: 'accounts.read' },
  { id: 'profile', label: '个人资料', permission: 'profiles.read' },
  { id: 'content', label: '内容数据', permission: 'contents.read' },
  { id: 'metrics', label: '统计指标', permission: 'metrics.read' }
]

export function toggleListValue<T extends string>(values: readonly T[], value: T): T[] {
  return values.includes(value)
    ? values.filter((item) => item !== value)
    : [...values, value]
}

export function requiresAccountScope(permissions: readonly PluginPermission[]): boolean {
  return permissions.some((permission) => accountScopedPermissions.has(permission))
}

export function availableDataScopes(permissions: readonly PluginPermission[]): Array<{
  id: PluginDataScope
  label: string
}> {
  const declared = new Set(permissions)
  return dataScopeDefinitions
    .filter((scope) => declared.has(scope.permission))
    .map(({ id, label }) => ({ id, label }))
}

export function parseNetworkOrigins(value: string): string[] {
  return value
    .split(/[\s,]+/)
    .map((origin) => origin.trim())
    .filter(Boolean)
}

export function accountsForContribution(
  contribution: PluginContribution,
  accounts: readonly Account[]
): Account[] {
  if (contribution.kind !== 'platform.adapter') return [...accounts]
  return accounts.filter((account) => account.platformId === contribution.platform.id)
}
