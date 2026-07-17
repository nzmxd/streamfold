export const pluginContributionKinds = [
  'platform.adapter',
  'action',
  'event.handler',
  'scheduled.task'
] as const

export type PluginContributionKind = (typeof pluginContributionKinds)[number]

export const pluginPermissions = [
  'accounts.read',
  'profiles.read',
  'contents.read',
  'metrics.read',
  'platform.session-json',
  'events.subscribe',
  'scheduler.run',
  'network.https'
] as const

export type PluginPermission = (typeof pluginPermissions)[number]
export type PluginRuntimeKind = 'builtin' | 'quickjs'
export type PluginPackageSource = 'builtin' | 'catalog' | 'local_development'
export type PluginPackageStatus = 'active' | 'disabled' | 'revoked' | 'incompatible' | 'failed'
export type PluginTriggerKind = 'manual' | 'event' | 'schedule'
export type PluginEventType = 'sync.completed.v1' | 'account.updated.v1' | 'content.updated.v1'

export interface PluginPublisher {
  id: string
  name: string
  keyId: string
}

export interface PluginConfigSchema {
  type: 'object'
  properties: Record<string, PluginConfigProperty>
  required?: string[]
  additionalProperties?: false
}

export type PluginConfigProperty =
  | {
      type: 'string'
      title: string
      description?: string
      default?: string
      enum?: string[]
      format?: 'url' | 'secret' | 'text' | 'multiline'
      minLength?: number
      maxLength?: number
    }
  | {
      type: 'boolean'
      title: string
      description?: string
      default?: boolean
    }
  | {
      type: 'integer' | 'number'
      title: string
      description?: string
      default?: number
      minimum?: number
      maximum?: number
    }
  | {
      type: 'array'
      title: string
      description?: string
      items: { type: 'string'; enum?: string[] }
      default?: string[]
      maxItems?: number
    }

export interface PluginContributionBase {
  id: string
  kind: PluginContributionKind
  name: string
  description: string
  entry: string
  runtime: PluginRuntimeKind
  permissions: PluginPermission[]
  configSchema?: PluginConfigSchema
}

export interface PlatformEndpointDeclaration {
  id: string
  origin: string
  pathTemplate: string
  queryParameters?: string[]
  maximumResponseBytes?: number
}

export interface PlatformCaptureDeclaration {
  id: string
  route: string
  responseOrigin: string
  responsePath: string
  graphqlOperationName?: string
  resourceTypes: Array<'Fetch' | 'XHR'>
  method: 'GET'
  pagination?: 'none' | 'page-down'
  maximumResponses?: number
  maximumResponseBytes?: number
  maximumTotalBytes?: number
}

/** Trusted host policy for a declared response capture. */
export type PlatformCapturePolicy = 'fresh' | 'background-cache'

export interface PlatformContentUrlDeclaration {
  remoteIdTemplate: string
  origin: string
  pathTemplate: string
  queryParameters?: string[]
}

export interface PlatformAdapterContribution extends PluginContributionBase {
  kind: 'platform.adapter'
  platform: {
    id: string
    name: string
    shortName: string
    loginUrl: string
    homeUrl: string
    navigationHosts: string[]
    imageHosts: string[]
    contentUrls: PlatformContentUrlDeclaration[]
    riskNote: string
  }
  endpoints: PlatformEndpointDeclaration[]
  captures: PlatformCaptureDeclaration[]
  minimumIntervalSeconds: number
  recommendedSyncIntervalHours: number
}

export interface ActionContribution extends PluginContributionBase {
  kind: 'action'
  placements: Array<'plugin-center' | 'account' | 'content'>
}

export interface EventHandlerContribution extends PluginContributionBase {
  kind: 'event.handler'
  events: PluginEventType[]
}

export interface ScheduledTaskContribution extends PluginContributionBase {
  kind: 'scheduled.task'
  minimumIntervalMinutes: number
  defaultIntervalMinutes?: number
}

export type PluginContribution =
  | PlatformAdapterContribution
  | ActionContribution
  | EventHandlerContribution
  | ScheduledTaskContribution

export interface PluginManifestV2 {
  schemaVersion: 2
  id: string
  name: string
  version: string
  description: string
  license: string
  publisher: PluginPublisher
  minimumAppVersion: string
  maximumAppVersion?: string
  sdkVersion: string
  contributions: PluginContribution[]
}

export interface PluginGrant {
  pluginId: string
  contributionId: string
  permissions: PluginPermission[]
  accountIds: string[]
  groupIds: string[]
  dataScopes: Array<'account' | 'profile' | 'content' | 'metrics'>
  networkOrigins: string[]
  grantedAt: string
  updatedAt: string
}

export interface InstalledPluginPackage {
  manifest: PluginManifestV2
  source: PluginPackageSource
  status: PluginPackageStatus
  enabled: boolean
  packageHash: string
  publisherKeyId: string
  installedAt: string
  updatedAt: string
  lastError: string
  updateAvailable: string | null
  development: boolean
}

export interface PluginContributionState {
  pluginId: string
  pluginName: string
  pluginVersion: string
  contribution: PluginContribution
  enabled: boolean
  granted: boolean
  suspendedReason: string
}

export interface PluginConfigView {
  pluginId: string
  contributionId: string
  values: Record<string, unknown>
  configuredSecrets: string[]
  updatedAt: string | null
}

export interface SavePluginConfigInput {
  pluginId: string
  contributionId: string
  values: Record<string, unknown>
  secrets?: Record<string, string>
  clearSecrets?: string[]
}

export interface UpsertPluginGrantInput {
  pluginId: string
  contributionId: string
  permissions: PluginPermission[]
  accountIds: string[]
  groupIds: string[]
  dataScopes: PluginGrant['dataScopes']
  networkOrigins: string[]
}

export type PluginScheduleCadence =
  | { type: 'interval'; intervalMinutes: number }
  | { type: 'daily'; time: string }
  | { type: 'weekly'; weekdays: number[]; time: string }
  | { type: 'monthly'; monthDays: number[]; time: string }

export interface PluginSchedule {
  id: string
  pluginId: string
  contributionId: string
  accountIds: string[]
  groupIds: string[]
  cadence: PluginScheduleCadence
  /** Retained for older renderers and databases. New code should use cadence. */
  intervalMinutes: number
  enabled: boolean
  nextRunAt: string | null
  lastRunAt: string | null
  consecutiveFailures: number
  suspendedReason: string
  createdAt: string
  updatedAt: string
}

export interface CreatePluginScheduleInput {
  pluginId: string
  contributionId: string
  accountIds: string[]
  groupIds: string[]
  cadence?: PluginScheduleCadence
  /** Legacy interval-only input accepted during upgrades. */
  intervalMinutes?: number
  enabled: boolean
}

export type PluginRunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted'

export interface PluginRunRecord {
  id: string
  pluginId: string
  contributionId: string
  trigger: PluginTriggerKind
  status: PluginRunStatus
  accountId: string | null
  eventId: string | null
  attempt: number
  startedAt: string | null
  finishedAt: string | null
  nextAttemptAt: string | null
  errorCode: string
  errorMessage: string
  createdAt: string
}

export interface PluginEventEnvelope<T = unknown> {
  id: string
  type: PluginEventType
  schemaVersion: 1
  occurredAt: string
  source: { app: 'streamfold'; pluginId: string | null }
  subject: { accountId: string | null; contentId: string | null }
  data: T
}

export type PluginDeliveryStatus = 'pending' | 'running' | 'succeeded' | 'retry' | 'failed' | 'cancelled'

export interface PluginEventDelivery {
  id: string
  event: PluginEventEnvelope
  pluginId: string
  contributionId: string
  status: PluginDeliveryStatus
  attempt: number
  nextAttemptAt: string | null
  errorCode: string
  errorMessage: string
  createdAt: string
  updatedAt: string
}

export interface PluginCatalogEntry {
  pluginId: string
  version: string
  downloadUrl: string
  packageHash: string
  publisherKeyId: string
  publisherPublicKey: string
  minimumAppVersion: string
  maximumAppVersion?: string
  revoked: boolean
  revokedReason?: string
}

export interface PluginCatalogDocument {
  schemaVersion: 1
  generatedAt: string
  expiresAt: string
  entries: PluginCatalogEntry[]
  signature: string
}

export interface PluginCatalogState {
  configured: boolean
  refreshedAt: string | null
  expiresAt: string | null
  entries: PluginCatalogEntry[]
  error: string
}

export interface PluginDeveloperState {
  enabled: boolean
}

export interface AccountAdapterOption {
  pluginId: string
  contributionId: string
  name: string
  description: string
  platformId: string
  selected: boolean
  enabled: boolean
  available: boolean
}

const ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{1,126}[a-z0-9])?$/
const CONFIG_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/
const VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/
const ENTRY_PATTERN = /^(?:entries\/)?[a-zA-Z0-9][a-zA-Z0-9._/-]{0,199}\.js$/

export function validatePluginManifestV2(value: unknown): PluginManifestV2 {
  const manifest = objectValue(value, '插件清单')
  exactKeys(manifest, [
    'schemaVersion', 'id', 'name', 'version', 'description', 'license', 'publisher',
    'minimumAppVersion', 'maximumAppVersion', 'sdkVersion', 'contributions'
  ], '插件清单')
  if (manifest.schemaVersion !== 2) throw new Error('插件清单版本不受支持')
  const id = identifier(manifest.id, '插件 ID')
  const version = semver(manifest.version, '插件版本')
  const publisherValue = objectValue(manifest.publisher, '插件发布者')
  exactKeys(publisherValue, ['id', 'name', 'keyId'], '插件发布者')
  const contributionsValue = arrayValue(manifest.contributions, '插件贡献点')
  if (contributionsValue.length === 0 || contributionsValue.length > 32) {
    throw new Error('插件贡献点数量必须在 1 到 32 之间')
  }
  const seen = new Set<string>()
  const contributions = contributionsValue.map((item) => {
    const contribution = validateContribution(item)
    if (seen.has(contribution.id)) throw new Error('插件贡献点 ID 重复')
    seen.add(contribution.id)
    return contribution
  })
  const minimumAppVersion = semver(manifest.minimumAppVersion, '最低应用版本')
  const maximumAppVersion = manifest.maximumAppVersion === undefined
    ? undefined
    : semver(manifest.maximumAppVersion, '最高应用版本')
  if (maximumAppVersion && compareSemver(maximumAppVersion, minimumAppVersion) < 0) {
    throw new Error('应用兼容版本范围无效')
  }
  return {
    schemaVersion: 2,
    id,
    name: textValue(manifest.name, '插件名称', 1, 80),
    version,
    description: textValue(manifest.description, '插件说明', 1, 500),
    license: textValue(manifest.license, '插件许可证', 1, 80),
    publisher: {
      id: identifier(publisherValue.id, '发布者 ID'),
      name: textValue(publisherValue.name, '发布者名称', 1, 80),
      keyId: identifier(publisherValue.keyId, '发布者密钥 ID')
    },
    minimumAppVersion,
    ...(maximumAppVersion ? { maximumAppVersion } : {}),
    sdkVersion: semver(manifest.sdkVersion, 'SDK 版本'),
    contributions
  }
}

function validateContribution(value: unknown): PluginContribution {
  const item = objectValue(value, '插件贡献点')
  const kind = enumValue(item.kind, pluginContributionKinds, '贡献点类型')
  const commonKeys = ['id', 'kind', 'name', 'description', 'entry', 'runtime', 'permissions', 'configSchema']
  const common = {
    id: identifier(item.id, '贡献点 ID'),
    kind,
    name: textValue(item.name, '贡献点名称', 1, 80),
    description: textValue(item.description, '贡献点说明', 1, 500),
    entry: entryValue(item.entry),
    runtime: enumValue(item.runtime, ['builtin', 'quickjs'] as const, '贡献点运行时'),
    permissions: uniqueEnums(item.permissions, pluginPermissions, '贡献点权限'),
    ...(item.configSchema === undefined ? {} : { configSchema: validateConfigSchema(item.configSchema) })
  }
  if (kind === 'platform.adapter') {
    exactKeys(item, [...commonKeys, 'platform', 'endpoints', 'captures', 'minimumIntervalSeconds', 'recommendedSyncIntervalHours'], '平台适配器')
    const platform = objectValue(item.platform, '平台定义')
    exactKeys(platform, ['id', 'name', 'shortName', 'loginUrl', 'homeUrl', 'navigationHosts', 'imageHosts', 'contentUrls', 'riskNote'], '平台定义')
    if (!common.permissions.includes('platform.session-json')) throw new Error('平台适配器缺少 Session JSON 权限')
    const navigationHosts = hostList(platform.navigationHosts, '平台导航域名')
    if (navigationHosts.length === 0) throw new Error('平台导航域名不能为空')
    const endpoints = arrayValue(item.endpoints, '平台端点').map(validateEndpoint)
    const captures = arrayValue(item.captures, '平台捕获规则').map(validateCapture)
    assertUniqueIds(endpoints, '平台端点')
    assertUniqueIds(captures, '平台捕获规则')
    return {
      ...common,
      kind,
      platform: {
        id: identifier(platform.id, '平台 ID'),
        name: textValue(platform.name, '平台名称', 1, 40),
        shortName: textValue(platform.shortName, '平台简称', 1, 4),
        loginUrl: httpsUrl(platform.loginUrl, '平台登录地址'),
        homeUrl: httpsUrl(platform.homeUrl, '平台主页'),
        navigationHosts,
        imageHosts: hostList(platform.imageHosts, '平台图片域名'),
        contentUrls: arrayValue(platform.contentUrls, '原帖 URL 模板').map(validateContentUrl),
        riskNote: textValue(platform.riskNote, '平台说明', 1, 300)
      },
      endpoints,
      captures,
      minimumIntervalSeconds: integerValue(item.minimumIntervalSeconds, '最小同步间隔', 1, 86_400),
      recommendedSyncIntervalHours: integerValue(item.recommendedSyncIntervalHours, '建议同步间隔', 1, 720)
    }
  }
  if (kind === 'action') {
    exactKeys(item, [...commonKeys, 'placements'], '动作贡献点')
    return {
      ...common,
      kind,
      placements: uniqueEnums(item.placements, ['plugin-center', 'account', 'content'] as const, '动作位置')
    }
  }
  if (kind === 'event.handler') {
    exactKeys(item, [...commonKeys, 'events'], '事件贡献点')
    if (!common.permissions.includes('events.subscribe')) throw new Error('事件贡献点缺少事件订阅权限')
    return {
      ...common,
      kind,
      events: uniqueEnums(item.events, ['sync.completed.v1', 'account.updated.v1', 'content.updated.v1'] as const, '订阅事件')
    }
  }
  exactKeys(item, [...commonKeys, 'minimumIntervalMinutes', 'defaultIntervalMinutes'], '定时贡献点')
  if (!common.permissions.includes('scheduler.run')) throw new Error('定时贡献点缺少调度权限')
  const minimumIntervalMinutes = integerValue(item.minimumIntervalMinutes, '最小调度间隔', 5, 525_600)
  const defaultIntervalMinutes = item.defaultIntervalMinutes === undefined
    ? undefined
    : integerValue(item.defaultIntervalMinutes, '默认调度间隔', minimumIntervalMinutes, 525_600)
  return {
    ...common,
    kind,
    minimumIntervalMinutes,
    ...(defaultIntervalMinutes === undefined ? {} : { defaultIntervalMinutes })
  }
}

function validateContentUrl(value: unknown): PlatformContentUrlDeclaration {
  const item = objectValue(value, '原帖 URL 模板')
  exactKeys(item, ['remoteIdTemplate', 'origin', 'pathTemplate', 'queryParameters'], '原帖 URL 模板')
  const remoteIdTemplate = templateValue(item.remoteIdTemplate, '远程 ID 模板')
  const path = pathTemplate(item.pathTemplate, '原帖路径模板')
  const idNames = templateNames(remoteIdTemplate)
  const pathNames = templateNames(path)
  if (idNames.length === 0 || idNames.some((name) => !pathNames.includes(name))) throw new Error('原帖 URL 模板参数不一致')
  return {
    remoteIdTemplate,
    origin: originValue(item.origin, '原帖来源'),
    pathTemplate: path,
    ...(item.queryParameters === undefined ? {} : {
      queryParameters: uniqueStrings(item.queryParameters, '原帖查询参数', 16, 64)
    })
  }
}

function validateEndpoint(value: unknown): PlatformEndpointDeclaration {
  const item = objectValue(value, '平台端点')
  exactKeys(item, ['id', 'origin', 'pathTemplate', 'queryParameters', 'maximumResponseBytes'], '平台端点')
  return {
    id: identifier(item.id, '端点 ID'),
    origin: originValue(item.origin, '端点来源'),
    pathTemplate: pathTemplate(item.pathTemplate, '端点路径'),
    ...(item.queryParameters === undefined ? {} : {
      queryParameters: uniqueStrings(item.queryParameters, '查询参数', 32, 64)
    }),
    ...(item.maximumResponseBytes === undefined ? {} : {
      maximumResponseBytes: integerValue(item.maximumResponseBytes, '响应上限', 1, 512 * 1024)
    })
  }
}

function validateCapture(value: unknown): PlatformCaptureDeclaration {
  const item = objectValue(value, '平台捕获规则')
  exactKeys(item, [
    'id', 'route', 'responseOrigin', 'responsePath', 'graphqlOperationName', 'resourceTypes', 'method', 'pagination',
    'maximumResponses', 'maximumResponseBytes', 'maximumTotalBytes'
  ], '平台捕获规则')
  if (item.method !== 'GET') throw new Error('平台捕获仅允许 GET')
  const responsePath = pathTemplate(item.responsePath, '响应路径')
  const operationName = item.graphqlOperationName === undefined
    ? undefined
    : graphqlOperationName(item.graphqlOperationName)
  if (operationName && templateNames(responsePath).length > 0) {
    throw new Error('GraphQL 响应路径必须是固定前缀')
  }
  return {
    id: identifier(item.id, '捕获规则 ID'),
    route: httpsRouteTemplate(item.route, '捕获页面'),
    responseOrigin: originValue(item.responseOrigin, '捕获来源'),
    responsePath,
    ...(operationName === undefined ? {} : { graphqlOperationName: operationName }),
    resourceTypes: uniqueEnums(item.resourceTypes, ['Fetch', 'XHR'] as const, '资源类型'),
    method: 'GET',
    ...(item.pagination === undefined ? {} : {
      pagination: enumValue(item.pagination, ['none', 'page-down'] as const, '分页方式')
    }),
    ...(item.maximumResponses === undefined ? {} : {
      maximumResponses: integerValue(item.maximumResponses, '最大响应数', 1, 100)
    }),
    ...(item.maximumResponseBytes === undefined ? {} : {
      maximumResponseBytes: integerValue(item.maximumResponseBytes, '单响应上限', 1, 512 * 1024)
    }),
    ...(item.maximumTotalBytes === undefined ? {} : {
      maximumTotalBytes: integerValue(item.maximumTotalBytes, '响应总上限', 1, 2 * 1024 * 1024)
    })
  }
}

function validateConfigSchema(value: unknown): PluginConfigSchema {
  const schema = objectValue(value, '配置 Schema')
  exactKeys(schema, ['type', 'properties', 'required', 'additionalProperties'], '配置 Schema')
  if (schema.type !== 'object' || (schema.additionalProperties !== undefined && schema.additionalProperties !== false)) {
    throw new Error('配置 Schema 必须是禁止额外字段的 object')
  }
  const properties = objectValue(schema.properties, '配置字段')
  if (Object.keys(properties).length > 64) throw new Error('配置字段过多')
  const normalized: Record<string, PluginConfigProperty> = {}
  for (const [key, property] of Object.entries(properties)) {
    if (!CONFIG_KEY_PATTERN.test(key)) throw new Error('配置字段名称非法')
    normalized[key] = validateConfigProperty(property)
  }
  const required = schema.required === undefined ? undefined : uniqueStrings(schema.required, '必填字段', 64, 128)
  if (required?.some((key) => !(key in normalized))) throw new Error('配置必填字段不存在')
  return {
    type: 'object',
    properties: normalized,
    ...(required ? { required } : {}),
    additionalProperties: false
  }
}

function validateConfigProperty(value: unknown): PluginConfigProperty {
  const item = objectValue(value, '配置字段')
  const type = enumValue(item.type, ['string', 'boolean', 'integer', 'number', 'array'] as const, '配置字段类型')
  const title = textValue(item.title, '配置字段标题', 1, 80)
  const description = item.description === undefined ? undefined : textValue(item.description, '配置字段说明', 1, 300)
  if (type === 'string') {
    exactKeys(item, ['type', 'title', 'description', 'default', 'enum', 'format', 'minLength', 'maxLength'], '字符串配置字段')
    const format = item.format === undefined
      ? undefined
      : enumValue(item.format, ['url', 'secret', 'text', 'multiline'] as const, '字段格式')
    if (format === 'secret' && (item.default !== undefined || item.enum !== undefined)) {
      throw new Error('Secret 配置字段不能包含默认值或枚举')
    }
    const result: PluginConfigProperty = {
      type,
      title,
      ...(description ? { description } : {}),
      ...(item.default === undefined ? {} : { default: textValue(item.default, '默认值', 0, 4_096) }),
      ...(item.enum === undefined ? {} : { enum: uniqueStrings(item.enum, '枚举值', 128, 512) }),
      ...(format === undefined ? {} : { format }),
      ...(item.minLength === undefined ? {} : { minLength: integerValue(item.minLength, '最小长度', 0, 4_096) }),
      ...(item.maxLength === undefined ? {} : { maxLength: integerValue(item.maxLength, '最大长度', 1, 4_096) })
    }
    return result
  }
  if (type === 'boolean') {
    exactKeys(item, ['type', 'title', 'description', 'default'], '布尔配置字段')
    if (item.default !== undefined && typeof item.default !== 'boolean') throw new Error('布尔默认值非法')
    return { type, title, ...(description ? { description } : {}), ...(item.default === undefined ? {} : { default: item.default as boolean }) }
  }
  if (type === 'array') {
    exactKeys(item, ['type', 'title', 'description', 'items', 'default', 'maxItems'], '数组配置字段')
    const items = objectValue(item.items, '数组元素')
    exactKeys(items, ['type', 'enum'], '数组元素')
    if (items.type !== 'string') throw new Error('数组配置只允许字符串元素')
    const itemEnum = items.enum === undefined ? undefined : uniqueStrings(items.enum, '数组枚举', 128, 512)
    const defaultValue = item.default === undefined ? undefined : uniqueStrings(item.default, '数组默认值', 128, 512)
    return {
      type,
      title,
      items: { type: 'string', ...(itemEnum ? { enum: itemEnum } : {}) },
      ...(description ? { description } : {}),
      ...(defaultValue ? { default: defaultValue } : {}),
      ...(item.maxItems === undefined ? {} : { maxItems: integerValue(item.maxItems, '数组上限', 1, 128) })
    }
  }
  exactKeys(item, ['type', 'title', 'description', 'default', 'minimum', 'maximum'], '数值配置字段')
  const number = (input: unknown, label: string): number => {
    if (typeof input !== 'number' || !Number.isFinite(input) || (type === 'integer' && !Number.isInteger(input))) {
      throw new Error(`${label}非法`)
    }
    return input
  }
  return {
    type,
    title,
    ...(description ? { description } : {}),
    ...(item.default === undefined ? {} : { default: number(item.default, '数值默认值') }),
    ...(item.minimum === undefined ? {} : { minimum: number(item.minimum, '最小值') }),
    ...(item.maximum === undefined ? {} : { maximum: number(item.maximum, '最大值') })
  }
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}必须是对象`)
  return value as Record<string, unknown>
}

function arrayValue(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label}必须是数组`)
  return value
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed)
  if (Object.keys(value).some((key) => !allowedSet.has(key))) throw new Error(`${label}包含未知字段`)
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) throw new Error(`${label}非法`)
  return value
}

function semver(value: unknown, label: string): string {
  if (typeof value !== 'string' || !VERSION_PATTERN.test(value) || value.length > 80) throw new Error(`${label}非法`)
  return value
}

function textValue(value: unknown, label: string, min: number, max: number): string {
  if (typeof value !== 'string' || value.length < min || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    throw new Error(`${label}非法`)
  }
  return value
}

function enumValue<const T extends readonly string[]>(value: unknown, values: T, label: string): T[number] {
  if (typeof value !== 'string' || !values.includes(value)) throw new Error(`${label}非法`)
  return value as T[number]
}

function uniqueEnums<const T extends readonly string[]>(value: unknown, values: T, label: string): T[number][] {
  const input = arrayValue(value, label)
  const result = input.map((item) => enumValue(item, values, label))
  if (new Set(result).size !== result.length) throw new Error(`${label}包含重复值`)
  return result
}

function uniqueStrings(value: unknown, label: string, maximumItems: number, maximumLength: number): string[] {
  const input = arrayValue(value, label)
  if (input.length > maximumItems) throw new Error(`${label}数量过多`)
  const result = input.map((item) => textValue(item, label, 1, maximumLength))
  if (new Set(result).size !== result.length) throw new Error(`${label}包含重复值`)
  return result
}

function integerValue(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) throw new Error(`${label}非法`)
  return value as number
}

function entryValue(value: unknown): string {
  if (typeof value !== 'string' || !ENTRY_PATTERN.test(value) || value.includes('..') || value.startsWith('/')) {
    throw new Error('插件入口非法')
  }
  return value.replace(/\\/g, '/')
}

function originValue(value: unknown, label: string): string {
  const url = new URL(httpsUrl(value, label))
  if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) throw new Error(`${label}必须是 HTTPS 来源`)
  return url.origin
}

function httpsUrl(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length > 2_048) throw new Error(`${label}非法`)
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${label}非法`)
  }
  if (url.protocol !== 'https:' || url.username || url.password || !url.hostname) throw new Error(`${label}必须使用 HTTPS`)
  return url.href
}

function httpsRouteTemplate(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length > 2_048) throw new Error(`${label}非法`)
  const match = /^(https:\/\/[^/?#]+)(\/[^?#]*)?(\?[^#]*)?$/i.exec(value)
  if (!match || /[{}]/.test(match[1]!) || /[{}]/.test(match[3] ?? '')) {
    throw new Error(`${label}必须是固定 HTTPS 来源与路径模板`)
  }
  const path = pathTemplate(match[2] ?? '/', `${label}路径`)
  if (path.startsWith('//')) throw new Error(`${label}必须是固定 HTTPS 来源与路径模板`)
  let route: URL
  try {
    const safePath = path.replace(/\{[A-Za-z][A-Za-z0-9_]{0,63}\}/g, 'template')
    route = new URL(`${match[1]}${safePath}${match[3] ?? ''}`)
  } catch {
    throw new Error(`${label}非法`)
  }
  const queryKeys = [...route.searchParams.keys()]
  if (route.protocol !== 'https:' || route.username || route.password || route.port ||
    hasExplicitPort(match[1]!) || !route.hostname || new Set(queryKeys).size !== queryKeys.length) {
    throw new Error(`${label}必须是固定 HTTPS 来源与路径模板`)
  }
  return `${route.origin}${path}${route.search}`
}

function hasExplicitPort(origin: string): boolean {
  const authority = origin.slice(origin.indexOf('//') + 2)
  const host = authority.slice(authority.lastIndexOf('@') + 1)
  if (host.startsWith('[')) return host.slice(host.indexOf(']') + 1).startsWith(':')
  return host.includes(':')
}

function graphqlOperationName(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value)) {
    throw new Error('GraphQL 操作名称非法')
  }
  return value
}

function hostList(value: unknown, label: string): string[] {
  const hosts = uniqueStrings(value, label, 64, 253).map((item) => item.toLowerCase())
  if (hosts.some((host) => host.includes('/') || host.includes(':') || !/^[a-z0-9.-]+$/.test(host))) throw new Error(`${label}非法`)
  return hosts
}

function pathTemplate(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.length > 1_024 || value.includes('://') || value.includes('..')) {
    throw new Error(`${label}非法`)
  }
  if (!/^\/(?:[A-Za-z0-9._~!$&'()*+,;=:@%/-]|\{[a-zA-Z][a-zA-Z0-9_]{0,63}\})*$/.test(value)) {
    throw new Error(`${label}包含不支持的字符`)
  }
  return value
}

function templateValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512 ||
    !/^(?:[A-Za-z0-9._~:-]|\{[A-Za-z][A-Za-z0-9_]{0,63}\})+$/.test(value)) {
    throw new Error(`${label}非法`)
  }
  const names = templateNames(value)
  if (new Set(names).size !== names.length) throw new Error(`${label}包含重复参数`)
  return value
}

function templateNames(value: string): string[] {
  return [...value.matchAll(/\{([A-Za-z][A-Za-z0-9_]{0,63})\}/g)].map((match) => match[1]!)
}

function assertUniqueIds(values: ReadonlyArray<{ id: string }>, label: string): void {
  if (new Set(values.map((item) => item.id)).size !== values.length) throw new Error(`${label} ID 重复`)
}

function compareSemver(left: string, right: string): number {
  const parse = (value: string): { core: bigint[]; prerelease: string[] | null } => {
    const [coreValue, prereleaseValue] = value.split('-', 2)
    return {
      core: coreValue!.split('.').map(BigInt),
      prerelease: prereleaseValue ? prereleaseValue.split('.') : null
    }
  }
  const leftValue = parse(left)
  const rightValue = parse(right)
  for (let index = 0; index < 3; index += 1) {
    const leftCore = leftValue.core[index]!
    const rightCore = rightValue.core[index]!
    if (leftCore !== rightCore) return leftCore < rightCore ? -1 : 1
  }
  if (!leftValue.prerelease && !rightValue.prerelease) return 0
  if (!leftValue.prerelease) return 1
  if (!rightValue.prerelease) return -1
  const length = Math.max(leftValue.prerelease.length, rightValue.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const leftPart = leftValue.prerelease[index]
    const rightPart = rightValue.prerelease[index]
    if (leftPart === undefined) return -1
    if (rightPart === undefined) return 1
    if (leftPart === rightPart) continue
    const leftNumber = /^\d+$/.test(leftPart) ? BigInt(leftPart) : null
    const rightNumber = /^\d+$/.test(rightPart) ? BigInt(rightPart) : null
    if (leftNumber !== null && rightNumber !== null) {
      if (leftNumber !== rightNumber) return leftNumber < rightNumber ? -1 : 1
      continue
    }
    if (leftNumber !== null) return -1
    if (rightNumber !== null) return 1
    return leftPart < rightPart ? -1 : 1
  }
  return 0
}
