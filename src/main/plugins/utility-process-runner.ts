import type { ParentPort } from 'electron'
import { executeQuickJsContribution } from './quickjs-engine'
import {
  jsonByteLength,
  parseSandboxHostResult,
  parseSandboxInvocationRequest,
  type JsonObject,
  type JsonValue,
  type SandboxErrorPayload,
  type SandboxHostOperation,
  type SandboxHostResultMessage,
  type SandboxInvocationRequest
} from './sandbox-protocol'
import { PluginSupplyChainError, isPluginSupplyChainError } from './supply-chain-errors'
import { formatSandboxDiagnostic } from './sandbox-diagnostics'

interface PendingHostCall {
  resolve: (value: JsonValue) => void
  reject: (error: Error) => void
}

type SandboxFailureCode =
  | 'PLUGIN_SANDBOX_PROTOCOL_INVALID'
  | 'PLUGIN_SANDBOX_PERMISSION_DENIED'
  | 'PLUGIN_SANDBOX_RESOURCE_LIMIT'
  | 'PLUGIN_SANDBOX_CRASHED'
  | 'PLUGIN_SANDBOX_FAILED'

export function startUtilityProcessRunner(parentPort: ParentPort): void {
  const pending = new Map<string, PendingHostCall>()
  let activeInvocation: SandboxInvocationRequest | null = null
  let invocationStarted = false
  let callCounter = 0
  let finished = false

  const postError = (invocationId: string, error: unknown): void => {
    if (finished) return
    finished = true
    const safe = safeRunnerError(error)
    parentPort.postMessage({
      protocolVersion: 1,
      type: 'error',
      invocationId,
      error: safe
    })
    rejectPending(pending)
  }

  const callHost = (operation: SandboxHostOperation, payload: JsonObject): Promise<JsonValue> => {
    const invocation = activeInvocation
    if (!invocation || finished) {
      return Promise.reject(new PluginSupplyChainError('PLUGIN_SANDBOX_CRASHED', '插件沙箱已停止'))
    }
    const callId = `call_${String(++callCounter).padStart(8, '0')}`
    return new Promise<JsonValue>((resolve, reject) => {
      pending.set(callId, { resolve, reject })
      parentPort.postMessage({
        protocolVersion: 1,
        type: 'host-call',
        invocationId: invocation.invocationId,
        callId,
        operation,
        payload
      })
    })
  }

  parentPort.on('message', (event) => {
    const message = event.data
    if (isHostResultCandidate(message)) {
      let result: SandboxHostResultMessage
      try {
        result = parseSandboxHostResult(message)
      } catch (error) {
        postError(activeInvocation?.invocationId ?? 'invalid_msg', error)
        return
      }
      if (!activeInvocation || result.invocationId !== activeInvocation.invocationId) {
        postError(activeInvocation?.invocationId ?? 'invalid_msg', protocolError('invocation mismatch'))
        return
      }
      const hostCall = pending.get(result.callId)
      if (!hostCall) {
        postError(activeInvocation.invocationId, protocolError('unknown host call'))
        return
      }
      pending.delete(result.callId)
      if (result.ok) hostCall.resolve(result.value as JsonValue)
      else {
        const code = sandboxFailureCode(result.error?.code)
        hostCall.reject(withOriginCallId(
          new PluginSupplyChainError(code, result.error?.message ?? '宿主操作失败'),
          result.callId
        ))
      }
      return
    }

    if (invocationStarted) {
      postError(activeInvocation?.invocationId ?? 'invalid_msg', protocolError('multiple invocations'))
      return
    }
    invocationStarted = true
    try {
      activeInvocation = parseSandboxInvocationRequest(message)
    } catch (error) {
      postError(candidateInvocationId(message), error)
      return
    }
    const invocation = activeInvocation
    void withTimeout(
      executeQuickJsContribution(invocation, callHost),
      invocation.limits.totalTimeoutMs
    ).then((value) => {
      if (finished) return
      if (jsonByteLength(value) > invocation.limits.maxRpcBytes) {
        throw new PluginSupplyChainError('PLUGIN_SANDBOX_RESOURCE_LIMIT', '插件返回结果超过大小限制')
      }
      finished = true
      parentPort.postMessage({
        protocolVersion: 1,
        type: 'result',
        invocationId: invocation.invocationId,
        value
      })
      rejectPending(pending)
    }).catch((error: unknown) => postError(invocation.invocationId, error))
  })

  parentPort.postMessage({ protocolVersion: 1, type: 'ready' })
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new PluginSupplyChainError(
      'PLUGIN_SANDBOX_RESOURCE_LIMIT',
      '插件运行超过总时间限制'
    )), milliseconds)
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error: unknown) => { clearTimeout(timer); reject(error) }
    )
  })
}

function rejectPending(pending: Map<string, PendingHostCall>): void {
  for (const request of pending.values()) {
    request.reject(new PluginSupplyChainError('PLUGIN_SANDBOX_CRASHED', '插件沙箱已停止'))
  }
  pending.clear()
}

function safeRunnerError(error: unknown): SandboxErrorPayload {
  const details = formatSandboxDiagnostic(error)
  const originCallId = errorOriginCallId(error)
  if (isPluginSupplyChainError(error)) {
    return {
      code: sandboxFailureCode(error.code),
      message: error.message,
      ...(details ? { details } : {}),
      ...(originCallId ? { originCallId } : {})
    }
  }
  return {
    code: 'PLUGIN_SANDBOX_FAILED',
    message: '插件执行失败',
    ...(details ? { details } : {}),
    ...(originCallId ? { originCallId } : {})
  }
}

function protocolError(reason: string): PluginSupplyChainError {
  return new PluginSupplyChainError(
    'PLUGIN_SANDBOX_PROTOCOL_INVALID',
    '插件沙箱消息无效',
    { cause: new Error(reason) }
  )
}

function sandboxFailureCode(value: unknown): SandboxFailureCode {
  if (value === 'PLUGIN_SANDBOX_PROTOCOL_INVALID' ||
      value === 'PLUGIN_SANDBOX_PERMISSION_DENIED' ||
      value === 'PLUGIN_SANDBOX_RESOURCE_LIMIT' ||
      value === 'PLUGIN_SANDBOX_CRASHED' ||
      value === 'PLUGIN_SANDBOX_FAILED') return value
  return 'PLUGIN_SANDBOX_FAILED'
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

function errorOriginCallId(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null
  const descriptor = Object.getOwnPropertyDescriptor(error, 'originCallId')
  const value = descriptor && 'value' in descriptor ? descriptor.value : undefined
  return typeof value === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(value) ? value : null
}

function isHostResultCandidate(value: unknown): boolean {
  return Boolean(value && typeof value === 'object' && (value as { type?: unknown }).type === 'host-result')
}

function candidateInvocationId(value: unknown): string {
  if (value && typeof value === 'object') {
    const id = (value as { invocationId?: unknown }).invocationId
    if (typeof id === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(id)) return id
  }
  return 'invalid_msg'
}

export const __utilityProcessRunnerTest = Object.freeze({
  safeRunnerError,
  withOriginCallId
})

if (process.parentPort) startUtilityProcessRunner(process.parentPort)
