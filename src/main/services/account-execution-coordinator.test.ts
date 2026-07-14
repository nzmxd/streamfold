import { describe, expect, it } from 'vitest'
import {
  AccountExecutionBusyError,
  AccountExecutionCoordinator
} from './account-execution-coordinator'

describe('AccountExecutionCoordinator', () => {
  it('rejects a concurrent owner of the same account', async () => {
    const coordinator = new AccountExecutionCoordinator()
    let release!: () => void
    const running = coordinator.run('account-1', async () => {
      await new Promise<void>((resolve) => { release = resolve })
    })

    await expect(coordinator.run('account-1', async () => undefined))
      .rejects.toBeInstanceOf(AccountExecutionBusyError)
    release()
    await running
    expect(coordinator.isActive('account-1')).toBe(false)
  })

  it('allows a nested platform sync to reuse the plugin task account lock', async () => {
    const coordinator = new AccountExecutionCoordinator()
    const steps: string[] = []

    await coordinator.run('account-1', async () => {
      steps.push('plugin')
      await coordinator.run('account-1', async () => { steps.push('platform') })
    })

    expect(steps).toEqual(['plugin', 'platform'])
  })
})
