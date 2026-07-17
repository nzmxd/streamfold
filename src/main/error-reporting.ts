const reportedErrors = new WeakSet<object>()
const reportedContexts = new Set<string>()
const MAX_REPORTED_CONTEXTS = 1_000

export interface ErrorReportMetadata {
  scope: string
  context?: Record<string, unknown>
}

export type ErrorReporter = (error: unknown, metadata: ErrorReportMetadata) => void

let reporter: ErrorReporter | null = null

export function setErrorReporter(next: ErrorReporter | null): void {
  reporter = next
  if (!next) reportedContexts.clear()
}

export function consumeErrorReportContext(key: 'jobId' | 'runId', value: string): boolean {
  return reportedContexts.delete(`${key}:${value}`)
}

export function markErrorReported(
  error: unknown,
  metadata: ErrorReportMetadata = { scope: 'app' }
): void {
  const candidate = ((typeof error === 'object' && error !== null) || typeof error === 'function')
    ? error as object
    : null
  if (candidate && reportedErrors.has(candidate)) {
    rememberReportContexts(metadata.context)
    return
  }
  if (reporter) {
    try {
      reporter(error, metadata)
    } catch {
      // Leave it unmarked so the outer error boundary can try reporting it again.
      return
    }
  }
  if (candidate) {
    reportedErrors.add(candidate)
    const timeout = setTimeout(() => reportedErrors.delete(candidate), 0)
    timeout.unref?.()
  }
  rememberReportContexts(metadata.context)
}

function rememberReportContexts(context: Record<string, unknown> | undefined): void {
  for (const key of ['jobId', 'runId'] as const) {
    const value = context?.[key]
    if (typeof value === 'string' && value) {
      if (reportedContexts.size >= MAX_REPORTED_CONTEXTS) {
        const oldest = reportedContexts.values().next().value
        if (typeof oldest === 'string') reportedContexts.delete(oldest)
      }
      reportedContexts.add(`${key}:${value}`)
    }
  }
}

export function wasErrorReported(error: unknown): boolean {
  return ((typeof error === 'object' && error !== null) || typeof error === 'function') &&
    reportedErrors.has(error as object)
}
