export const pluginCapabilities = [
  'account.identity',
  'account.profile',
  'account.metrics',
  'content.list',
  'content.metrics'
] as const
export type PluginCapability = (typeof pluginCapabilities)[number]
export type PluginMode = 'session_api'
export type PluginRiskLevel = 'low' | 'medium' | 'high'
export type PluginAvailability = 'available' | 'planned' | 'disabled'

export interface PluginManifest {
  schemaVersion: 1
  id: string
  name: string
  version: string
  description: string
  license: string
  source: 'builtin' | 'audited_bundle'
  commitHash: string
  mode: PluginMode
  readOnly: true
  ownedAccountOnly: true
  capabilities: PluginCapability[]
  allowedHosts: string[]
  minimumIntervalSeconds: number
  recommendedSyncIntervalHours: number
  riskLevel: PluginRiskLevel
}

export interface PluginInstallation {
  manifest: PluginManifest
  enabled: boolean
  availability: PluginAvailability
  installedAt: string | null
  lastRunAt: string | null
  successCount: number
  failureCount: number
  lastError: string
}
