import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  consumeErrorReportContext,
  markErrorReported,
  setErrorReporter,
  wasErrorReported
} from './error-reporting'

describe('error reporting deduplication', () => {
  afterEach(() => setErrorReporter(null))

  it('marks error objects without treating primitive messages as shared failures', () => {
    const error = new Error('failed')
    expect(wasErrorReported(error)).toBe(false)
    markErrorReported(error)
    expect(wasErrorReported(error)).toBe(true)
    markErrorReported('failed')
    expect(wasErrorReported('failed')).toBe(false)
  })

  it('reports an original error once with diagnostic metadata before marking it handled', () => {
    const reporter = vi.fn()
    const error = new Error('failed')
    setErrorReporter(reporter)

    markErrorReported(error, { scope: 'sync', context: { jobId: 'job-1' } })
    markErrorReported(error, { scope: 'ipc' })

    expect(reporter).toHaveBeenCalledOnce()
    expect(reporter).toHaveBeenCalledWith(error, {
      scope: 'sync',
      context: { jobId: 'job-1' }
    })
    expect(wasErrorReported(error)).toBe(true)
    expect(consumeErrorReportContext('jobId', 'job-1')).toBe(true)
    expect(consumeErrorReportContext('jobId', 'job-1')).toBe(false)
  })

  it('reports primitive rejections and associates them with background runs', () => {
    const reporter = vi.fn()
    setErrorReporter(reporter)

    markErrorReported('primitive failure', {
      scope: 'plugin',
      context: { runId: 'run-primitive' }
    })

    expect(reporter).toHaveBeenCalledWith('primitive failure', {
      scope: 'plugin',
      context: { runId: 'run-primitive' }
    })
    expect(wasErrorReported('primitive failure')).toBe(false)
    expect(consumeErrorReportContext('runId', 'run-primitive')).toBe(true)
  })

  it('reports a reused Error again for a later task', async () => {
    const reporter = vi.fn()
    const error = new Error('retry failure')
    setErrorReporter(reporter)
    markErrorReported(error, { scope: 'plugin', context: { runId: 'run-1' } })
    expect(consumeErrorReportContext('runId', 'run-1')).toBe(true)

    await new Promise((resolve) => setTimeout(resolve, 5))
    markErrorReported(error, { scope: 'plugin', context: { runId: 'run-2' } })

    expect(reporter).toHaveBeenCalledTimes(2)
    expect(consumeErrorReportContext('runId', 'run-2')).toBe(true)
  })
})
