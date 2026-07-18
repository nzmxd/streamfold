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
export type PluginEventType = 'sync.completed.v1' | 'account.updated.v1' | 'content.updated.v1'

export type JsonPrimitive = null | boolean | number | string
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject
export interface JsonObject { [key: string]: JsonValue }

export type ContentType = 'article' | 'post' | 'image' | 'video' | 'answer'
export type ContentMetricValueKind = 'count' | 'ratio' | 'duration'
export type ContentMetricUnit = 'count' | 'ratio' | 'seconds'
export type ContentMetricGroup = 'reach' | 'engagement' | 'conversion' | 'other'
export type MetricMeasurement = 'cumulative' | 'period_total' | 'gauge'
export type StandardContentMetricId = 'views' | 'likes' | 'comments' | 'shares' | 'favorites'

export interface ContentMetricDefinition {
  id: string
  label: string
  valueKind: ContentMetricValueKind
  unit: ContentMetricUnit
  group: ContentMetricGroup
  sortOrder: number
  measurementKind?: MetricMeasurement
  standardMetricId?: StandardContentMetricId | null
}

export interface StandardContentSnapshot {
  views: number | null
  likes: number | null
  comments: number | null
  shares: number | null
  favorites: number | null
  metrics: Record<string, number | null>
  capturedAt: string
}

export interface StandardContent {
  remoteId: string
  type: ContentType
  title: string
  bodyExcerpt: string
  url: string
  publishedAt: string | null
  snapshots: StandardContentSnapshot[]
}

export interface StandardProfile {
  remoteId: string
  remoteName: string
  avatarUrl?: string
  bio?: string
  creatorLevel?: number | null
  followers: number | null
  following: number | null
  contentCount: number | null
  viewsTotal: number | null
  likesAndFavoritesTotal?: number | null
  views?: number | null
  likes?: number | null
  comments?: number | null
  shares?: number | null
  favorites?: number | null
}

export interface SyncCoverage {
  requestedContentCount: number
  actualContentCount: number
  /** null means that the adapter could not reliably determine the pagination state. */
  paginationEnded: boolean | null
}

export interface StandardDataset {
  capturedAt: string
  profile: StandardProfile | null
  contentMetricDefinitions?: ContentMetricDefinition[]
  contents: StandardContent[]
  /** Optional for backward compatibility; current adapters should always provide it. */
  coverage?: SyncCoverage
  warnings: string[]
}

export interface PlatformAdapterIdentity {
  remoteId: string
  remoteName: string
  profile?: JsonObject
}

export interface PlatformAdapterIdentityPending {
  status: 'capture_pending'
  message?: string
}

export type PlatformAdapterIdentityResult = PlatformAdapterIdentity | PlatformAdapterIdentityPending

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

export type PlatformIdentityDiscoveryStrategy = 'on-capture' | 'on-navigation-and-capture'

export interface PlatformBackgroundIdentityDiscoveryDeclaration {
  strategy: PlatformIdentityDiscoveryStrategy
  captureIds: string[]
}

export interface PlatformBackgroundResponseCorrelationDeclaration {
  routeParameter: string
  responseFieldPaths: string[]
  comparison: 'exact' | 'case-insensitive'
}

export interface PlatformBackgroundCaptureRuleDeclaration {
  captureId: string
  /** RFC 6901-style scalar field paths; non-terminal `*` may select array items. */
  responseFieldPaths: string[]
  responseCorrelations?: PlatformBackgroundResponseCorrelationDeclaration[]
}

export interface PlatformBackgroundCaptureDeclaration {
  captures: PlatformBackgroundCaptureRuleDeclaration[]
  cacheTtlSeconds: number
  retryIntervalSeconds: number
  maximumRetryIntervalSeconds: number
  identityDiscovery?: PlatformBackgroundIdentityDiscoveryDeclaration
}

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
  backgroundCapture?: PlatformBackgroundCaptureDeclaration
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

export interface PluginExecutionContext extends JsonObject {
  pluginId: string
  contributionId: string
  capturePolicy: 'fresh' | 'background-cache'
}

export interface PlatformAdapterReadIdentityInput extends JsonObject {
  expectedRemoteId: string | null
}

export interface PlatformAdapterCollectInput extends JsonObject {
  scope: 'profile_only' | 'recent_20' | 'recent_100'
  boundRemoteId: string
}

export interface PlatformApi {
  getJson(endpointId: string, params?: JsonObject): Promise<JsonValue>
  captureJson(captureId: string, params?: JsonObject, limit?: number): Promise<JsonValue>
}

export interface DataApi {
  read(resource: 'accounts' | 'profiles' | 'contents' | 'metrics', query?: JsonObject): Promise<JsonValue>
}

export interface NetworkRequestOptions {
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  body?: JsonValue
  timeoutMs?: number
}

export interface NetworkApi {
  request(url: string, options?: NetworkRequestOptions): Promise<JsonValue>
}

export interface StreamfoldPluginApi {
  platform: PlatformApi
  data: DataApi
  network: NetworkApi
}

export interface PluginContributionModule {
  [method: string]: (context: Readonly<PluginExecutionContext>, input: JsonValue) => JsonValue | Promise<JsonValue>
}

export interface PlatformAdapterContributionModule {
  readIdentity(
    context: Readonly<PluginExecutionContext>,
    input: PlatformAdapterReadIdentityInput
  ): PlatformAdapterIdentityResult | Promise<PlatformAdapterIdentityResult>
  collect(
    context: Readonly<PluginExecutionContext>,
    input: PlatformAdapterCollectInput
  ): StandardDataset | Promise<StandardDataset>
}

declare global {
  const streamfold: StreamfoldPluginApi
}

export function defineContribution<const T extends PluginContributionModule>(contribution: T): T {
  return contribution
}

export function definePlatformAdapter<const T extends PlatformAdapterContributionModule>(adapter: T): T {
  return adapter
}
