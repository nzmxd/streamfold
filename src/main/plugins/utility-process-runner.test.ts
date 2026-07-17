import { describe, expect, it } from 'vitest'
import { PluginSupplyChainError } from './supply-chain-errors'
import { __utilityProcessRunnerTest } from './utility-process-runner'

describe('utility process runner host-call diagnostics', () => {
  it('propagates the rejected host call ID and sandbox code', () => {
    const failure = __utilityProcessRunnerTest.withOriginCallId(
      new PluginSupplyChainError(
        'PLUGIN_SANDBOX_PERMISSION_DENIED',
        '插件未获得此操作权限'
      ),
      'call_00000001'
    )

    expect(__utilityProcessRunnerTest.safeRunnerError(failure)).toMatchObject({
      code: 'PLUGIN_SANDBOX_PERMISSION_DENIED',
      originCallId: 'call_00000001'
    })
  })

  it('downgrades non-sandbox codes without losing a valid origin call ID', () => {
    const failure = __utilityProcessRunnerTest.withOriginCallId(
      new PluginSupplyChainError('PLUGIN_PACKAGE_INVALID', '包错误'),
      'call_00000002'
    )

    expect(__utilityProcessRunnerTest.safeRunnerError(failure)).toMatchObject({
      code: 'PLUGIN_SANDBOX_FAILED',
      originCallId: 'call_00000002'
    })
  })
})
