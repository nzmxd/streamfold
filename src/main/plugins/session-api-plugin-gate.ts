export interface SessionApiPluginGate {
  requireEnabledSessionApi(id: string, accountId?: string): {
    manualCollectionIntervalSeconds: number
  }
  recordSessionApiRun(id: string, succeeded: boolean, error?: string): unknown
}
