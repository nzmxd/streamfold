/** An error with a stable code and renderer-safe message for job operations. */
export class SafeJobError extends Error {
  readonly code: string

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'SafeJobError'
    this.code = code
  }
}
