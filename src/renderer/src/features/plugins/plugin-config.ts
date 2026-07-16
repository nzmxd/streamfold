import type { PluginConfigProperty } from '../../../../shared/contracts'
import { cloneIpcPlainValue } from '../../ipc/plain-data'

export function cloneConfigValue(value: unknown): unknown {
  return cloneIpcPlainValue('plugins:save-config', value)
}

export function cloneConfigValues(values: Record<string, unknown>): Record<string, unknown> {
  return cloneIpcPlainValue('plugins:save-config', values) as Record<string, unknown>
}

export function initialConfigValue(property: PluginConfigProperty, saved: unknown): unknown {
  return cloneConfigValue(saved === undefined && 'default' in property ? property.default : saved)
}
