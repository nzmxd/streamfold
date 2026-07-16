const reportedErrors = new WeakSet<object>()

export function markErrorReported(error: unknown): void {
  if ((typeof error === 'object' && error !== null) || typeof error === 'function') {
    reportedErrors.add(error as object)
  }
}

export function wasErrorReported(error: unknown): boolean {
  return ((typeof error === 'object' && error !== null) || typeof error === 'function') &&
    reportedErrors.has(error as object)
}
