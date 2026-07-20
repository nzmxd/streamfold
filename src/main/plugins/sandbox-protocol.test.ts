import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SANDBOX_LIMITS,
  MAX_SANDBOX_PLATFORM_RESPONSE_ENTRIES,
  assertHostCallPayload,
  hostResponseJsonByteLength,
  parseSandboxChildMessage,
  parseSandboxHostResult,
  parseSandboxInvocationRequest,
  type JsonObject,
  type SandboxInvocationRequest
} from './sandbox-protocol'

describe('sandbox RPC validation', () => {
  it('accepts bounded typed invocation messages', () => {
    expect(parseSandboxInvocationRequest(request())).toMatchObject({
      type: 'invoke',
      pluginId: 'example.plugin',
      allowedOperations: ['platform.getJson']
    })
  })

  it('rejects oversized quotas, prototypes and undeclared message fields', () => {
    expect(() => parseSandboxInvocationRequest(request({
      limits: { ...DEFAULT_SANDBOX_LIMITS, memoryBytes: 65 * 1024 * 1024 }
    }))).toThrowError(expect.objectContaining({ code: 'PLUGIN_SANDBOX_PROTOCOL_INVALID' }))

    const polluted = Object.create({ inherited: true }) as JsonObject
    polluted.value = true
    expect(() => parseSandboxInvocationRequest(request({ context: polluted })))
      .toThrowError(expect.objectContaining({ code: 'PLUGIN_SANDBOX_PROTOCOL_INVALID' }))

    expect(() => parseSandboxInvocationRequest({ ...request(), extra: true }))
      .toThrowError(expect.objectContaining({ code: 'PLUGIN_SANDBOX_PROTOCOL_INVALID' }))
  })

  it('keeps platform calls on declared endpoint IDs and strips sensitive network headers', () => {
    expect(() => assertHostCallPayload('platform.getJson', {
      endpointId: 'profile.read',
      params: { page: 1 }
    })).not.toThrow()
    expect(() => assertHostCallPayload('platform.getJson', {
      endpointId: 'https://attacker.example',
      params: {}
    })).toThrowError(expect.objectContaining({ code: 'PLUGIN_SANDBOX_PROTOCOL_INVALID' }))
    expect(() => assertHostCallPayload('network.https', {
      url: 'https://hooks.example/events',
      method: 'POST',
      headers: { authorization: 'Bearer secret' },
      body: { ok: true }
    })).toThrowError(expect.objectContaining({ code: 'PLUGIN_SANDBOX_PROTOCOL_INVALID' }))
  })

  it('accepts only bounded origin call IDs on sandbox errors', () => {
    expect(parseSandboxChildMessage({
      protocolVersion: 1,
      type: 'error',
      invocationId: 'invoke_00000001',
      error: {
        code: 'PLUGIN_SANDBOX_FAILED',
        message: '插件执行失败',
        originCallId: 'call_00000001'
      }
    })).toMatchObject({
      type: 'error',
      error: { originCallId: 'call_00000001' }
    })

    expect(() => parseSandboxChildMessage({
      protocolVersion: 1,
      type: 'error',
      invocationId: 'invoke_00000001',
      error: {
        code: 'PLUGIN_SANDBOX_FAILED',
        message: '插件执行失败',
        originCallId: 'bad id'
      }
    })).toThrowError(expect.objectContaining({ code: 'PLUGIN_SANDBOX_PROTOCOL_INVALID' }))
  })

  it('accepts dense host responses without relaxing guest-controlled results', () => {
    const timeline = Array.from({ length: 5_001 }, (_, id) => ({ id }))
    expect(hostResponseJsonByteLength('platform.captureJson', timeline))
      .toBeLessThan(DEFAULT_SANDBOX_LIMITS.maxRpcBytes)
    expect(parseSandboxHostResult({
      protocolVersion: 1,
      type: 'host-result',
      invocationId: 'invoke_00000001',
      callId: 'call_00000001',
      ok: true,
      value: timeline
    })).toMatchObject({ ok: true, value: timeline })

    expect(() => parseSandboxChildMessage({
      protocolVersion: 1,
      type: 'result',
      invocationId: 'invoke_00000001',
      value: timeline
    })).toThrowError(expect.objectContaining({ code: 'PLUGIN_SANDBOX_PROTOCOL_INVALID' }))
    expect(() => hostResponseJsonByteLength('network.https', timeline))
      .toThrowError(expect.objectContaining({ code: 'PLUGIN_SANDBOX_PROTOCOL_INVALID' }))
  })

  it('keeps an independent structural limit on byte-bounded host responses', () => {
    const denseButAllowed = Array.from({ length: 390 }, () => Array.from({ length: 390 }, () => null))
    expect(hostResponseJsonByteLength('platform.captureJson', denseButAllowed))
      .toBeLessThan(DEFAULT_SANDBOX_LIMITS.maxRpcBytes)

    const width = Math.ceil(Math.sqrt(MAX_SANDBOX_PLATFORM_RESPONSE_ENTRIES)) + 1
    const overlyDense = Array.from({ length: width }, () => Array.from({ length: width }, () => null))
    expect(Buffer.byteLength(JSON.stringify(overlyDense), 'utf8'))
      .toBeLessThan(DEFAULT_SANDBOX_LIMITS.maxRpcBytes)
    expect(() => hostResponseJsonByteLength('platform.captureJson', overlyDense))
      .toThrowError(expect.objectContaining({ code: 'PLUGIN_SANDBOX_RESOURCE_LIMIT' }))
  })
})

function request(overrides: Partial<SandboxInvocationRequest> = {}): SandboxInvocationRequest {
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
    limits: { ...DEFAULT_SANDBOX_LIMITS },
    ...overrides
  }
}
