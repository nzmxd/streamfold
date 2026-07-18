import {
  accountMetricPeriods,
  contentSearchSorts,
  contentTypes,
  standardAnalyticsMetricIds,
  standardContentMetricIds,
  type AccountMetricQuery,
  type AnalyticsQuery,
  type AnalyticsComparisonQuery,
  type AnalyticsSummaryQuery,
  type BulkUpdateContentsInput,
  type BulkUpdateAccountsInput,
  type ConfirmSessionApiIdentityInput,
  type ContentQuery,
  type ContentLifecycleQuery,
  type ContentFilterViewState,
  type ContentSearchQuery,
  type ContentTagFacetQuery,
  type CreateAccountInput,
  type CreateEncryptedBackupInput,
  type CreateGroupInput,
  type ExportDataInput,
  type ExportFilteredContentsInput,
  type MoveGroupInput,
  appLogLevels,
  type AppLogQuery,
  type RendererErrorLogInput,
  pluginPermissions,
  type CreatePluginScheduleInput,
  type SavePluginConfigInput,
  type UpsertPluginGrantInput,
  type RestoreEncryptedBackupInput,
  type SaveContentFilterViewInput,
  type SyncMode,
  type UpdateContentInput,
  type UpdateGroupInput,
  type UpdateSettingsInput,
  type UpdateAccountInput
} from '../shared/contracts'
import {
  syncBatchScopes,
  taskAttentionFilters,
  taskKinds,
  taskSources,
  taskStatuses,
  taskTriggers,
  type EnqueueSyncBatchInput,
  type MarkTaskHandledInput,
  type TaskQuery
} from '../shared/job-contracts'
import { normalizePluginScheduleCadence } from './plugins/schedule-recurrence'

const syncModes = ['profile_only', 'recent_20', 'recent_100', 'disabled'] as const

export function parseCreateAccount(value: unknown): CreateAccountInput {
  const record = asRecord(value)
  const platformId = asPlatformId(record.platformId)
  const syncMode = asEnum(record.syncMode, syncModes, '同步范围') as SyncMode
  const adapterContributionId = record.adapterContributionId === undefined
    ? undefined
    : asPlatformId(record.adapterContributionId)
  const result: CreateAccountInput = { platformId, syncMode, ...(adapterContributionId ? { adapterContributionId } : {}) }
  if (record.alias === undefined) return result
  return { ...result, alias: asText(record.alias, '本地别名', 0, 40) }
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

export function parseEnqueueSyncBatch(value: unknown): EnqueueSyncBatchInput {
  const record = asRecord(value)
  const accountIds = record.accountIds === undefined
    ? undefined
    : asStringArray(record.accountIds, '账号', 200, 80)
  const groupIds = record.groupIds === undefined
    ? undefined
    : asStringArray(record.groupIds, '分组', 200, 80)
  if ((accountIds?.length ?? 0) === 0 && (groupIds?.length ?? 0) === 0) {
    throw new Error('请至少选择一个账号或分组')
  }
  if (record.trigger !== undefined && record.trigger !== 'manual') throw new Error('批量同步触发来源无效')
  return {
    ...(accountIds ? { accountIds } : {}),
    ...(groupIds ? { groupIds } : {}),
    ...(record.requestedScope === undefined ? {} : {
      requestedScope: asEnum(record.requestedScope, syncBatchScopes, '同步范围')
    }),
    trigger: 'manual'
  }
}

export function parseTaskQuery(value: unknown): TaskQuery {
  if (value === undefined || value === null) return {}
  const record = asRecord(value)
  const result: TaskQuery = {}
  if (record.batchId !== undefined) result.batchId = asId(record.batchId)
  if (record.kinds !== undefined) {
    result.kinds = asStringArray(record.kinds, '任务类型', taskKinds.length, 40)
      .map((kind) => asEnum(kind, taskKinds, '任务类型'))
  }
  if (record.statuses !== undefined) {
    result.statuses = asStringArray(record.statuses, '任务状态', taskStatuses.length, 40)
      .map((status) => asEnum(status, taskStatuses, '任务状态'))
  }
  if (record.triggers !== undefined) {
    result.triggers = asStringArray(record.triggers, '触发来源', taskTriggers.length, 40)
      .map((trigger) => asEnum(trigger, taskTriggers, '触发来源'))
  }
  if (record.platformId !== undefined) result.platformId = asPlatformId(record.platformId)
  if (record.accountId !== undefined) result.accountId = asId(record.accountId)
  if (record.pluginId !== undefined) result.pluginId = asId(record.pluginId)
  if (record.contributionId !== undefined) result.contributionId = asText(record.contributionId, '贡献点 ID', 1, 160)
  if (record.createdFrom !== undefined) result.createdFrom = asDate(record.createdFrom, '开始时间')
  if (record.createdTo !== undefined) result.createdTo = asDate(record.createdTo, '结束时间')
  if (record.search !== undefined) result.search = asText(record.search, '搜索词', 0, 200)
  if (record.attention !== undefined) {
    result.attention = asEnum(record.attention, taskAttentionFilters, '任务处理状态')
  }
  if (record.offset !== undefined) result.offset = asInteger(record.offset, '分页位置', 0, 1_000_000)
  if (record.limit !== undefined) result.limit = asInteger(record.limit, '返回数量', 1, 200)
  return result
}

export function parseMarkTaskHandled(value: unknown): MarkTaskHandledInput {
  const record = asRecord(value)
  return {
    source: asEnum(record.source, taskSources, '任务来源'),
    taskId: asId(record.taskId)
  }
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
  if (record.platformId !== undefined) result.platformId = asPlatformId(record.platformId)
  if (record.type !== undefined) result.type = asEnum(record.type, contentTypes, '内容类型')
  if (record.query !== undefined) result.query = asText(record.query, '搜索词', 0, 100)
  if (record.from !== undefined) result.from = asDate(record.from, '开始日期')
  if (record.to !== undefined) result.to = asDate(record.to, '结束日期')
  if (record.limit !== undefined) result.limit = asInteger(record.limit, '返回数量', 1, 500)
  if (record.offset !== undefined) result.offset = asInteger(record.offset, '分页位置', 0, 1_000_000)
  return result
}

export function parseContentSearchQuery(value: unknown): ContentSearchQuery {
  if (value === undefined || value === null) return {}
  const record = asRecord(value)
  const result: ContentSearchQuery = {}
  if (record.keyword !== undefined) result.keyword = asText(record.keyword, '搜索词', 0, 200)
  if (record.accountIds !== undefined) result.accountIds = asStringArray(record.accountIds, '账号', 500, 80)
  if (record.platformId !== undefined) result.platformId = asPlatformId(record.platformId)
  if (record.groupId !== undefined) result.groupId = asId(record.groupId)
  if (record.type !== undefined) result.type = asEnum(record.type, contentTypes, '内容类型')
  if (record.tags !== undefined) result.tags = asStringArray(record.tags, '内容标签', 20, 24)
  if (record.tagMatch !== undefined) result.tagMatch = asEnum(record.tagMatch, ['all', 'any'] as const, '标签匹配方式')
  if (record.bookmarked !== undefined) result.bookmarked = asBoolean(record.bookmarked, '收藏状态')
  if (record.publishedFrom !== undefined) result.publishedFrom = asDate(record.publishedFrom, '发布开始时间')
  if (record.publishedTo !== undefined) result.publishedTo = asDate(record.publishedTo, '发布结束时间')
  if (record.capturedFrom !== undefined) result.capturedFrom = asDate(record.capturedFrom, '采集开始时间')
  if (record.capturedTo !== undefined) result.capturedTo = asDate(record.capturedTo, '采集结束时间')
  if (record.syncWarningOnly !== undefined) {
    result.syncWarningOnly = asBoolean(record.syncWarningOnly, '同步异常筛选')
  }
  if (record.sort !== undefined) result.sort = asEnum(record.sort, contentSearchSorts, '排序字段')
  if (record.order !== undefined) result.order = asEnum(record.order, ['asc', 'desc'] as const, '排序方向')
  if (record.limit !== undefined) result.limit = asInteger(record.limit, '返回数量', 1, 100)
  if (record.offset !== undefined) result.offset = asInteger(record.offset, '分页位置', 0, 1_000_000_000)
  validateRange(result.publishedFrom, result.publishedTo, '发布时间')
  validateRange(result.capturedFrom, result.capturedTo, '采集时间')
  return result
}

export function parseContentFilterViewState(value: unknown): ContentFilterViewState {
  const record = asRecord(value)
  const platformId = asText(record.platformId, '平台', 0, 128)
  const type = asText(record.type, '内容类型', 0, 20)
  const publishedFrom = asFilterViewDate(record.publishedFrom, '发布开始日期')
  const publishedTo = asFilterViewDate(record.publishedTo, '发布结束日期')
  const capturedFrom = asFilterViewDate(record.capturedFrom, '采集开始日期')
  const capturedTo = asFilterViewDate(record.capturedTo, '采集结束日期')
  const pageSize = asInteger(record.pageSize, '每页数量', 1, 100)
  if (![25, 50, 100].includes(pageSize)) throw new Error('每页数量无效')
  validateRange(publishedFrom || undefined, publishedTo || undefined, '发布时间')
  validateRange(capturedFrom || undefined, capturedTo || undefined, '采集时间')
  return {
    keyword: asText(record.keyword, '搜索词', 0, 200),
    accountId: asText(record.accountId, '账号', 0, 80),
    platformId: platformId ? asPlatformId(platformId) : '',
    groupId: asText(record.groupId, '分组', 0, 80),
    type: type ? asEnum(type, contentTypes, '内容类型') : '',
    tags: asStringArray(record.tags, '内容标签', 20, 24),
    tagMatch: asEnum(record.tagMatch, ['all', 'any'] as const, '标签匹配方式'),
    bookmark: asEnum(
      record.bookmark,
      ['all', 'bookmarked', 'unbookmarked'] as const,
      '收藏筛选'
    ),
    syncWarningOnly: asBoolean(record.syncWarningOnly, '同步异常筛选'),
    publishedFrom,
    publishedTo,
    capturedFrom,
    capturedTo,
    sort: asEnum(record.sort, contentSearchSorts, '排序字段'),
    order: asEnum(record.order, ['asc', 'desc'] as const, '排序方向'),
    pageSize
  }
}

export function parseSaveContentFilterView(value: unknown): SaveContentFilterViewInput {
  const record = asRecord(value)
  return {
    ...(record.id === undefined ? {} : { id: asId(record.id) }),
    name: asText(record.name, '筛选视图名称', 1, 40),
    state: parseContentFilterViewState(record.state)
  }
}

export function parseContentTagFacetQuery(value: unknown): ContentTagFacetQuery {
  if (value === undefined || value === null) return {}
  const record = asRecord(value)
  const result: ContentTagFacetQuery = {}
  if (record.search !== undefined) result.search = asText(record.search, '标签搜索词', 0, 24)
  if (record.accountIds !== undefined) result.accountIds = asStringArray(record.accountIds, '账号', 500, 80)
  if (record.platformId !== undefined) result.platformId = asPlatformId(record.platformId)
  if (record.groupId !== undefined) result.groupId = asId(record.groupId)
  if (record.limit !== undefined) result.limit = asInteger(record.limit, '返回数量', 1, 200)
  return result
}

export function parseBulkUpdateContents(value: unknown): BulkUpdateContentsInput {
  const record = asRecord(value)
  const result: BulkUpdateContentsInput = {
    contentIds: asStringArray(record.contentIds, '内容', 500, 80)
  }
  if (result.contentIds.length === 0) throw new Error('请至少选择一条内容')
  if (record.isBookmarked !== undefined) result.isBookmarked = asBoolean(record.isBookmarked, '收藏状态')
  if (record.tagChange !== undefined) {
    const tagChange = asRecord(record.tagChange)
    const tags = asStringArray(tagChange.tags, '内容标签', 20, 24)
    if (tags.length === 0) throw new Error('请至少提供一个标签')
    result.tagChange = {
      action: asEnum(tagChange.action, ['add', 'remove'] as const, '标签操作'),
      tags
    }
  }
  if (result.isBookmarked === undefined && result.tagChange === undefined) throw new Error('没有需要执行的批量操作')
  return result
}

export function parseExportFilteredContents(value: unknown): ExportFilteredContentsInput {
  const record = asRecord(value)
  return {
    query: parseContentSearchQuery(record.query),
    format: asEnum(record.format, ['json', 'csv'] as const, '导出格式'),
    ...(record.includeSnapshots === undefined ? {} : {
      includeSnapshots: asBoolean(record.includeSnapshots, '快照导出选项')
    })
  }
}

export function parseUpdateContent(value: unknown): UpdateContentInput {
  const record = asRecord(value)
  const result: UpdateContentInput = { id: asId(record.id) }
  if (record.note !== undefined) result.note = asText(record.note, '内容备注', 0, 1000)
  if (record.tags !== undefined) result.tags = asStringArray(record.tags, '内容标签', 20, 24)
  if (record.isBookmarked !== undefined) result.isBookmarked = asBoolean(record.isBookmarked, '收藏状态')
  return result
}

export function parseAnalyticsQuery(value: unknown): AnalyticsQuery {
  if (value === undefined || value === null) return {}
  const record = asRecord(value)
  const result: AnalyticsQuery = {}
  if (record.accountId !== undefined) result.accountId = asId(record.accountId)
  if (record.platformId !== undefined) result.platformId = asPlatformId(record.platformId)
  if (record.days !== undefined) {
    const days = asInteger(record.days, '统计周期', 7, 365)
    if (![7, 30, 90, 365].includes(days)) throw new Error('统计周期无效')
    result.days = days as 7 | 30 | 90 | 365
  }
  return result
}

export function parseAnalyticsSummaryQuery(value: unknown): AnalyticsSummaryQuery {
  return parseAnalyticsScope(value)
}

export function parseAnalyticsComparisonQuery(value: unknown): AnalyticsComparisonQuery {
  const record = asRecord(value)
  return {
    ...parseAnalyticsScope(record),
    dimension: asEnum(record.dimension, ['account', 'platform', 'group', 'week'] as const, '对比维度')
  }
}

export function parseContentLifecycleQuery(value: unknown): ContentLifecycleQuery {
  const record = value === undefined || value === null ? {} : asRecord(value)
  const result: ContentLifecycleQuery = parseAnalyticsScope(record)
  if (record.standardMetricId !== undefined) {
    result.standardMetricId = asEnum(record.standardMetricId, standardContentMetricIds, '标准指标')
  }
  if (record.limit !== undefined) result.limit = asInteger(record.limit, '返回数量', 1, 100)
  if (record.offset !== undefined) result.offset = asInteger(record.offset, '分页位置', 0, 1_000_000_000)
  return result
}

function parseAnalyticsScope(value: unknown): AnalyticsSummaryQuery {
  if (value === undefined || value === null) return {}
  const record = asRecord(value)
  const result: AnalyticsSummaryQuery = {}
  if (record.accountIds !== undefined) result.accountIds = asStringArray(record.accountIds, '账号', 500, 80)
  if (record.platformId !== undefined) result.platformId = asPlatformId(record.platformId)
  if (record.groupId !== undefined) result.groupId = asId(record.groupId)
  if (record.publishedFrom !== undefined) result.publishedFrom = asDate(record.publishedFrom, '发布开始时间')
  if (record.publishedTo !== undefined) result.publishedTo = asDate(record.publishedTo, '发布结束时间')
  if (record.capturedFrom !== undefined) result.capturedFrom = asDate(record.capturedFrom, '采集开始时间')
  if (record.capturedTo !== undefined) result.capturedTo = asDate(record.capturedTo, '采集结束时间')
  if (record.standardMetricIds !== undefined) {
    result.standardMetricIds = asStringArray(record.standardMetricIds, '标准指标', standardAnalyticsMetricIds.length, 20)
      .map((metricId) => asEnum(metricId, standardAnalyticsMetricIds, '标准指标'))
  }
  validateRange(result.publishedFrom, result.publishedTo, '发布时间')
  validateRange(result.capturedFrom, result.capturedTo, '采集时间')
  return result
}

export function parseAccountMetricQuery(value: unknown): AccountMetricQuery {
  const record = asRecord(value)
  const result: AccountMetricQuery = { accountId: asId(record.accountId) }
  if (record.period !== undefined) {
    result.period = asEnum(record.period, accountMetricPeriods, '账号指标周期')
  }
  if (record.from !== undefined) result.from = asCalendarDate(record.from, '开始日期')
  if (record.to !== undefined) result.to = asCalendarDate(record.to, '结束日期')
  if (result.from && result.to && result.from > result.to) throw new Error('账号指标日期范围无效')
  if (record.limit !== undefined) result.limit = asInteger(record.limit, '返回数量', 1, 500)
  if (record.offset !== undefined) result.offset = asInteger(record.offset, '分页位置', 0, 1_000_000)
  return result
}

export function parseUpdateSettings(value: unknown): UpdateSettingsInput {
  const record = asRecord(value)
  const result: UpdateSettingsInput = {}
  if (record.rawRetentionDays !== undefined) {
    result.rawRetentionDays = asInteger(record.rawRetentionDays, '原始响应保留天数', 0, 365)
  }
  if (record.autoCheckUpdates !== undefined) {
    result.autoCheckUpdates = asBoolean(record.autoCheckUpdates, '自动检查更新')
  }
  return result
}

export function parseAppLogQuery(value: unknown): AppLogQuery {
  const record = value === undefined || value === null ? {} : asRecord(value)
  const result: AppLogQuery = {}
  if (record.level !== undefined && record.level !== '') {
    result.level = asEnum(record.level, appLogLevels, '日志级别')
  }
  if (record.scope !== undefined && record.scope !== '') {
    result.scope = asText(record.scope, '日志模块', 1, 80)
  }
  if (record.search !== undefined && record.search !== '') {
    result.search = asText(record.search, '日志搜索词', 1, 200)
  }
  if (record.limit !== undefined) result.limit = asInteger(record.limit, '日志数量', 1, 2_000)
  return result
}

export function parseRendererErrorLog(value: unknown): RendererErrorLogInput {
  const record = asRecord(value)
  const result: RendererErrorLogInput = {
    message: asText(record.message, '渲染错误消息', 1, 1_000),
    source: asEnum(
      record.source,
      ['vue', 'window', 'unhandled-rejection'] as const,
      '渲染错误来源'
    )
  }
  if (record.code !== undefined) result.code = asText(record.code, '渲染错误代码', 1, 160)
  if (record.stack !== undefined) result.stack = asText(record.stack, '渲染错误调用栈', 0, 12_000)
  if (record.details !== undefined) result.details = asText(record.details, '渲染错误详情', 0, 4_000)
  if (record.file !== undefined) result.file = asText(record.file, '渲染错误文件', 0, 2_048)
  if (record.line !== undefined) result.line = asInteger(record.line, '渲染错误行号', 0, 10_000_000)
  if (record.column !== undefined) result.column = asInteger(record.column, '渲染错误列号', 0, 10_000_000)
  if (record.componentInfo !== undefined) {
    result.componentInfo = asText(record.componentInfo, '渲染组件信息', 0, 500)
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

export function parsePluginGrant(value: unknown): UpsertPluginGrantInput {
  const record = asRecord(value)
  return {
    pluginId: asId(record.pluginId),
    contributionId: asText(record.contributionId, '贡献点 ID', 1, 160),
    permissions: asStringArray(record.permissions, '插件权限', 32, 80)
      .map((permission) => asEnum(permission, pluginPermissions, '插件权限')),
    accountIds: asStringArray(record.accountIds, '账号', 500, 160),
    groupIds: asStringArray(record.groupIds, '分组', 500, 160),
    dataScopes: asStringArray(record.dataScopes, '数据范围', 4, 20)
      .map((scope) => asEnum(scope, ['account', 'profile', 'content', 'metrics'] as const, '数据范围')),
    networkOrigins: asStringArray(record.networkOrigins, '网络目标', 32, 2_048)
  }
}

export function parsePluginConfig(value: unknown): SavePluginConfigInput {
  const record = asRecord(value)
  const values = asJsonObject(record.values, '插件配置')
  const secretsRecord = record.secrets === undefined ? undefined : asRecord(record.secrets)
  const secrets = secretsRecord === undefined ? undefined : Object.fromEntries(
    Object.entries(secretsRecord).map(([key, secret]) => [
      asText(key, '密钥字段', 1, 128),
      asText(secret, '插件密钥', 1, 4_096)
    ])
  )
  return {
    pluginId: asId(record.pluginId),
    contributionId: asText(record.contributionId, '贡献点 ID', 1, 160),
    values,
    ...(secrets ? { secrets } : {}),
    ...(record.clearSecrets === undefined ? {} : {
      clearSecrets: asStringArray(record.clearSecrets, '清除密钥字段', 64, 128)
    })
  }
}

export function parseCreatePluginSchedule(value: unknown): CreatePluginScheduleInput {
  const record = asRecord(value)
  return {
    pluginId: asId(record.pluginId),
    contributionId: asText(record.contributionId, '贡献点 ID', 1, 160),
    accountIds: asStringArray(record.accountIds, '账号', 500, 160),
    groupIds: asStringArray(record.groupIds, '分组', 500, 160),
    cadence: normalizePluginScheduleCadence(record.cadence, record.intervalMinutes),
    enabled: asBoolean(record.enabled, '计划开关')
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('请求参数无效')
  return value as Record<string, unknown>
}

function asJsonObject(value: unknown, label: string): Record<string, unknown> {
  const record = asRecord(value)
  let serialized = ''
  try {
    serialized = JSON.stringify(record)
  } catch {
    throw new Error(`${label}无效`)
  }
  if (Buffer.byteLength(serialized, 'utf8') > 16 * 1024) throw new Error(`${label}过大`)
  const parsed = JSON.parse(serialized) as unknown
  return asRecord(parsed)
}

function asId(value: unknown): string {
  return asText(value, 'ID', 1, 80)
}

function asPlatformId(value: unknown): string {
  const id = asText(value, '平台', 1, 128)
  if (!/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/.test(id)) throw new Error('平台无效')
  return id
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

function asCalendarDate(value: unknown, label: string): string {
  const text = asText(value, label, 10, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error(`${label}无效`)
  const date = new Date(`${text}T00:00:00.000Z`)
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text) {
    throw new Error(`${label}无效`)
  }
  return text
}

function asFilterViewDate(value: unknown, label: string): string {
  const text = asText(value, label, 0, 10)
  return text ? asCalendarDate(text, label) : ''
}

function validateRange(from: string | undefined, to: string | undefined, label: string): void {
  if (from && to && from > to) throw new Error(`${label}范围无效`)
}

function asStringArray(value: unknown, label: string, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(`${label}无效`)
  return [...new Set(value.map((item) => asText(item, label, 1, maxLength)))]
}

function asEnum<T extends string>(value: unknown, values: readonly T[], label: string): T {
  if (typeof value !== 'string' || !values.includes(value as T)) throw new Error(`${label}无效`)
  return value as T
}
