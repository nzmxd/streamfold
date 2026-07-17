import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_SANDBOX_LIMITS, type SandboxInvocationRequest } from './sandbox-protocol'
import {
  UtilityProcessSandboxManager,
  type UtilityProcessLike
} from './utility-process-manager'

class FakeUtilityProcess extends EventEmitter implements UtilityProcessLike {
  killed = false
  readonly posted: unknown[] = []
  onPost: (message: unknown) => void = () => undefined

  postMessage(message: unknown): void {
    this.posted.push(message)
    this.onPost(message)
  }

  kill(): boolean {
    this.killed = true
    queueMicrotask(() => this.emit('exit', 0))
    return true
  }
}

describe('utility process sandbox manager', () => {
  it('routes validated host calls and disposes the one-shot child after success', async () => {
    const child = new FakeUtilityProcess()
    const hostCall = vi.fn(async () => ({ id: 'self' }))
    child.onPost = (message) => {
      const record = message as Record<string, unknown>
      if (record.type === 'invoke') {
        child.emit('message', {
          protocolVersion: 1,
          type: 'host-call',
          invocationId: 'invoke_00000001',
          callId: 'call_00000001',
          operation: 'platform.getJson',
          payload: { endpointId: 'profile.read', params: {} }
        })
      } else if (record.type === 'host-result') {
        child.emit('message', {
          protocolVersion: 1,
          type: 'result',
          invocationId: 'invoke_00000001',
          value: { done: true }
        })
      }
    }
    const manager = new UtilityProcessSandboxManager({
      runnerPath: 'runner.js',
      fork: () => child,
      hostCall
    })
    queueMicrotask(() => child.emit('message', { protocolVersion: 1, type: 'ready' }))

    await expect(manager.invoke(request())).resolves.toEqual({ done: true })
    expect(hostCall).toHaveBeenCalledOnce()
    expect(child.killed).toBe(true)
  })

  it('rejects malformed child messages without invoking the host', async () => {
    const child = new FakeUtilityProcess()
    const hostCall = vi.fn(async () => null)
    child.onPost = () => child.emit('message', { type: 'result', value: { unsafe: true } })
    const manager = new UtilityProcessSandboxManager({
      runnerPath: 'runner.js',
      fork: () => child,
      hostCall
    })
    queueMicrotask(() => child.emit('message', { protocolVersion: 1, type: 'ready' }))

    await expect(manager.invoke(request())).rejects.toMatchObject({
      code: 'PLUGIN_SANDBOX_PROTOCOL_INVALID'
    })
    expect(hostCall).not.toHaveBeenCalled()
    expect(child.killed).toBe(true)
  })

  it('preserves a bounded result marker and exposes credential-redacted plugin diagnostics', async () => {
    const successChild = new FakeUtilityProcess()
    successChild.onPost = (message) => {
      if ((message as Record<string, unknown>).type !== 'invoke') return
      successChild.emit('message', {
        protocolVersion: 1,
        type: 'result',
        invocationId: 'invoke_00000001',
        value: { __streamfoldFailure: 'X_IDENTITY_SETTINGS_EMPTY' }
      })
    }
    const successManager = new UtilityProcessSandboxManager({
      runnerPath: 'runner.js',
      fork: () => successChild,
      hostCall: async () => null
    })
    queueMicrotask(() => successChild.emit('message', { protocolVersion: 1, type: 'ready' }))
    await expect(successManager.invoke(request())).resolves.toEqual({
      __streamfoldFailure: 'X_IDENTITY_SETTINGS_EMPTY'
    })

    const failureChild = new FakeUtilityProcess()
    failureChild.onPost = (message) => {
      if ((message as Record<string, unknown>).type !== 'invoke') return
      failureChild.emit('message', {
        protocolVersion: 1,
        type: 'error',
        invocationId: 'invoke_00000001',
        error: {
          code: 'PLUGIN_SANDBOX_FAILED',
          message: 'sensitive guest text',
          details: [
            'Error: UserTweets.timeline.instructions 缺失',
            '    at parseTimelineResponse (streamfold:streamfold.x/streamfold.x.platform.js:314:9)',
            'Cookie: auth_token=private-cookie',
            'authorization: Bearer private-bearer'
          ].join('\n')
        }
      })
    }
    const failureManager = new UtilityProcessSandboxManager({
      runnerPath: 'runner.js',
      fork: () => failureChild,
      hostCall: async () => null
    })
    queueMicrotask(() => failureChild.emit('message', { protocolVersion: 1, type: 'ready' }))
    let failure: unknown
    try {
      await failureManager.invoke(request())
    } catch (error) {
      failure = error
    }
    expect(failure).toMatchObject({
      code: 'PLUGIN_SANDBOX_FAILED',
      message: '插件执行失败'
    })
    const diagnostic = String((failure as Error & { cause?: Error }).cause?.message ?? '')
    expect(diagnostic).toContain('parseTimelineResponse')
    expect(diagnostic).toContain('streamfold.x.platform.js:314:9')
    expect(diagnostic).not.toContain('private-cookie')
    expect(diagnostic).not.toContain('private-bearer')
  })

  it.each([
    'PLUGIN_SANDBOX_PROTOCOL_INVALID',
    'PLUGIN_SANDBOX_PERMISSION_DENIED',
    'PLUGIN_SANDBOX_RESOURCE_LIMIT',
    'PLUGIN_SANDBOX_CRASHED',
    'PLUGIN_SANDBOX_FAILED'
  ] as const)('preserves the child sandbox code %s', async (code) => {
    const child = new FakeUtilityProcess()
    child.onPost = (message) => {
      if ((message as Record<string, unknown>).type !== 'invoke') return
      child.emit('message', {
        protocolVersion: 1,
        type: 'error',
        invocationId: 'invoke_00000001',
        error: { code, message: 'safe child message' }
      })
    }
    const manager = new UtilityProcessSandboxManager({
      runnerPath: 'runner.js',
      fork: () => child,
      hostCall: async () => null
    })
    queueMicrotask(() => child.emit('message', { protocolVersion: 1, type: 'ready' }))

    await expect(manager.invoke(request())).rejects.toMatchObject({ code })
  })

  it('associates an out-of-order concurrent host rejection by call ID', async () => {
    const child = new FakeUtilityProcess()
    const firstFailure = new Error('first host failure')
    const secondFailure = new Error('second host failure')
    const returnedFailures = new Set<string>()
    child.onPost = (message) => {
      const record = message as Record<string, unknown>
      if (record.type === 'invoke') {
        child.emit('message', {
          protocolVersion: 1,
          type: 'host-call',
          invocationId: 'invoke_00000001',
          callId: 'call_00000001',
          operation: 'platform.getJson',
          payload: { endpointId: 'first.read', params: {} }
        })
        child.emit('message', {
          protocolVersion: 1,
          type: 'host-call',
          invocationId: 'invoke_00000001',
          callId: 'call_00000002',
          operation: 'platform.getJson',
          payload: { endpointId: 'second.read', params: {} }
        })
        return
      }
      if (record.type !== 'host-result' || record.ok !== false || typeof record.callId !== 'string') return
      returnedFailures.add(record.callId)
      if (returnedFailures.size === 2) {
        queueMicrotask(() => child.emit('message', {
          protocolVersion: 1,
          type: 'error',
          invocationId: 'invoke_00000001',
          error: {
            code: 'PLUGIN_SANDBOX_FAILED',
            message: '插件执行失败',
            originCallId: 'call_00000001'
          }
        }))
      }
    }
    const manager = new UtilityProcessSandboxManager({
      runnerPath: 'runner.js',
      fork: () => child,
      hostCall: async (call) => {
        if (call.payload.endpointId === 'first.read') throw firstFailure
        throw secondFailure
      }
    })
    queueMicrotask(() => child.emit('message', { protocolVersion: 1, type: 'ready' }))

    let failure: unknown
    try {
      await manager.invoke(request())
    } catch (error) {
      failure = error
    }

    expect(failure).toMatchObject({ code: 'PLUGIN_SANDBOX_FAILED', cause: firstFailure })
    expect((failure as Error & { cause?: unknown }).cause).not.toBe(secondFailure)
  })

  it('terminates every active invocation belonging to a disabled plugin', async () => {
    const first = new FakeUtilityProcess()
    const second = new FakeUtilityProcess()
    const children = [first, second]
    const manager = new UtilityProcessSandboxManager({
      runnerPath: 'runner.js',
      fork: () => children.shift()!,
      hostCall: async () => null
    })
    const firstRequest = request()
    const secondRequest = { ...request(), invocationId: 'invoke_00000002' }
    const firstRun = manager.invoke(firstRequest)
    const secondRun = manager.invoke(secondRequest)
    queueMicrotask(() => {
      first.emit('message', { protocolVersion: 1, type: 'ready' })
      second.emit('message', { protocolVersion: 1, type: 'ready' })
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    manager.terminatePlugin('example.plugin')

    await expect(firstRun).rejects.toMatchObject({ code: 'PLUGIN_SANDBOX_CRASHED' })
    await expect(secondRun).rejects.toMatchObject({ code: 'PLUGIN_SANDBOX_CRASHED' })
    expect(first.killed).toBe(true)
    expect(second.killed).toBe(true)
  })
})

function request(): SandboxInvocationRequest {
  return {
    protocolVersion: 1,
    type: 'invoke',
    invocationId: 'invoke_00000001',
    pluginId: 'example.plugin',
    contributionId: 'example.action',
    entrySource: 'module.exports = { run() { return null } }',
    method: 'run',
    input: null,
    context: {},
    allowedOperations: ['platform.getJson'],
    limits: { ...DEFAULT_SANDBOX_LIMITS }
  }
}
