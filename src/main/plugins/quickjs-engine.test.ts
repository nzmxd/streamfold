import { describe, expect, it, vi } from 'vitest'
import { executeQuickJsContribution, type SandboxHostCall } from './quickjs-engine'
import {
  DEFAULT_SANDBOX_LIMITS,
  type JsonValue,
  type SandboxInvocationRequest
} from './sandbox-protocol'

describe('QuickJS plugin engine', () => {
  it('runs a contribution without exposing Node, browser or network globals', async () => {
    const result = await executeQuickJsContribution(request(`
      module.exports = {
        run(_context, input) {
          return {
            value: input.value + 1,
            processType: typeof process,
            requireType: typeof require,
            fetchType: typeof fetch,
            documentType: typeof document
          }
        }
      }
    `, { value: 41 }), vi.fn())

    expect(result).toEqual({
      value: 42,
      processType: 'undefined',
      requireType: 'undefined',
      fetchType: 'undefined',
      documentType: 'undefined'
    })
  }, 20_000)

  it('exposes only the typed host proxy selected for the invocation', async () => {
    const hostCall = vi.fn<SandboxHostCall>(async (_operation, payload): Promise<JsonValue> => {
      if (payload.endpointId === 'profile.read') return { profile: { id: 'self' } }
      return { metrics: { followers: 42 } }
    })
    const result = await executeQuickJsContribution(request(`
      module.exports = {
        async run() {
          const profile = await streamfold.platform.getJson('profile.read', { include: 'metrics' });
          const metrics = await streamfold.platform.getJson('metrics.read', {});
          return { ...profile, ...metrics };
        }
      }
    `, null), hostCall)

    expect(result).toEqual({ profile: { id: 'self' }, metrics: { followers: 42 } })
    expect(hostCall).toHaveBeenNthCalledWith(1, 'platform.getJson', {
      endpointId: 'profile.read',
      params: { include: 'metrics' }
    })
    expect(hostCall).toHaveBeenNthCalledWith(2, 'platform.getJson', {
      endpointId: 'metrics.read',
      params: {}
    })
  }, 20_000)

  it('interrupts guest CPU loops', async () => {
    await expect(executeQuickJsContribution(request(`
      module.exports = { run() { while (true) {} } }
    `, null, {
      limits: { ...DEFAULT_SANDBOX_LIMITS, cpuTimeoutMs: 20 }
    }), vi.fn())).rejects.toMatchObject({ code: 'PLUGIN_SANDBOX_RESOURCE_LIMIT' })
  }, 20_000)
})

function request(
  entrySource: string,
  input: SandboxInvocationRequest['input'],
  overrides: Partial<SandboxInvocationRequest> = {}
): SandboxInvocationRequest {
  return {
    protocolVersion: 1,
    type: 'invoke',
    invocationId: 'invoke_00000001',
    pluginId: 'example.plugin',
    contributionId: 'example.action',
    entrySource,
    method: 'run',
    input,
    context: { pluginId: 'example.plugin' },
    allowedOperations: ['platform.getJson'],
    limits: { ...DEFAULT_SANDBOX_LIMITS },
    ...overrides
  }
}
