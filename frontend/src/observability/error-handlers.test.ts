import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  __resetInstalledFlagForTest,
  installFrontendErrorHandlers,
} from './error-handlers'

const recordFrontendError = vi.fn()

vi.mock('./error-sink', () => ({
  recordFrontendError: (...args: unknown[]) => recordFrontendError(...args),
}))

describe('installFrontendErrorHandlers', () => {
  beforeEach(() => {
    recordFrontendError.mockReset()
    __resetInstalledFlagForTest()
    installFrontendErrorHandlers()
  })

  afterEach(() => {
    __resetInstalledFlagForTest()
  })

  it('routes window error events to the sink with kind="error"', () => {
    const err = new TypeError('window-error')
    window.dispatchEvent(
      new ErrorEvent('error', {
        error: err,
        message: 'window-error',
        filename: 'src/x.ts',
        lineno: 42,
      }),
    )
    expect(recordFrontendError).toHaveBeenCalledWith(
      err,
      'error',
      expect.objectContaining({ filename: 'src/x.ts', lineno: 42 }),
    )
  })

  it('routes unhandled promise rejection events to the sink with kind="rejection"', () => {
    const reason = new Error('rejected')
    // Don't create a real rejected promise (would itself fire an
    // unhandledrejection); synthesise the event and patch the field
    // the handler reads.
    const ev = new Event('unhandledrejection') as PromiseRejectionEvent
    Object.defineProperty(ev, 'reason', { value: reason })
    window.dispatchEvent(ev)
    expect(recordFrontendError).toHaveBeenCalledWith(reason, 'rejection')
  })

  it('routes securitypolicyviolation events to the sink with kind="csp"', () => {
    const ev = new Event('securitypolicyviolation') as SecurityPolicyViolationEvent
    // SecurityPolicyViolationEvent is not constructible in jsdom; patch
    // the fields the handler reads.
    Object.defineProperty(ev, 'violatedDirective', { value: 'script-src' })
    Object.defineProperty(ev, 'blockedURI', { value: 'inline' })
    window.dispatchEvent(ev)

    expect(recordFrontendError).toHaveBeenCalledTimes(1)
    const [err, kind, ctx] = recordFrontendError.mock.calls[0]
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toBe('script-src')
    expect(kind).toBe('csp')
    expect(ctx).toEqual({ blockedURI: 'inline' })
  })

  it('is idempotent — calling twice does not duplicate listeners', () => {
    installFrontendErrorHandlers() // second call should be a no-op
    const err = new Error('once')
    window.dispatchEvent(new ErrorEvent('error', { error: err, message: 'once' }))
    expect(recordFrontendError).toHaveBeenCalledTimes(1)
  })
})
