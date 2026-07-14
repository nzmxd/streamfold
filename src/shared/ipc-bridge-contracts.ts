import type { RuntimePlatform } from './contracts'

export const socialVaultInvokeChannels = [
  'appearance:get',
  'appearance:set',
  'updates:get-state',
  'updates:check',
  'updates:download',
  'updates:restart-and-install',
  'platforms:list',
  'accounts:list',
  'accounts:create',
  'accounts:update',
  'accounts:bulk-update',
  'accounts:disconnect',
  'accounts:purge',
  'accounts:verify-identity',
  'accounts:confirm-identity',
  'accounts:sync',
  'accounts:list-adapters',
  'accounts:switch-adapter',
  'groups:list',
  'groups:create',
  'groups:update',
  'groups:move',
  'groups:remove',
  'browser:open',
  'content:list',
  'content:detail',
  'content:open-original',
  'content:update',
  'content:clear-account',
  'analytics:overview',
  'analytics:dashboard',
  'plugins:packages',
  'plugins:contributions',
  'plugins:set-package-enabled',
  'plugins:set-contribution-enabled',
  'plugins:grant',
  'plugins:get-config',
  'plugins:save-config',
  'plugins:schedules',
  'plugins:create-schedule',
  'plugins:set-schedule-enabled',
  'plugins:remove-schedule',
  'plugins:runs',
  'plugins:get-grant',
  'plugins:refresh-catalog',
  'plugins:catalog',
  'plugins:install-catalog',
  'plugins:install-development',
  'plugins:update',
  'plugins:uninstall',
  'plugins:get-developer-mode',
  'plugins:set-developer-mode',
  'plugins:run',
  'plugins:retry-run',
  'settings:overview',
  'settings:update',
  'settings:export',
  'settings:backup-create',
  'settings:backup-restore'
] as const

export type SocialVaultInvokeChannel = (typeof socialVaultInvokeChannels)[number]

export const socialVaultEventChannels = [
  'appearance:changed',
  'updates:changed',
  'accounts:changed',
  'browser:state',
  'content:changed'
] as const

export type SocialVaultEventChannel = (typeof socialVaultEventChannels)[number]

/**
 * Narrow contextBridge surface. Business arguments cross the isolated-world
 * boundary only after the renderer has validated and encoded them as JSON.
 */
export interface SocialVaultBridge {
  runtime: { platform: RuntimePlatform }
  invoke(channel: SocialVaultInvokeChannel, serializedArgs: string): Promise<unknown>
  on(channel: SocialVaultEventChannel, callback: (payload?: unknown) => void): () => void
}

export const IPC_TRANSPORT_MAX_BYTES = 2 * 1024 * 1024
