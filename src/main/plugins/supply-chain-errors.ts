export type PluginSupplyChainErrorCode =
  | 'PLUGIN_PACKAGE_INVALID'
  | 'PLUGIN_PACKAGE_TOO_LARGE'
  | 'PLUGIN_PACKAGE_UNSAFE_ENTRY'
  | 'PLUGIN_PACKAGE_MANIFEST_INVALID'
  | 'PLUGIN_PACKAGE_SIGNATURE_INVALID'
  | 'PLUGIN_PACKAGE_HASH_MISMATCH'
  | 'PLUGIN_CATALOG_INVALID'
  | 'PLUGIN_CATALOG_SIGNATURE_INVALID'
  | 'PLUGIN_CATALOG_EXPIRED'
  | 'PLUGIN_REVOKED'
  | 'PLUGIN_SANDBOX_PROTOCOL_INVALID'
  | 'PLUGIN_SANDBOX_PERMISSION_DENIED'
  | 'PLUGIN_SANDBOX_RESOURCE_LIMIT'
  | 'PLUGIN_SANDBOX_CRASHED'
  | 'PLUGIN_SANDBOX_FAILED'
  | 'PLUGIN_ADAPTER_IDENTITY_FAILED'
  | 'PLUGIN_ADAPTER_IDENTITY_SETTINGS_EMPTY'
  | 'PLUGIN_ADAPTER_IDENTITY_PROFILE_EMPTY'
  | 'PLUGIN_ADAPTER_IDENTITY_RESPONSE_INVALID'
  | 'PLUGIN_ADAPTER_IDENTITY_STABLE_ID_FAILED'

/** Error whose code and message are safe to persist in plugin run history. */
export class PluginSupplyChainError extends Error {
  readonly code: PluginSupplyChainErrorCode

  constructor(code: PluginSupplyChainErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'PluginSupplyChainError'
    this.code = code
  }
}
export function isPluginSupplyChainError(error: unknown): error is PluginSupplyChainError {
  return error instanceof PluginSupplyChainError
}
