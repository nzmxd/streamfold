import { performance } from 'node:perf_hooks'
import {
  newQuickJSWASMModule,
  type QuickJSContext,
  type QuickJSHandle,
  type QuickJSRuntime
} from 'quickjs-emscripten'
import {
  assertHostCallPayload,
  assertJsonValue,
  jsonByteLength,
  type JsonObject,
  type JsonValue,
  type SandboxHostOperation,
  type SandboxInvocationRequest
} from './sandbox-protocol'
import { PluginSupplyChainError, isPluginSupplyChainError } from './supply-chain-errors'

export type SandboxHostCall = (
  operation: SandboxHostOperation,
  payload: JsonObject
) => Promise<JsonValue>

const STACK_LIMIT_BYTES = 1 * 1024 * 1024
const BOOTSTRAP_SOURCE = String.raw`
(() => {
  'use strict';
  const rawHostCall = globalThis.__streamfoldHostCall;
  Reflect.deleteProperty(globalThis, '__streamfoldHostCall');
  const call = async (operation, payload) => {
    const envelope = JSON.parse(await rawHostCall(operation, JSON.stringify(payload)));
    if (!envelope || envelope.ok !== true) {
      const error = new Error(envelope && envelope.error ? envelope.error.message : 'Host call failed');
      error.code = envelope && envelope.error ? envelope.error.code : 'HOST_CALL_FAILED';
      throw error;
    }
    return envelope.value;
  };
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
  ]) {
    Object.defineProperty(globalThis, name, {
      value: undefined,
      writable: false,
      configurable: false,
      enumerable: false
    });
  }
})();
`

export async function executeQuickJsContribution(
  request: SandboxInvocationRequest,
  hostCall: SandboxHostCall
): Promise<JsonValue> {
  if (jsonByteLength(request.input) > request.limits.maxRpcBytes ||
      jsonByteLength(request.context) > request.limits.maxRpcBytes) {
    throw new PluginSupplyChainError('PLUGIN_SANDBOX_RESOURCE_LIMIT', '插件调用参数超过大小限制')
  }

  // The utility process is one-shot, and each invocation also gets a fresh WASM
  // module so no guest heap or module state can cross contribution boundaries.
  const module = await newQuickJSWASMModule()
  const runtime = module.newRuntime()
  const context = runtime.newContext()
  const startedAt = performance.now()
  let suspendedMilliseconds = 0
  let suspensionStartedAt = 0
  let activeHostCalls = 0
  const outstandingHostCalls = new Set<Promise<void>>()
  let rejectRuntimeFailure: (error: unknown) => void = () => undefined
  const runtimeFailure = new Promise<never>((_resolve, reject) => { rejectRuntimeFailure = reject })
  void runtimeFailure.catch(() => undefined)
  runtime.setMemoryLimit(request.limits.memoryBytes)
  runtime.setMaxStackSize(STACK_LIMIT_BYTES)
  runtime.setInterruptHandler(() => {
    const activeSuspension = activeHostCalls > 0 ? performance.now() - suspensionStartedAt : 0
    return performance.now() - startedAt - suspendedMilliseconds - activeSuspension >= request.limits.cpuTimeoutMs
  })

  const beginHostWait = (): void => {
    if (activeHostCalls++ === 0) suspensionStartedAt = performance.now()
  }
  const endHostWait = (): void => {
    if (--activeHostCalls === 0) suspendedMilliseconds += performance.now() - suspensionStartedAt
  }

  try {
    const hostFunction = context.newFunction('__streamfoldHostCall', (operationHandle, payloadHandle) => {
      const deferred = context.newPromise()
      beginHostWait()
      const task = resolveHostEnvelope(context, request, hostCall, operationHandle, payloadHandle)
        .then((envelope) => {
          const value = context.newString(JSON.stringify(envelope))
          try {
            deferred.resolve(value)
          } finally {
            value.dispose()
          }
        }, () => {
          const fallback = context.newString(JSON.stringify({
            ok: false,
            error: { code: 'HOST_CALL_FAILED', message: '宿主操作失败' }
          }))
          try {
            deferred.resolve(fallback)
          } finally {
            fallback.dispose()
          }
        })
        .finally(() => {
          endHostWait()
          deferred.dispose()
        })
        .then(() => {
          try {
            executePendingJobs(context, runtime)
          } catch (error) {
            rejectRuntimeFailure(error)
            throw error
          }
        })
      outstandingHostCalls.add(task)
      void task.then(
        () => { outstandingHostCalls.delete(task) },
        () => { outstandingHostCalls.delete(task) }
      )
      return deferred.handle
    })
    hostFunction.consume((handle) => context.setProp(context.global, '__streamfoldHostCall', handle))

    evaluate(context, BOOTSTRAP_SOURCE, 'streamfold:bootstrap.js')
    evaluate(
      context,
      createContributionSource(request.entrySource),
      `streamfold:${request.pluginId}/${request.contributionId}.js`
    )

    const promiseHandle = evaluateForHandle(
      context,
      createInvocationSource(request.method, request.context, request.input),
      'streamfold:invoke.js'
    )
    const resolvedPromise = context.resolvePromise(promiseHandle)
    promiseHandle.dispose()
    executePendingJobs(context, runtime)
    const resolved = await Promise.race([resolvedPromise, runtimeFailure])
    const outputHandle = context.unwrapResult(resolved)
    try {
      const outputText = context.getString(outputHandle)
      if (Buffer.byteLength(outputText, 'utf8') > request.limits.maxRpcBytes) {
        throw new PluginSupplyChainError('PLUGIN_SANDBOX_RESOURCE_LIMIT', '插件返回结果超过大小限制')
      }
      let output: unknown
      try {
        output = JSON.parse(outputText)
      } catch (error) {
        throw new PluginSupplyChainError('PLUGIN_SANDBOX_FAILED', '插件返回了无效结果', { cause: error })
      }
      assertJsonValue(output)
      await Promise.allSettled([...outstandingHostCalls])
      return output
    } finally {
      outputHandle.dispose()
    }
  } catch (error) {
    if (isPluginSupplyChainError(error)) throw error
    throw mapQuickJsError(error)
  } finally {
    await Promise.allSettled([...outstandingHostCalls])
    context.dispose()
    runtime.dispose()
  }
}

async function resolveHostEnvelope(
  context: QuickJSContext,
  request: SandboxInvocationRequest,
  hostCall: SandboxHostCall,
  operationHandle: QuickJSHandle,
  payloadHandle: QuickJSHandle
): Promise<{ ok: true; value: JsonValue } | { ok: false; error: { code: string; message: string } }> {
  try {
    const operation = context.getString(operationHandle) as SandboxHostOperation
    if (!request.allowedOperations.includes(operation)) {
      return { ok: false, error: { code: 'HOST_PERMISSION_DENIED', message: '插件未获得此操作权限' } }
    }
    let payload: unknown
    try {
      payload = JSON.parse(context.getString(payloadHandle))
    } catch {
      return { ok: false, error: { code: 'HOST_PAYLOAD_INVALID', message: '插件请求参数无效' } }
    }
    const payloadObject = asJsonObject(payload)
    assertHostCallPayload(operation, payloadObject)
    if (jsonByteLength(payloadObject) > request.limits.maxRpcBytes) {
      throw new PluginSupplyChainError('PLUGIN_SANDBOX_RESOURCE_LIMIT', '插件请求超过大小限制')
    }
    const value = await hostCall(operation, payloadObject)
    assertJsonValue(value)
    if (jsonByteLength(value) > request.limits.maxRpcBytes) {
      throw new PluginSupplyChainError('PLUGIN_SANDBOX_RESOURCE_LIMIT', '宿主响应超过大小限制')
    }
    return { ok: true, value }
  } catch (error) {
    return { ok: false, error: safeHostError(error) }
  }
}

function evaluate(context: QuickJSContext, source: string, filename: string): void {
  evaluateForHandle(context, source, filename).dispose()
}

function evaluateForHandle(context: QuickJSContext, source: string, filename: string): QuickJSHandle {
  return context.unwrapResult(context.evalCode(source, filename, {
    type: 'global',
    strict: true,
    backtraceBarrier: true
  }))
}

function executePendingJobs(context: QuickJSContext, runtime: QuickJSRuntime): void {
  context.unwrapResult(runtime.executePendingJobs())
}

function createContributionSource(source: string): string {
  return `
(() => {
  'use strict';
  const module = { exports: {} };
  const exports = module.exports;
  ((module, exports) => {
${source}
  })(module, exports);
  const contribution = module.exports && module.exports.default
    ? module.exports.default
    : module.exports;
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
`
}

function createInvocationSource(method: string, pluginContext: JsonObject, input: JsonValue): string {
  const contextJson = JSON.stringify(JSON.stringify(pluginContext))
  const inputJson = JSON.stringify(JSON.stringify(input))
  return `
(async () => {
  'use strict';
  const contribution = globalThis.__streamfoldContribution;
  const method = contribution[${JSON.stringify(method)}];
  if (typeof method !== 'function') throw new TypeError('Contribution method is unavailable');
  const context = JSON.parse(${contextJson});
  const input = JSON.parse(${inputJson});
  const result = await method.call(undefined, Object.freeze(context), input);
  const json = JSON.stringify(result);
  if (json === undefined) throw new TypeError('Contribution result must be JSON-compatible');
  return json;
})()
`
}

function asJsonObject(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PluginSupplyChainError('PLUGIN_SANDBOX_PROTOCOL_INVALID', '插件请求参数无效')
  }
  assertJsonValue(value)
  return value as JsonObject
}

function safeHostError(error: unknown): { code: string; message: string } {
  if (isPluginSupplyChainError(error)) return { code: error.code, message: error.message }
  return { code: 'HOST_CALL_FAILED', message: '宿主操作失败' }
}

function mapQuickJsError(error: unknown): PluginSupplyChainError {
  const message = error instanceof Error ? error.message.toLowerCase() : ''
  if (message.includes('interrupted') || message.includes('out of memory') || message.includes('stack overflow')) {
    return new PluginSupplyChainError('PLUGIN_SANDBOX_RESOURCE_LIMIT', '插件超过运行资源限制', { cause: error })
  }
  return new PluginSupplyChainError('PLUGIN_SANDBOX_FAILED', '插件执行失败', { cause: error })
}
