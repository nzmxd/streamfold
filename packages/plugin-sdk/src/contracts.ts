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
  resourceTypes: Array<'Fetch' | 'XHR'>
  method: 'GET'
  pagination?: 'none' | 'page-down'
  maximumResponses?: number
  maximumResponseBytes?: number
  maximumTotalBytes?: number
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

declare global {
  const streamfold: StreamfoldPluginApi
}

export function defineContribution<const T extends PluginContributionModule>(contribution: T): T {
  return contribution
}
