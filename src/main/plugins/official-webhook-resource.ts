import type { VerifiedPluginPackage } from './plugin-package'
import {
  OFFICIAL_WEBHOOK_RESOURCE_DESCRIPTOR,
  officialPluginResourcePath,
  verifyOfficialPluginResource
} from './official-plugin-resources'

/** Compatibility wrapper for callers that still initialize the Webhook package directly. */
export function verifyOfficialWebhookResource(resourcesRoot: string): Promise<VerifiedPluginPackage> {
  return verifyOfficialPluginResource(resourcesRoot, OFFICIAL_WEBHOOK_RESOURCE_DESCRIPTOR)
}

export function officialWebhookResourcePath(resourcesRoot: string): string {
  return officialPluginResourcePath(resourcesRoot, OFFICIAL_WEBHOOK_RESOURCE_DESCRIPTOR)
}
