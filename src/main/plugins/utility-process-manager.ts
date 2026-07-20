import type { UtilityProcess } from 'electron'
import {
  hostResponseJsonByteLength,
  jsonByteLength,
  parseSandboxChildMessage,
  parseSandboxInvocationRequest,
  type JsonObject,
  type JsonValue,
  type SandboxHostCallMessage,
  type SandboxHostResultMessage,
  type SandboxInvocationRequest
} from './sandbox-protocol'
import { PluginSupplyChainError, isPluginSupplyChainError } from './supply-chain-errors'
import { sanitizeSandboxDiagnostic } from './sandbox-diagnostics'

type SandboxFailureCode =
  | 'PLUGIN_SANDBOX_PROTOCOL_INVALID'
  | 'PLUGIN_SANDBOX_PERMISSION_DENIED'
  | 'PLUGIN_SANDBOX_RESOURCE_LIMIT'
  | 'PLUGIN_SANDBOX_CRASHED'
  | 'PLUGIN_SANDBOX_FAILED'

interface RecordedHostFailure {
  code: SandboxFailureCode
  operation: SandboxHostCallMessage['operation']
  cause: unknown
}

export interface UtilityProcessLike {
  on(event: 'message', listener: (message: unknown) => void): this
  on(event: 'exit', listener: (code: number) => void): this
  on(event: 'error', listener: (...args: unknown[]) => void): this
  off(event: 'message', listener: (message: unknown) => void): this
  off(event: 'exit', listener: (code: number) => void): this
  off(event: 'error', listener: (...args: unknown[]) => void): this
  postMessage(message: unknown): void
  kill(): boolean
}

export type UtilityProcessFork = (modulePath: string) => UtilityProcessLike

export type SandboxHostCallHandler = (
  call: Pick<SandboxHostCallMessage, 'operation' | 'payload'>,
  identity: Pick<SandboxInvocationRequest, 'invocationId' | 'pluginId' | 'contributionId'>
) => Promise<JsonValue>

export interface UtilityProcessSandboxManagerOptions {
  runnerPath: string
  hostCall: SandboxHostCallHandler
  fork?: UtilityProcessFork
  readyTimeoutMs?: number
}

export class UtilityProcessSandboxManager {
  private readonly runnerPath: string
  private readonly hostCall: SandboxHostCallHandler
  private readonly forkOverride?: UtilityProcessFork
  private readonly readyTimeoutMs: number
  private readonly activeChildren = new Map<string, Set<UtilityProcessLike>>()

  constructor(options: UtilityProcessSandboxManagerOptions) {
    if (!options.runnerPath) throw new Error('runnerPath is required')
    this.runnerPath = options.runnerPath
    this.hostCall = options.hostCall
    this.forkOverride = options.fork
    this.readyTimeoutMs = options.readyTimeoutMs ?? 10_000
  }

  /** Each invocation gets a fresh utility process and therefore a fresh QuickJS WASM module. */
  async invoke(untrustedRequest: SandboxInvocationRequest): Promise<JsonValue> {
    const request = parseSandboxInvocationRequest(untrustedRequest)
    if (jsonByteLength(request.input) > request.limits.maxRpcBytes ||
        jsonByteLength(request.context) > request.limits.maxRpcBytes) {
      throw new PluginSupplyChainError('PLUGIN_SANDBOX_RESOURCE_LIMIT', '插件调用参数超过大小限制')
    }
    const fork = this.forkOverride ?? await electronUtilityProcessFork()
    const child = fork(this.runnerPath)
    this.trackChild(request.pluginId, child)
    return new Promise<JsonValue>((resolve, reject) => {
      let settled = false
      let ready = false
      const hostFailures = new Map<string, RecordedHostFailure>()
      const readyTimer = setTimeout(() => fail(new PluginSupplyChainError(
        'PLUGIN_SANDBOX_CRASHED',
        '插件沙箱启动超时'
      )), this.readyTimeoutMs)
      const totalTimer = setTimeout(() => fail(new PluginSupplyChainError(
        'PLUGIN_SANDBOX_RESOURCE_LIMIT',
        '插件运行超过总时间限制'
      )), request.limits.totalTimeoutMs)

      const cleanup = (): void => {
        clearTimeout(readyTimer)
        clearTimeout(totalTimer)
        child.off('message', onMessage)
        child.off('exit', onExit)
        child.off('error', onError)
        this.untrackChild(request.pluginId, child)
        hostFailures.clear()
        child.kill()
      }
      const succeed = (value: JsonValue): void => {
        if (settled) return
        settled = true
        cleanup()
        resolve(value)
      }
      const fail = (error: unknown): void => {
        if (settled) return
        settled = true
        cleanup()
        reject(isPluginSupplyChainError(error) ? error : new PluginSupplyChainError(
          'PLUGIN_SANDBOX_CRASHED',
          '插件沙箱意外停止',
          { cause: error }
        ))
      }
      const onMessage = (untrustedMessage: unknown): void => {
        let message
        try {
          message = parseSandboxChildMessage(untrustedMessage)
        } catch (error) {
          fail(error)
          return
        }
        if (message.type === 'ready') {
          if (ready) return fail(new PluginSupplyChainError(
            'PLUGIN_SANDBOX_PROTOCOL_INVALID',
            '插件沙箱消息无效',
            { cause: new Error('duplicate ready') }
          ))
          ready = true
          clearTimeout(readyTimer)
          child.postMessage(request)
          return
        }
        if (!ready || message.invocationId !== request.invocationId) {
          fail(new PluginSupplyChainError('PLUGIN_SANDBOX_PROTOCOL_INVALID', '插件沙箱消息无效'))
          return
        }
        if (message.type === 'host-call') {
          void this.handleHostCall(child, request, message, hostFailures).catch(fail)
          return
        }
        if (message.type === 'result') {
          if (jsonByteLength(message.value) > request.limits.maxRpcBytes) {
            fail(new PluginSupplyChainError('PLUGIN_SANDBOX_RESOURCE_LIMIT', '插件返回结果超过大小限制'))
            return
          }
          succeed(message.value)
          return
        }
        const diagnostic = message.error.details
          ? sandboxDiagnosticCause(message.error.details)
          : undefined
        const hostFailure = message.error.originCallId
          ? hostFailures.get(message.error.originCallId)
          : undefined
        const code = hostFailure?.code ?? sandboxFailureCode(message.error.code)
        const cause = combineSandboxCauses(hostFailure, diagnostic)
        fail(new PluginSupplyChainError(
          code,
          safeChildMessage(code),
          cause === undefined ? undefined : { cause }
        ))
      }
      const onExit = (_code: number): void => fail(new PluginSupplyChainError(
        'PLUGIN_SANDBOX_CRASHED',
        '插件沙箱意外停止'
      ))
      const onError = (..._args: unknown[]): void => fail(new PluginSupplyChainError(
        'PLUGIN_SANDBOX_CRASHED',
        '插件沙箱启动失败'
      ))

      child.on('message', onMessage)
      child.on('exit', onExit)
      child.on('error', onError)
    })
  }

  terminatePlugin(pluginId: string): void {
    const children = this.activeChildren.get(pluginId)
    if (!children) return
    for (const child of [...children]) child.kill()
  }

  terminateAll(): void {
    for (const pluginId of [...this.activeChildren.keys()]) this.terminatePlugin(pluginId)
  }

  private trackChild(pluginId: string, child: UtilityProcessLike): void {
    const children = this.activeChildren.get(pluginId) ?? new Set<UtilityProcessLike>()
    children.add(child)
    this.activeChildren.set(pluginId, children)
  }

  private untrackChild(pluginId: string, child: UtilityProcessLike): void {
    const children = this.activeChildren.get(pluginId)
    if (!children) return
    children.delete(child)
    if (children.size === 0) this.activeChildren.delete(pluginId)
  }

  private async handleHostCall(
    child: UtilityProcessLike,
    request: SandboxInvocationRequest,
    message: SandboxHostCallMessage,
    hostFailures: Map<string, RecordedHostFailure>
  ): Promise<void> {
    if (!request.allowedOperations.includes(message.operation)) {
      const error = new PluginSupplyChainError(
        'PLUGIN_SANDBOX_PERMISSION_DENIED',
        '插件未获得此操作权限'
      )
      recordHostFailure(hostFailures, message, 'PLUGIN_SANDBOX_PERMISSION_DENIED', error)
      child.postMessage(hostFailure(request, message, 'PLUGIN_SANDBOX_PERMISSION_DENIED', '插件未获得此操作权限'))
      return
    }
    if (jsonByteLength(message.payload) > request.limits.maxRpcBytes) {
      const error = new PluginSupplyChainError(
        'PLUGIN_SANDBOX_RESOURCE_LIMIT',
        '插件请求超过大小限制'
      )
      recordHostFailure(hostFailures, message, 'PLUGIN_SANDBOX_RESOURCE_LIMIT', error)
      child.postMessage(hostFailure(request, message, 'PLUGIN_SANDBOX_RESOURCE_LIMIT', '插件请求超过大小限制'))
      return
    }
    try {
      const value = await this.hostCall(
        { operation: message.operation, payload: message.payload },
        {
          invocationId: request.invocationId,
          pluginId: request.pluginId,
          contributionId: request.contributionId
        }
      )
      if (hostResponseJsonByteLength(message.operation, value) > request.limits.maxRpcBytes) {
        const error = new PluginSupplyChainError(
          'PLUGIN_SANDBOX_RESOURCE_LIMIT',
          '宿主响应超过大小限制'
        )
        recordHostFailure(hostFailures, message, 'PLUGIN_SANDBOX_RESOURCE_LIMIT', error)
        child.postMessage(hostFailure(request, message, 'PLUGIN_SANDBOX_RESOURCE_LIMIT', '宿主响应超过大小限制'))
        return
      }
      child.postMessage({
        protocolVersion: 1,
        type: 'host-result',
        invocationId: request.invocationId,
        callId: message.callId,
        ok: true,
        value
      } satisfies SandboxHostResultMessage)
    } catch (error) {
      const code = isPluginSupplyChainError(error)
        ? sandboxFailureCode(error.code)
        : 'PLUGIN_SANDBOX_FAILED'
      recordHostFailure(hostFailures, message, code, error)
      const safe = isPluginSupplyChainError(error)
        ? { code: error.code, message: error.message }
        : { code: 'HOST_CALL_FAILED', message: '宿主操作失败' }
      child.postMessage(hostFailure(request, message, safe.code, safe.message))
    }
  }
}

function sandboxDiagnosticCause(details: string): Error | null {
  const sanitized = sanitizeSandboxDiagnostic(details)
  if (!sanitized) return null
  const error = new Error(sanitized)
  error.name = 'PluginSandboxDiagnostic'
  return error
}

async function electronUtilityProcessFork(): Promise<UtilityProcessFork> {
  const { utilityProcess } = await import('electron')
  return (modulePath: string) => utilityProcess.fork(modulePath, [], {
    env: { NODE_ENV: 'production' },
    execArgv: [],
    stdio: 'ignore',
    serviceName: 'Streamfold Plugin Sandbox',
    allowLoadingUnsignedLibraries: false,
    respondToAuthRequestsFromMainProcess: false
  }) as UtilityProcess
}

function hostFailure(
  request: SandboxInvocationRequest,
  message: SandboxHostCallMessage,
  code: string,
  text: string
): SandboxHostResultMessage {
  return {
    protocolVersion: 1,
    type: 'host-result',
    invocationId: request.invocationId,
    callId: message.callId,
    ok: false,
    error: { code, message: text }
  }
}

function recordHostFailure(
  failures: Map<string, RecordedHostFailure>,
  message: SandboxHostCallMessage,
  code: SandboxFailureCode,
  cause: unknown
): void {
  failures.set(message.callId, { code, operation: message.operation, cause })
}

function sandboxFailureCode(value: unknown): SandboxFailureCode {
  if (value === 'PLUGIN_SANDBOX_PROTOCOL_INVALID' ||
      value === 'PLUGIN_SANDBOX_PERMISSION_DENIED' ||
      value === 'PLUGIN_SANDBOX_RESOURCE_LIMIT' ||
      value === 'PLUGIN_SANDBOX_CRASHED' ||
      value === 'PLUGIN_SANDBOX_FAILED') return value
  return 'PLUGIN_SANDBOX_FAILED'
}

function combineSandboxCauses(
  hostFailure: RecordedHostFailure | undefined,
  diagnostic: Error | null | undefined
): unknown {
  if (hostFailure && diagnostic) {
    return new AggregateError(
      [hostFailure.cause, diagnostic],
      `插件宿主操作失败：${hostFailure.operation}`
    )
  }
  return hostFailure?.cause ?? diagnostic
}

function safeChildMessage(code: SandboxFailureCode): string {
  if (code === 'PLUGIN_SANDBOX_PROTOCOL_INVALID') return '插件沙箱消息无效'
  if (code === 'PLUGIN_SANDBOX_PERMISSION_DENIED') return '插件未获得此操作权限'
  if (code === 'PLUGIN_SANDBOX_RESOURCE_LIMIT') return '插件超过运行资源限制'
  if (code === 'PLUGIN_SANDBOX_CRASHED') return '插件沙箱意外停止'
  return '插件执行失败'
}
