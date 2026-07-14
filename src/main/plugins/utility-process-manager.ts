import type { UtilityProcess } from 'electron'
import {
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
          if (ready) return fail(new Error('duplicate ready'))
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
          void this.handleHostCall(child, request, message).catch(fail)
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
        fail(new PluginSupplyChainError(
          isResourceError(message.error.code) ? 'PLUGIN_SANDBOX_RESOURCE_LIMIT' : 'PLUGIN_SANDBOX_FAILED',
          safeChildMessage(message.error.code)
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
    message: SandboxHostCallMessage
  ): Promise<void> {
    if (!request.allowedOperations.includes(message.operation)) {
      child.postMessage(hostFailure(request, message, 'PLUGIN_SANDBOX_PERMISSION_DENIED', '插件未获得此操作权限'))
      return
    }
    if (jsonByteLength(message.payload) > request.limits.maxRpcBytes) {
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
      if (jsonByteLength(value) > request.limits.maxRpcBytes) {
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
      const safe = isPluginSupplyChainError(error)
        ? { code: error.code, message: error.message }
        : { code: 'HOST_CALL_FAILED', message: '宿主操作失败' }
      child.postMessage(hostFailure(request, message, safe.code, safe.message))
    }
  }
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

function isResourceError(code: string): boolean {
  return code === 'PLUGIN_SANDBOX_RESOURCE_LIMIT'
}

function safeChildMessage(code: string): string {
  if (code === 'PLUGIN_SANDBOX_PERMISSION_DENIED') return '插件未获得此操作权限'
  if (code === 'PLUGIN_SANDBOX_RESOURCE_LIMIT') return '插件超过运行资源限制'
  return '插件执行失败'
}
