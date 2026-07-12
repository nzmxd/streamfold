import {
  accountStatuses,
  platformIds,
  type CreateAccountInput,
  type CreateGroupInput,
  type SyncMode,
  type UpdateAccountInput
} from '../shared/contracts'

const syncModes = ['profile_only', 'recent_20', 'recent_100', 'disabled'] as const

export function parseCreateAccount(value: unknown): CreateAccountInput {
  const record = asRecord(value)
  const platformId = asEnum(record.platformId, platformIds, '平台')
  const alias = asText(record.alias, '本地别名', 1, 40)
  const syncMode = asEnum(record.syncMode, syncModes, '同步范围') as SyncMode
  return { platformId, alias, syncMode }
}

export function parseUpdateAccount(value: unknown): UpdateAccountInput {
  const record = asRecord(value)
  const result: UpdateAccountInput = { id: asId(record.id) }

  if (record.alias !== undefined) result.alias = asText(record.alias, '本地别名', 1, 40)
  if (record.note !== undefined) result.note = asText(record.note, '备注', 0, 1000)
  if (record.tags !== undefined) result.tags = asStringArray(record.tags, '标签', 20, 24)
  if (record.groupIds !== undefined) result.groupIds = asStringArray(record.groupIds, '分组', 50, 64)
  if (record.status !== undefined) result.status = asEnum(record.status, accountStatuses, '状态')
  if (record.syncMode !== undefined) {
    result.syncMode = asEnum(record.syncMode, syncModes, '同步范围') as SyncMode
  }
  if (record.isDefault !== undefined) {
    if (typeof record.isDefault !== 'boolean') throw new Error('默认账号字段无效')
    result.isDefault = record.isDefault
  }
  return result
}

export function parseCreateGroup(value: unknown): CreateGroupInput {
  const record = asRecord(value)
  const color = asText(record.color, '分组颜色', 4, 20)
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) throw new Error('分组颜色格式无效')
  return { name: asText(record.name, '分组名称', 1, 30), color }
}

export function parseId(value: unknown): string {
  return asId(value)
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('请求参数无效')
  return value as Record<string, unknown>
}

function asId(value: unknown): string {
  return asText(value, 'ID', 1, 80)
}

function asText(value: unknown, label: string, min: number, max: number): string {
  if (typeof value !== 'string') throw new Error(`${label}无效`)
  const text = value.trim()
  if (text.length < min || text.length > max) throw new Error(`${label}长度应为 ${min}-${max} 个字符`)
  return text
}

function asStringArray(value: unknown, label: string, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(`${label}无效`)
  return [...new Set(value.map((item) => asText(item, label, 1, maxLength)))]
}

function asEnum<T extends string>(value: unknown, values: readonly T[], label: string): T {
  if (typeof value !== 'string' || !values.includes(value as T)) throw new Error(`${label}无效`)
  return value as T
}
