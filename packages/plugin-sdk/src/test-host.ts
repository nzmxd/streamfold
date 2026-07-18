import { Script, createContext, type Context } from 'node:vm'
import type { JsonObject, JsonValue } from './contracts.js'

export type TestHostOperation =
  | 'platform.getJson'
  | 'platform.captureJson'
  | 'data.read'
  | 'network.https'

export type TestHostCall = (
  operation: TestHostOperation,
  payload: JsonObject
) => JsonValue | Promise<JsonValue>

export interface TestHostOptions {
  hostCall?: TestHostCall
  timeoutMs?: number
}

export interface TestInvocation {
  entrySource: string
  method?: string
  context?: JsonObject
  input?: JsonValue
}

export interface PluginTestHost {
  readonly calls: ReadonlyArray<{ operation: TestHostOperation; payload: JsonObject }>
  invoke(request: TestInvocation): Promise<JsonValue>
}

/**
 * Lightweight development host that mirrors the public `streamfold` API.
 * It is intentionally not a security boundary; only run plugin source you trust.
 */
export function createTestHost(options: TestHostOptions = {}): PluginTestHost {
  const calls: Array<{ operation: TestHostOperation; payload: JsonObject }> = []
  const timeoutMs = boundedTimeout(options.timeoutMs ?? 5_000)
  return {
    get calls() {
      return calls.map((item) => ({ operation: item.operation, payload: cloneJson(item.payload) as JsonObject }))
    },
    async invoke(request: TestInvocation): Promise<JsonValue> {
      if (typeof request.entrySource !== 'string' || request.entrySource.length === 0 || request.entrySource.includes('\0')) {
        throw new TypeError('entrySource 必须是非空 JavaScript')
      }
      const method = request.method ?? 'run'
      if (!/^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/.test(method)) throw new TypeError('调用方法名非法')
      const contextValue = cloneJson({
        capturePolicy: 'fresh',
        ...(request.context ?? {})
      }) as JsonObject
      const inputValue = cloneJson(request.input ?? null)
      const sandbox: Record<string, unknown> = Object.create(null)
      sandbox.__streamfoldHostCall = async (operation: unknown, payload: unknown): Promise<JsonValue> => {
        if (!isOperation(operation)) throw new TypeError('宿主操作非法')
        const normalizedPayload = cloneJson(payload) as JsonObject
        if (!normalizedPayload || typeof normalizedPayload !== 'object' || Array.isArray(normalizedPayload)) {
          throw new TypeError('宿主调用参数必须是对象')
        }
        calls.push({ operation, payload: normalizedPayload })
        return cloneJson(await (options.hostCall?.(operation, normalizedPayload) ?? null))
      }
      const vmContext = createContext(sandbox, {
        name: 'streamfold-plugin-test-host',
        codeGeneration: { strings: false, wasm: false }
      })
      installApi(vmContext, timeoutMs)
      loadContribution(vmContext, request.entrySource, timeoutMs)
      sandbox.__streamfoldContextJson = JSON.stringify(contextValue)
      sandbox.__streamfoldInputJson = JSON.stringify(inputValue)
      const invocation = new Script(`
        (async () => {
          'use strict';
          const contribution = globalThis.__streamfoldContribution;
          const method = contribution[${JSON.stringify(method)}];
          if (typeof method !== 'function') throw new TypeError('Contribution method is unavailable');
          const context = Object.freeze(JSON.parse(globalThis.__streamfoldContextJson));
          const input = JSON.parse(globalThis.__streamfoldInputJson);
          return await method.call(undefined, context, input);
        })()
      `, { filename: 'streamfold:test-invoke.js' })
      const result = invocation.runInContext(vmContext, { timeout: timeoutMs }) as Promise<unknown>
      return cloneJson(await withTimeout(result, timeoutMs)) as JsonValue
    }
  }
}

function installApi(context: Context, timeoutMs: number): void {
  new Script(`
    (() => {
      'use strict';
      const rawHostCall = globalThis.__streamfoldHostCall;
      Reflect.deleteProperty(globalThis, '__streamfoldHostCall');
      const call = (operation, payload) => rawHostCall(operation, payload);
      const platform = Object.freeze({
        getJson(endpointId, params = {}) {
          return call('platform.getJson', { endpointId, params });
        },
        captureJson(captureId, params = {}, limit = undefined) {
          return call('platform.captureJson', { captureId, params, limit });
        }
      });
      const data = Object.freeze({
        read(resource, query = {}) {
          return call('data.read', { resource, query });
        }
      });
      const network = Object.freeze({
        request(url, options = {}) {
          return call('network.https', {
            url,
            method: options.method || 'GET',
            headers: options.headers,
            body: options.body,
            timeoutMs: options.timeoutMs
          });
        }
      });
      Object.defineProperty(globalThis, 'streamfold', {
        value: Object.freeze({ platform, data, network }),
        writable: false,
        configurable: false,
        enumerable: true
      });
      for (const name of [
        'process', 'require', 'Buffer', 'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource',
        'document', 'window', 'navigator', 'location', 'Deno', 'Bun', 'Worker'
      ]) Object.defineProperty(globalThis, name, { value: undefined, writable: false, configurable: false });
    })();
  `, { filename: 'streamfold:test-bootstrap.js' }).runInContext(context, { timeout: timeoutMs })
}

function loadContribution(context: Context, source: string, timeoutMs: number): void {
  new Script(`
    (() => {
      'use strict';
      const module = { exports: {} };
      const exports = module.exports;
      ((module, exports) => {
${source}
      })(module, exports);
      const contribution = module.exports && module.exports.default ? module.exports.default : module.exports;
      if (!contribution || typeof contribution !== 'object') {
        throw new TypeError('Contribution entry must export an object');
      }
      Object.defineProperty(globalThis, '__streamfoldContribution', {
        value: contribution,
        writable: false,
        configurable: false,
        enumerable: false
      });
    })();
  `, { filename: 'streamfold:test-contribution.js' }).runInContext(context, { timeout: timeoutMs })
}

function isOperation(value: unknown): value is TestHostOperation {
  return value === 'platform.getJson' || value === 'platform.captureJson' ||
    value === 'data.read' || value === 'network.https'
}

function cloneJson<T>(value: T): T {
  const text = JSON.stringify(value)
  if (text === undefined) throw new TypeError('值必须兼容 JSON')
  return JSON.parse(text) as T
}

function boundedTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 10 || value > 120_000) throw new TypeError('测试超时时间非法')
  return value
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`插件测试执行超过 ${timeoutMs} ms`)), timeoutMs)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
