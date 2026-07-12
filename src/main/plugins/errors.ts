/**
 * An error that is safe to persist and expose to the management renderer.
 *
 * Do not put file paths, imported values, SQL, or upstream error messages in it.
 */
export class SafeImportError extends Error {
  readonly code: string

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'SafeImportError'
    this.code = code
  }
}

export function isSafeImportError(error: unknown): error is SafeImportError {
  return error instanceof SafeImportError
}

export function toSafeImportError(
  error: unknown,
  fallbackCode = 'IMPORT_FAILED',
  fallbackMessage = '导入失败，请检查文件后重试'
): SafeImportError {
  return isSafeImportError(error)
    ? error
    : new SafeImportError(fallbackCode, fallbackMessage, { cause: error })
}
