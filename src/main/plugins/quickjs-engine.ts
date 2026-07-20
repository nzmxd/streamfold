import { randomUUID } from 'node:crypto'
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
  hostResponseJsonByteLength,
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
const MAX_IN_FLIGHT_HOST_CALLS = 16
const MAX_TRACKED_GUEST_FAILURES = 128

type SandboxFailureCode =
  | 'PLUGIN_SANDBOX_PROTOCOL_INVALID'
  | 'PLUGIN_SANDBOX_PERMISSION_DENIED'
  | 'PLUGIN_SANDBOX_RESOURCE_LIMIT'
  | 'PLUGIN_SANDBOX_CRASHED'
  | 'PLUGIN_SANDBOX_FAILED'

type HostEnvelope = {
  ok: true
  value: JsonValue
} | {
  ok: false
  error: { code: SandboxFailureCode; message: string; originCallId: string }
}

const BOOTSTRAP_SOURCE = String.raw`
(() => {
  'use strict';
  const rawHostCall = globalThis.__streamfoldHostCall;
  const trustedHostErrors = new WeakSet();
  Reflect.deleteProperty(globalThis, '__streamfoldHostCall');
  const call = async (operation, payload) => {
    const envelope = JSON.parse(await rawHostCall(operation, JSON.stringify(payload)));
    if (!envelope || envelope.ok !== true) {
      const error = new Error(envelope && envelope.error ? envelope.error.message : 'Host call failed');
      error.code = envelope && envelope.error ? envelope.error.code : 'HOST_CALL_FAILED';
      if (envelope && envelope.error && typeof envelope.error.originCallId === 'string') {
        error.originCallId = envelope.error.originCallId;
      }
      trustedHostErrors.add(error);
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
  Object.defineProperty(globalThis, '__streamfoldCaptureFailure', {
    value(error) {
      const captured = {
        name: 'Error',
        message: typeof error === 'string' ? error : 'Plugin execution failed'
      };
      try {
        if (error && typeof error.name === 'string') captured.name = error.name;
      } catch (_nameError) {}
      try {
        if (error && typeof error.message === 'string') captured.message = error.message;
      } catch (_messageError) {}
      try {
        if (error && typeof error.stack === 'string') captured.__streamfoldStack = error.stack;
      } catch (_stackError) {}
      if (error && typeof error === 'object' && trustedHostErrors.has(error)) {
        captured.__streamfoldTrustedHostFailure = true;
        try { captured.code = error.code; } catch (_codeError) {}
        try { captured.originCallId = error.originCallId; } catch (_callIdError) {}
      }
      return captured;
    },
    writable: false,
    configurable: false,
    enumerable: false
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
  let consumedCpuMilliseconds = 0
  let cpuSliceStartedAt = 0
  let cpuSliceDepth = 0
  let cpuInterrupted = false
  let inFlightHostCalls = 0
  const outstandingHostCalls = new Set<Promise<void>>()
  const trustedGuestFailures = new Map<string, SandboxFailureCode>()
  let rejectRuntimeFailure: (error: unknown) => void = () => undefined
  const runtimeFailure = new Promise<never>((_resolve, reject) => { rejectRuntimeFailure = reject })
  void runtimeFailure.catch(() => undefined)
  runtime.setMemoryLimit(request.limits.memoryBytes)
  runtime.setMaxStackSize(STACK_LIMIT_BYTES)
  runtime.setInterruptHandler(() => {
    const activeSlice = cpuSliceDepth > 0 ? performance.now() - cpuSliceStartedAt : 0
    if (consumedCpuMilliseconds + activeSlice < request.limits.cpuTimeoutMs) return false
    cpuInterrupted = true
    return true
  })

  const runInVm = <T>(operation: () => T): T => {
    const rootSlice = cpuSliceDepth === 0
    if (rootSlice) cpuSliceStartedAt = performance.now()
    cpuSliceDepth += 1
    try {
      return operation()
    } finally {
      cpuSliceDepth -= 1
      if (rootSlice) consumedCpuMilliseconds += performance.now() - cpuSliceStartedAt
    }
  }

  try {
    const hostFunction = context.newFunction('__streamfoldHostCall', (operationHandle, payloadHandle) => {
      const deferred = context.newPromise()
      const envelope = inFlightHostCalls >= MAX_IN_FLIGHT_HOST_CALLS
        ? Promise.resolve(trustedFailureEnvelope(
            trustedGuestFailures,
            'PLUGIN_SANDBOX_RESOURCE_LIMIT',
            '插件并发宿主调用超过限制'
          ))
        : (() => {
            inFlightHostCalls += 1
            return resolveHostEnvelope(
              context,
              request,
              hostCall,
              operationHandle,
              payloadHandle,
              trustedGuestFailures
            ).finally(() => { inFlightHostCalls -= 1 })
          })()
      const task = envelope
        .then((envelope) => {
          const value = runInVm(() => context.newString(JSON.stringify(envelope)))
          try {
            runInVm(() => deferred.resolve(value))
          } finally {
            value.dispose()
          }
        }, () => {
          const fallbackEnvelope = trustedFailureEnvelope(
            trustedGuestFailures,
            'PLUGIN_SANDBOX_FAILED',
            '宿主操作失败'
          )
          const fallback = runInVm(() => context.newString(JSON.stringify(fallbackEnvelope)))
          try {
            runInVm(() => deferred.resolve(fallback))
          } finally {
            fallback.dispose()
          }
        })
        .finally(() => {
          deferred.dispose()
        })
        .then(() => {
          try {
            runInVm(() => executePendingJobs(context, runtime))
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
    hostFunction.consume((handle) => runInVm(() => context.setProp(context.global, '__streamfoldHostCall', handle)))

    runInVm(() => evaluate(context, BOOTSTRAP_SOURCE, 'streamfold:bootstrap.js'))
    runInVm(() => evaluate(
      context,
      createContributionSource(request.entrySource),
      `streamfold:${request.pluginId}/${request.contributionId}.js`
    ))

    const promiseHandle = runInVm(() => evaluateForHandle(
      context,
      createInvocationSource(request.method, request.context, request.input),
      'streamfold:invoke.js'
    ))
    const resolvedPromise = runInVm(() => context.resolvePromise(promiseHandle))
    promiseHandle.dispose()
    runInVm(() => executePendingJobs(context, runtime))
    const resolved = await Promise.race([resolvedPromise, runtimeFailure])
    const outputHandle = runInVm(() => context.unwrapResult(resolved))
    try {
      const outputText = runInVm(() => context.getString(outputHandle))
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
    throw mapQuickJsError(error, trustedGuestFailures, cpuInterrupted)
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
  payloadHandle: QuickJSHandle,
  trustedGuestFailures: Map<string, SandboxFailureCode>
): Promise<HostEnvelope> {
  try {
    const operation = context.getString(operationHandle) as SandboxHostOperation
    if (!request.allowedOperations.includes(operation)) {
      return trustedFailureEnvelope(
        trustedGuestFailures,
        'PLUGIN_SANDBOX_PERMISSION_DENIED',
        '插件未获得此操作权限'
      )
    }
    let payload: unknown
    try {
      payload = JSON.parse(context.getString(payloadHandle))
    } catch {
      return trustedFailureEnvelope(
        trustedGuestFailures,
        'PLUGIN_SANDBOX_PROTOCOL_INVALID',
        '插件请求参数无效'
      )
    }
    const payloadObject = asJsonObject(payload)
    assertHostCallPayload(operation, payloadObject)
    if (jsonByteLength(payloadObject) > request.limits.maxRpcBytes) {
      throw new PluginSupplyChainError('PLUGIN_SANDBOX_RESOURCE_LIMIT', '插件请求超过大小限制')
    }
    const value = await hostCall(operation, payloadObject)
    if (hostResponseJsonByteLength(operation, value) > request.limits.maxRpcBytes) {
      throw new PluginSupplyChainError('PLUGIN_SANDBOX_RESOURCE_LIMIT', '宿主响应超过大小限制')
    }
    return { ok: true, value }
  } catch (error) {
    const safe = safeHostError(error)
    return trustedFailureEnvelope(
      trustedGuestFailures,
      sandboxFailureCode(safe.code) ?? 'PLUGIN_SANDBOX_FAILED',
      safe.message,
      safe.originCallId
    )
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
  try {
    const result = await method.call(undefined, Object.freeze(context), input);
    const json = JSON.stringify(result);
    if (json === undefined) throw new TypeError('Contribution result must be JSON-compatible');
    return json;
  } catch (error) {
    throw globalThis.__streamfoldCaptureFailure(error);
  }
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

function safeHostError(error: unknown): { code: string; message: string; originCallId?: string } {
  const originCallId = errorOriginCallId(error)
  if (isPluginSupplyChainError(error)) {
    return {
      code: error.code,
      message: error.message,
      ...(originCallId ? { originCallId } : {})
    }
  }
  return {
    code: 'PLUGIN_SANDBOX_FAILED',
    message: '宿主操作失败',
    ...(originCallId ? { originCallId } : {})
  }
}

function mapQuickJsError(
  error: unknown,
  trustedGuestFailures: ReadonlyMap<string, SandboxFailureCode>,
  cpuInterrupted: boolean
): PluginSupplyChainError {
  const message = error instanceof Error ? error.message.toLowerCase() : ''
  const dumped = errorProperty(error, 'cause')
  const trustedHostFailure = errorProperty(dumped, '__streamfoldTrustedHostFailure') === true
  const reportedCode = errorProperty(dumped, 'code') ?? errorProperty(error, 'code')
  const originCallId = errorOriginCallId(dumped) ?? errorOriginCallId(error)
  const reportedSandboxCode = sandboxFailureCode(reportedCode)
  const trustedCode = trustedHostFailure && originCallId && reportedSandboxCode &&
    trustedGuestFailures.get(originCallId) === reportedSandboxCode
    ? reportedSandboxCode
    : null
  const code = trustedCode ?? (cpuInterrupted || message.includes('out of memory') || message.includes('stack overflow')
      ? 'PLUGIN_SANDBOX_RESOURCE_LIMIT'
      : 'PLUGIN_SANDBOX_FAILED')
  const safeMessage = code === 'PLUGIN_SANDBOX_PROTOCOL_INVALID'
    ? '插件沙箱消息无效'
    : code === 'PLUGIN_SANDBOX_PERMISSION_DENIED'
      ? '插件未获得此操作权限'
      : code === 'PLUGIN_SANDBOX_RESOURCE_LIMIT'
        ? '插件超过运行资源限制'
        : code === 'PLUGIN_SANDBOX_CRASHED'
          ? '插件沙箱意外停止'
          : '插件执行失败'
  const failure = new PluginSupplyChainError(code, safeMessage, {
    cause: quickJsDiagnosticCause(error)
  })
  return originCallId && trustedCode ? withOriginCallId(failure, originCallId) : failure
}

function trustedFailureEnvelope(
  failures: Map<string, SandboxFailureCode>,
  code: SandboxFailureCode,
  message: string,
  originCallId = `engine_${randomUUID().replace(/-/gu, '')}`
): HostEnvelope {
  failures.delete(originCallId)
  failures.set(originCallId, code)
  while (failures.size > MAX_TRACKED_GUEST_FAILURES) {
    const oldest = failures.keys().next().value as string | undefined
    if (!oldest) break
    failures.delete(oldest)
  }
  return { ok: false, error: { code, message, originCallId } }
}

function sandboxFailureCode(value: unknown): SandboxFailureCode | null {
  if (value === 'PLUGIN_SANDBOX_PROTOCOL_INVALID' ||
      value === 'PLUGIN_SANDBOX_PERMISSION_DENIED' ||
      value === 'PLUGIN_SANDBOX_RESOURCE_LIMIT' ||
      value === 'PLUGIN_SANDBOX_CRASHED' ||
      value === 'PLUGIN_SANDBOX_FAILED') return value
  return null
}

function quickJsDiagnosticCause(error: unknown): unknown {
  if (!(error instanceof Error)) return error
  const dumped = errorProperty(error, 'cause')
  const guestMessage = errorProperty(dumped, 'message')
  const guestName = errorProperty(dumped, 'name')
  const cause = new Error(typeof guestMessage === 'string' ? guestMessage : error.message)
  cause.name = typeof guestName === 'string' ? guestName : error.name
  const copiedStack = errorProperty(dumped, '__streamfoldStack') ??
    errorProperty(dumped, 'stack') ??
    error.stack
  if (typeof copiedStack === 'string') {
    const headline = `${cause.name}: ${cause.message}`
    const stack = copiedStack.includes(cause.message)
      ? copiedStack
      : `${headline}\n${copiedStack}`
    Object.defineProperty(cause, 'stack', {
      value: stack,
      configurable: true,
      enumerable: false,
      writable: true
    })
  }
  return cause
}

function errorProperty(error: unknown, key: string): unknown {
  if ((!error || typeof error !== 'object') && typeof error !== 'function') return undefined
  const descriptor = Object.getOwnPropertyDescriptor(error, key)
  return descriptor && 'value' in descriptor ? descriptor.value : undefined
}

function errorOriginCallId(error: unknown): string | null {
  const value = errorProperty(error, 'originCallId')
  return typeof value === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(value) ? value : null
}

function withOriginCallId<T extends Error>(error: T, callId: string): T {
  Object.defineProperty(error, 'originCallId', {
    value: callId,
    configurable: false,
    enumerable: true,
    writable: false
  })
  return error
}
