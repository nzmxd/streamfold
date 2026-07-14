import type { BrowserManager } from '../browser-manager'
import type { JsonValue } from './sandbox-protocol'
import type { PlatformJsonProxy } from './plugin-runtime-executor'

export class BrowserPlatformJsonProxy implements PlatformJsonProxy {
  constructor(private readonly browser: BrowserManager) {}

  async getJson(input: Parameters<PlatformJsonProxy['getJson']>[0]): Promise<JsonValue> {
    return await this.browser.getPluginPlatformJson(
      input.accountId,
      input.contribution,
      input.endpointId,
      input.params
    ) as JsonValue
  }

  async captureJson(input: Parameters<PlatformJsonProxy['captureJson']>[0]): Promise<JsonValue> {
    return await this.browser.capturePluginPlatformJson(
      input.accountId,
      input.contribution,
      input.captureId,
      input.params,
      input.limit
    ) as JsonValue
  }

  async cacheAvatar(input: {
    accountId: string
    contribution: Parameters<PlatformJsonProxy['getJson']>[0]['contribution']
    sourceUrl: string
  }): Promise<{ cacheKey: string; mime: string } | null> {
    return await this.browser.cachePluginAvatar(input.accountId, input.contribution, input.sourceUrl)
  }
}
