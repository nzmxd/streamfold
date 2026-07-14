export interface SessionApiPluginGate {
  requireEnabledSessionApi(id: string, accountId?: string): {
    manifest: { minimumIntervalSeconds: number }
  }
  recordSessionApiRun(id: string, succeeded: boolean, error?: string): unknown
}
