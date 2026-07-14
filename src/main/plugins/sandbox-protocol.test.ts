import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SANDBOX_LIMITS,
  assertHostCallPayload,
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
