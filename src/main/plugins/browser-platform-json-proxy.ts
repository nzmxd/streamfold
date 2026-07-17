import type { BrowserManager } from '../browser-manager'
import type { JsonValue } from './sandbox-protocol'
import type { PlatformJsonProxy } from './plugin-runtime-executor'
import { normalizePluginNetworkError } from './network-diagnostics'

export class BrowserPlatformJsonProxy implements PlatformJsonProxy {
  constructor(private readonly browser: BrowserManager) {}

  async getJson(input: Parameters<PlatformJsonProxy['getJson']>[0]): Promise<JsonValue> {
    try {
      return await this.browser.getPluginPlatformJson(
        input.accountId,
        input.contribution,
        input.endpointId,
        input.params
      ) as JsonValue
    } catch (error) {
      throw normalizePluginNetworkError(error, '平台 JSON 端点请求失败')
    }
  }

  async captureJson(input: Parameters<PlatformJsonProxy['captureJson']>[0]): Promise<JsonValue> {
    try {
      return await this.browser.capturePluginPlatformJson(
        input.accountId,
        input.pluginId,
        input.pluginVersion,
        input.contribution,
        input.captureId,
        input.params,
        input.limit,
        input.policy
      ) as JsonValue
    } catch (error) {
      throw normalizePluginNetworkError(error, '平台响应捕获失败')
    }
  }

  async cacheAvatar(input: {
    accountId: string
    contribution: Parameters<PlatformJsonProxy['getJson']>[0]['contribution']
    sourceUrl: string
  }): Promise<{ cacheKey: string; mime: string } | null> {
    try {
      return await this.browser.cachePluginAvatar(input.accountId, input.contribution, input.sourceUrl)
    } catch (error) {
      throw normalizePluginNetworkError(error, '平台头像缓存失败')
    }
  }
}
