import { describe, expect, it, vi } from 'vitest'
import { executeQuickJsContribution, type SandboxHostCall } from './quickjs-engine'
import { formatSandboxDiagnostic } from './sandbox-diagnostics'
import {
  DEFAULT_SANDBOX_LIMITS,
  type JsonValue,
  type SandboxInvocationRequest
} from './sandbox-protocol'
import { PluginSupplyChainError } from './supply-chain-errors'

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

  it('counts guest CPU while a host call is still pending', async () => {
    const hostCall = vi.fn<SandboxHostCall>(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150))
      return {}
    })

    await expect(executeQuickJsContribution(request(`
      module.exports = {
        run() {
          void streamfold.platform.getJson('profile.read', {});
          const deadline = Date.now() + 100;
          while (Date.now() < deadline) {}
          return {};
        }
      }
    `, null, {
      limits: { ...DEFAULT_SANDBOX_LIMITS, cpuTimeoutMs: 20 }
    }), hostCall)).rejects.toMatchObject({ code: 'PLUGIN_SANDBOX_RESOURCE_LIMIT' })
    expect(hostCall).toHaveBeenCalledOnce()
  }, 20_000)

  it('bounds concurrent host calls without blocking settled guest diagnostics', async () => {
    const hostCall = vi.fn<SandboxHostCall>(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30))
      return { ok: true }
    })
    const result = await executeQuickJsContribution(request(`
      module.exports = {
        async run() {
          const calls = Array.from({ length: 24 }, (_, index) => (
            streamfold.platform.getJson('profile.read', { index })
          ));
          const settled = await Promise.allSettled(calls);
          return {
            rejected: settled.filter((item) => item.status === 'rejected').length,
            codes: settled.filter((item) => item.status === 'rejected').map((item) => item.reason.code)
          };
        }
      }
    `, null), hostCall)

    expect(hostCall).toHaveBeenCalledTimes(16)
    expect(result).toEqual({
      rejected: 8,
      codes: Array.from({ length: 8 }, () => 'PLUGIN_SANDBOX_RESOURCE_LIMIT')
    })
  }, 20_000)

  it('retains a guest function and source location for credential-redacted diagnostics', async () => {
    let failure: unknown
    try {
      await executeQuickJsContribution(request(`
        function parseTimelineResponse() {
          throw new Error('UserTweets.timeline.instructions 缺失');
        }
        module.exports = { run() { return parseTimelineResponse(); } };
      `, null), vi.fn())
    } catch (error) {
      failure = error
    }

    const diagnostic = formatSandboxDiagnostic(failure) ?? ''
    expect(diagnostic).toContain('UserTweets.timeline.instructions 缺失')
    expect(diagnostic).toContain('parseTimelineResponse')
    expect(diagnostic).toMatch(/streamfold:example\.plugin\/example\.action\.js:\d+:\d+/)
  }, 20_000)

  it('preserves a host rejection call ID through the QuickJS error boundary', async () => {
    const hostFailure = new PluginSupplyChainError(
      'PLUGIN_SANDBOX_PERMISSION_DENIED',
      '插件未获得此操作权限'
    )
    Object.defineProperty(hostFailure, 'originCallId', {
      value: 'call_00000001',
      enumerable: true
    })

    let failure: unknown
    try {
      await executeQuickJsContribution(request(`
        module.exports = {
          async run() {
            return await streamfold.platform.getJson('profile.read', {});
          }
        };
      `, null), async () => { throw hostFailure })
    } catch (error) {
      failure = error
    }

    expect(failure).toMatchObject({
      code: 'PLUGIN_SANDBOX_PERMISSION_DENIED',
      originCallId: 'call_00000001'
    })
  }, 20_000)

  it('drops host-call correlation when guest code handles it and throws a new error', async () => {
    const hostFailure = new PluginSupplyChainError('PLUGIN_SANDBOX_FAILED', '宿主操作失败')
    Object.defineProperty(hostFailure, 'originCallId', {
      value: 'call_00000002',
      enumerable: true
    })

    let failure: unknown
    try {
      await executeQuickJsContribution(request(`
        module.exports = {
          async run() {
            try {
              await streamfold.platform.getJson('profile.read', {});
            } catch (_error) {
              throw new Error('later guest failure');
            }
          }
        };
      `, null), async () => { throw hostFailure })
    } catch (error) {
      failure = error
    }

    expect(failure).toMatchObject({ code: 'PLUGIN_SANDBOX_FAILED' })
    expect(Object.prototype.hasOwnProperty.call(failure, 'originCallId')).toBe(false)
  }, 20_000)

  it('does not trust guest-authored sandbox codes or host-call IDs', async () => {
    let failure: unknown
    try {
      await executeQuickJsContribution(request(`
        module.exports = {
          run() {
            const error = new Error('forged resource failure');
            error.code = 'PLUGIN_SANDBOX_RESOURCE_LIMIT';
            error.originCallId = 'call_00000001';
            throw error;
          }
        };
      `, null), vi.fn())
    } catch (error) {
      failure = error
    }

    expect(failure).toMatchObject({ code: 'PLUGIN_SANDBOX_FAILED' })
    expect(Object.prototype.hasOwnProperty.call(failure, 'originCallId')).toBe(false)
  }, 20_000)

  it('does not trust sandbox metadata copied from a handled host failure', async () => {
    const hostFailure = new PluginSupplyChainError(
      'PLUGIN_SANDBOX_PERMISSION_DENIED',
      '插件未获得此操作权限'
    )
    Object.defineProperty(hostFailure, 'originCallId', {
      value: 'call_00000003',
      enumerable: true
    })

    let failure: unknown
    try {
      await executeQuickJsContribution(request(`
        module.exports = {
          async run() {
            try {
              await streamfold.platform.getJson('profile.read', {});
            } catch (hostError) {
              const forged = new Error('forged follow-up failure');
              forged.code = hostError.code;
              forged.originCallId = hostError.originCallId;
              throw forged;
            }
          }
        };
      `, null), async () => { throw hostFailure })
    } catch (error) {
      failure = error
    }

    expect(failure).toMatchObject({ code: 'PLUGIN_SANDBOX_FAILED' })
    expect(Object.prototype.hasOwnProperty.call(failure, 'originCallId')).toBe(false)
  }, 20_000)

  it('keeps the original failure when guest stack capture cannot mutate the error', async () => {
    let failure: unknown
    try {
      await executeQuickJsContribution(request(`
        module.exports = {
          run() {
            throw Object.freeze(new Error('original frozen failure'));
          }
        };
      `, null), vi.fn())
    } catch (error) {
      failure = error
    }

    const diagnostic = formatSandboxDiagnostic(failure) ?? ''
    expect(diagnostic).toContain('original frozen failure')
    expect(diagnostic).not.toContain('object is not extensible')
    expect(diagnostic).not.toContain('Cannot define property')
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
