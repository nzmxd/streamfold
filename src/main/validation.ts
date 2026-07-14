import {
  contentTypes,
  platformIds,
  type AnalyticsQuery,
  type BulkUpdateAccountsInput,
  type ConfirmSessionApiIdentityInput,
  type ContentQuery,
  type CreateAccountInput,
  type CreateEncryptedBackupInput,
  type CreateGroupInput,
  type ExportDataInput,
  type MoveGroupInput,
  type RestoreEncryptedBackupInput,
  type SyncMode,
  type UpdateContentInput,
  type UpdateGroupInput,
  type UpdateSettingsInput,
  type UpdateAccountInput
} from '../shared/contracts'

const syncModes = ['profile_only', 'recent_20', 'recent_100', 'disabled'] as const

export function parseCreateAccount(value: unknown): CreateAccountInput {
  const record = asRecord(value)
  const platformId = asEnum(record.platformId, platformIds, '平台')
  const syncMode = asEnum(record.syncMode, syncModes, '同步范围') as SyncMode
  if (record.alias === undefined) return { platformId, syncMode }
  return { platformId, alias: asText(record.alias, '本地别名', 0, 40), syncMode }
}

export function parseUpdateAccount(value: unknown): UpdateAccountInput {
  const record = asRecord(value)
  const result: UpdateAccountInput = { id: asId(record.id) }

  if (record.alias !== undefined) result.alias = asText(record.alias, '本地别名', 0, 40)
  if (record.note !== undefined) result.note = asText(record.note, '备注', 0, 1000)
  if (record.tags !== undefined) result.tags = asStringArray(record.tags, '标签', 20, 24)
  if (record.groupIds !== undefined) result.groupIds = asStringArray(record.groupIds, '分组', 50, 64)
  if (record.syncEnabled !== undefined) result.syncEnabled = asBoolean(record.syncEnabled, '同步开关')
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

export function parseUpdateGroup(value: unknown): UpdateGroupInput {
  const record = asRecord(value)
  const result: UpdateGroupInput = { id: asId(record.id) }
  if (record.name !== undefined) result.name = asText(record.name, '分组名称', 1, 30)
  if (record.color !== undefined) {
    const color = asText(record.color, '分组颜色', 4, 20)
    if (!/^#[0-9a-fA-F]{6}$/.test(color)) throw new Error('分组颜色格式无效')
    result.color = color
  }
  if (result.name === undefined && result.color === undefined) throw new Error('没有需要更新的分组字段')
  return result
}

export function parseMoveGroup(value: unknown): MoveGroupInput {
  const record = asRecord(value)
  return {
    id: asId(record.id),
    direction: asEnum(record.direction, ['up', 'down'] as const, '移动方向')
  }
}

export function parseBulkUpdateAccounts(value: unknown): BulkUpdateAccountsInput {
  const record = asRecord(value)
  const result: BulkUpdateAccountsInput = {
    accountIds: asStringArray(record.accountIds, '账号', 500, 80)
  }
  if (result.accountIds.length === 0) throw new Error('请至少选择一个账号')
  if (record.groupChange !== undefined) {
    const groupChange = asRecord(record.groupChange)
    result.groupChange = {
      groupId: asId(groupChange.groupId),
      action: asEnum(groupChange.action, ['add', 'remove'] as const, '分组操作')
    }
  }
  if (record.syncEnabled !== undefined) {
    result.syncEnabled = asBoolean(record.syncEnabled, '同步开关')
  }
  if (result.groupChange === undefined && result.syncEnabled === undefined) {
    throw new Error('没有需要执行的批量操作')
  }
  return result
}

export function parseId(value: unknown): string {
  return asId(value)
}

export function parseBoolean(value: unknown, label = '布尔字段'): boolean {
  return asBoolean(value, label)
}

export function parseContentQuery(value: unknown): ContentQuery {
  if (value === undefined || value === null) return {}
  const record = asRecord(value)
  const result: ContentQuery = {}
  if (record.accountId !== undefined) result.accountId = asId(record.accountId)
  if (record.platformId !== undefined) result.platformId = asEnum(record.platformId, platformIds, '平台')
  if (record.type !== undefined) result.type = asEnum(record.type, contentTypes, '内容类型')
  if (record.query !== undefined) result.query = asText(record.query, '搜索词', 0, 100)
  if (record.from !== undefined) result.from = asDate(record.from, '开始日期')
  if (record.to !== undefined) result.to = asDate(record.to, '结束日期')
  if (record.limit !== undefined) result.limit = asInteger(record.limit, '返回数量', 1, 500)
  if (record.offset !== undefined) result.offset = asInteger(record.offset, '分页位置', 0, 1_000_000)
  return result
}

export function parseUpdateContent(value: unknown): UpdateContentInput {
  const record = asRecord(value)
  const result: UpdateContentInput = { id: asId(record.id) }
  if (record.note !== undefined) result.note = asText(record.note, '内容备注', 0, 1000)
  if (record.tags !== undefined) result.tags = asStringArray(record.tags, '内容标签', 20, 24)
  return result
}

export function parseAnalyticsQuery(value: unknown): AnalyticsQuery {
  if (value === undefined || value === null) return {}
  const record = asRecord(value)
  const result: AnalyticsQuery = {}
  if (record.accountId !== undefined) result.accountId = asId(record.accountId)
  if (record.platformId !== undefined) result.platformId = asEnum(record.platformId, platformIds, '平台')
  if (record.days !== undefined) {
    const days = asInteger(record.days, '统计周期', 7, 365)
    if (![7, 30, 90, 365].includes(days)) throw new Error('统计周期无效')
    result.days = days as 7 | 30 | 90 | 365
  }
  return result
}

export function parseUpdateSettings(value: unknown): UpdateSettingsInput {
  const record = asRecord(value)
  const result: UpdateSettingsInput = {}
  if (record.rawRetentionDays !== undefined) {
    result.rawRetentionDays = asInteger(record.rawRetentionDays, '原始响应保留天数', 0, 365)
  }
  return result
}

export function parseExportData(value: unknown): ExportDataInput {
  const record = asRecord(value)
  const format = asEnum(record.format, ['json', 'csv'] as const, '导出格式')
  const result: ExportDataInput = { format }
  if (record.accountId !== undefined) result.accountId = asId(record.accountId)
  return result
}

export function parseCreateEncryptedBackup(value: unknown): CreateEncryptedBackupInput {
  const record = asRecord(value)
  return { password: asPassword(record.password) }
}

export function parseConfirmApiIdentity(value: unknown): ConfirmSessionApiIdentityInput {
  const record = asRecord(value)
  return {
    accountId: asId(record.accountId),
    token: asText(record.token, '身份确认令牌', 1, 80),
    confirmIdentity: asBoolean(record.confirmIdentity, '本人身份确认')
  }
}

export function parseRestoreEncryptedBackup(value: unknown): RestoreEncryptedBackupInput {
  const record = asRecord(value)
  return {
    password: asPassword(record.password),
    confirmReplace: asBoolean(record.confirmReplace, '恢复确认')
  }
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

function asBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label}无效`)
  return value
}

function asPassword(value: unknown): string {
  if (typeof value !== 'string' || value.includes('\u0000')) throw new Error('备份密码无效')
  const characters = [...value].length
  const bytes = Buffer.byteLength(value, 'utf8')
  if (characters < 12 || characters > 256 || bytes > 1024) throw new Error('备份密码应为 12-256 个字符')
  return value
}

function asInteger(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${label}无效`)
  }
  return value
}

function asDate(value: unknown, label: string): string {
  const text = asText(value, label, 1, 40)
  const date = new Date(text)
  if (Number.isNaN(date.getTime())) throw new Error(`${label}无效`)
  return date.toISOString()
}

function asStringArray(value: unknown, label: string, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(`${label}无效`)
  return [...new Set(value.map((item) => asText(item, label, 1, maxLength)))]
}

function asEnum<T extends string>(value: unknown, values: readonly T[], label: string): T {
  if (typeof value !== 'string' || !values.includes(value as T)) throw new Error(`${label}无效`)
  return value as T
}
