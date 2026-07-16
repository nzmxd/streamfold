export const appLogLevels = ['debug', 'info', 'warn', 'error'] as const
export type AppLogLevel = (typeof appLogLevels)[number]

export interface AppLogEntry {
  id: string
  timestamp: string
  level: AppLogLevel
  scope: string
  message: string
  code: string | null
  details: string | null
  context: Record<string, string | number | boolean | null>
}

export interface AppLogQuery {
  level?: AppLogLevel
  scope?: string
  search?: string
  limit?: number
}

export interface AppLogListResult {
  items: AppLogEntry[]
  total: number
  fileBytes: number
  scopes: string[]
}

export interface AppLogExportResult {
  cancelled: boolean
  fileName: string | null
  exportedCount: number
}

export interface RendererErrorLogInput {
  message: string
  source: 'vue' | 'window' | 'unhandled-rejection'
  code?: string
  stack?: string
  details?: string
  file?: string
  line?: number
  column?: number
  componentInfo?: string
}
