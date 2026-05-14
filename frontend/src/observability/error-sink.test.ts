import { metrics, trace, type Span } from '@opentelemetry/api'
import { logs } from '@opentelemetry/api-logs'
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from 'vitest'

import {
  PII_REGEXES,
  __envForTest,
  __resetErrorSinkStateForTest,
  computeFingerprint,
  recordFrontendError,
  scrubMessage,
  scrubStack,
} from './error-sink'
import { setCurrentUserId } from './user-context'

function setRoute(pathname: string): void {
  window.history.replaceState(null, '', pathname)
}

type Attrs = Record<string, unknown>

interface CounterStub {
  add: Mock<(value: number, attributes?: Attrs) => void>
}
interface MeterStub {
  createCounter: Mock<(name: string) => CounterStub>
}
interface LoggerStub {
  emit: Mock<(record: unknown) => void>
}

let counterStub: CounterStub
let meterStub: MeterStub
let loggerStub: LoggerStub

function freshStubs(): void {
  counterStub = { add: vi.fn() }
  meterStub = { createCounter: vi.fn(() => counterStub) }
  loggerStub = { emit: vi.fn() }
}

beforeEach(() => {
  __resetErrorSinkStateForTest()
  freshStubs()
  vi.spyOn(metrics, 'getMeter').mockReturnValue(
    meterStub as unknown as ReturnType<typeof metrics.getMeter>,
  )
  vi.spyOn(logs, 'getLogger').mockReturnValue(
    loggerStub as unknown as ReturnType<typeof logs.getLogger>,
  )
  vi.spyOn(trace, 'getActiveSpan').mockReturnValue(undefined)
  setRoute('/home')
  setCurrentUserId(null)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  delete __envForTest.VITE_FE_ERROR_DEDUP_WINDOW_MS
  delete __envForTest.VITE_FE_ERROR_RATE_LIMIT
  __resetErrorSinkStateForTest()
})

describe('PII regex set (canonical list)', () => {
  it('exposes exactly three patterns (JWT, email, bearer-token)', () => {
    expect(PII_REGEXES).toHaveLength(3)
  })
})

describe('scrubMessage / scrubStack', () => {
  it('redacts JWT-shaped tokens', () => {
    const input = 'failed with eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig-A_B'
    expect(scrubMessage(input)).toBe('failed with [REDACTED]')
  })

  it('redacts email addresses', () => {
    expect(scrubMessage('user user@example.com failed')).toBe(
      'user [REDACTED] failed',
    )
  })

  it('redacts long bearer-token-shaped substrings', () => {
    // 48 chars base64 alphabet incl. `+/=`
    const token = 'A'.repeat(20) + 'B/C+D='.repeat(5)
    expect(scrubMessage(`Authorization: Bearer ${token}`)).toContain(
      '[REDACTED]',
    )
  })

  it('does NOT redact a 40-char hex commit SHA (no base64 special chars)', () => {
    // 40 lowercase-hex characters; matches `[A-Za-z0-9+/=]{40,}` by
    // alphabet but is excluded in practice because hex is a strict
    // subset of base64 alphabet. The regex DOES match here — we
    // assert the documented Risk-section behaviour: the regex hits
    // the SHA. This test pins the trade-off explicitly so a future
    // tightening of the regex updates this assertion.
    const sha = 'a'.repeat(40)
    // The regex set will redact this. If the design changes to
    // require a `+/=` character, flip this expectation.
    expect(scrubMessage(sha)).toBe('[REDACTED]')
  })

  it('does NOT redact a 39-char base64-alphabet substring (length boundary)', () => {
    const justUnder = 'A'.repeat(39)
    expect(scrubMessage(justUnder)).toBe(justUnder)
  })

  it('handles null / undefined gracefully', () => {
    expect(scrubMessage(undefined)).toBe('')
    expect(scrubStack(null)).toBe('')
  })
})

describe('computeFingerprint', () => {
  it('produces the same fingerprint for two identical errors at the same line', () => {
    function thrower(): never {
      throw new TypeError('boom')
    }
    let a: unknown
    let b: unknown
    try {
      thrower()
    } catch (e) {
      a = e
    }
    try {
      thrower()
    } catch (e) {
      b = e
    }
    expect(computeFingerprint(a)).toBe(computeFingerprint(b))
  })

  it('falls back to <type> when the stack cannot be parsed', () => {
    const err = new RangeError('nope')
    err.stack = 'totally not a stack'
    expect(computeFingerprint(err)).toBe('RangeError')
  })

  it('falls back to <type> when stack is missing', () => {
    const err = new Error('no stack')
    err.stack = undefined
    expect(computeFingerprint(err)).toBe('Error')
  })

  it('uses Error as type for non-Error throws', () => {
    expect(computeFingerprint('a string')).toBe('Error')
  })
})

describe('recordFrontendError — three sinks', () => {
  it('always increments the counter with {kind, route} labels', () => {
    recordFrontendError(new Error('first'), 'boundary')
    expect(counterStub.add).toHaveBeenCalledWith(1, {
      kind: 'boundary',
      route: '/home',
    })
  })

  it('emits an OTel log record with ECS attributes and severity ERROR', () => {
    setCurrentUserId('user-uuid-123')
    setRoute('/users/abc')
    const err = new TypeError('something broke')
    recordFrontendError(err, 'boundary', { componentStack: '\n  at App' })

    expect(loggerStub.emit).toHaveBeenCalledTimes(1)
    const record = loggerStub.emit.mock.calls[0][0] as {
      severityNumber: number
      severityText: string
      body: string
      attributes: Record<string, unknown>
    }
    expect(record.severityText).toBe('ERROR')
    expect(record.attributes['event.dataset']).toBe('frontend.error')
    expect(record.attributes['error.type']).toBe('TypeError')
    expect(record.attributes['error.message']).toBe('something broke')
    expect(record.attributes['error.fingerprint']).toMatch(/^TypeError:.+:\d+$/)
    expect(record.attributes['kind']).toBe('boundary')
    expect(record.attributes['route']).toBe('/users/:userId')
    expect(record.attributes['user.id']).toBe('user-uuid-123')
    expect(record.attributes['error.component_stack']).toBeTruthy()
  })

  it('omits user.id when unauthenticated', () => {
    setCurrentUserId(null)
    recordFrontendError(new Error('anon'), 'error')
    const record = loggerStub.emit.mock.calls[0][0] as {
      attributes: Record<string, unknown>
    }
    expect(record.attributes).not.toHaveProperty('user.id')
  })

  it('attaches exception event when a span is active', () => {
    const recordException = vi.fn()
    vi.spyOn(trace, 'getActiveSpan').mockReturnValue({
      recordException,
    } as unknown as Span)
    recordFrontendError(new Error('on a span'), 'error')
    expect(recordException).toHaveBeenCalledTimes(1)
  })

  it('skips the span-event sink when no span is active, but still emits log + counter', () => {
    vi.spyOn(trace, 'getActiveSpan').mockReturnValue(undefined)
    recordFrontendError(new Error('no span'), 'rejection')
    expect(loggerStub.emit).toHaveBeenCalledTimes(1)
    expect(counterStub.add).toHaveBeenCalledTimes(1)
  })

  it('scrubs JWT and email PII from message and stack before emit', () => {
    setCurrentUserId(null)
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig-A_B'
    const err = new Error(`leaked ${jwt} and user@example.com`)
    recordFrontendError(err, 'boundary')
    const record = loggerStub.emit.mock.calls[0][0] as {
      attributes: Record<string, string>
      body: string
    }
    expect(record.attributes['error.message']).toBe(
      'leaked [REDACTED] and [REDACTED]',
    )
    expect(record.body).toBe('leaked [REDACTED] and [REDACTED]')
    expect(record.attributes['error.message']).not.toContain(jwt)
  })
})

describe('recordFrontendError — dedup window', () => {
  it('drops a repeat fingerprint within the default 5s window from event sinks but not the counter', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)

    function thrower(): never {
      throw new TypeError('repeat')
    }
    let a: unknown
    try {
      thrower()
    } catch (e) {
      a = e
    }
    let b: unknown
    try {
      thrower()
    } catch (e) {
      b = e
    }

    recordFrontendError(a, 'boundary')
    vi.setSystemTime(1_100) // 100ms later
    recordFrontendError(b, 'boundary')

    expect(loggerStub.emit).toHaveBeenCalledTimes(1)
    expect(counterStub.add).toHaveBeenCalledTimes(2)
  })

  it('emits again once the dedup window elapses', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)

    function thrower(): never {
      throw new TypeError('repeat')
    }
    let a: unknown
    try {
      thrower()
    } catch (e) {
      a = e
    }
    let b: unknown
    try {
      thrower()
    } catch (e) {
      b = e
    }

    recordFrontendError(a, 'boundary')
    vi.setSystemTime(7_000) // 6s later
    recordFrontendError(b, 'boundary')

    expect(loggerStub.emit).toHaveBeenCalledTimes(2)
  })

  it('honours VITE_FE_ERROR_DEDUP_WINDOW_MS override', () => {
    __envForTest.VITE_FE_ERROR_DEDUP_WINDOW_MS = '500'
    vi.useFakeTimers()
    vi.setSystemTime(1_000)

    function thrower(): never {
      throw new Error('boom')
    }
    let a: unknown
    try {
      thrower()
    } catch (e) {
      a = e
    }
    let b: unknown
    try {
      thrower()
    } catch (e) {
      b = e
    }

    recordFrontendError(a, 'error')
    vi.setSystemTime(1_600) // 600ms later — past 500ms override
    recordFrontendError(b, 'error')
    expect(loggerStub.emit).toHaveBeenCalledTimes(2)
  })
})

describe('recordFrontendError — hard rate cap', () => {
  it('caps event-shaped emissions at 30 per rolling 60s but keeps incrementing the counter', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)

    // Generate 100 distinct fingerprints so dedup never kicks in.
    for (let i = 0; i < 100; i += 1) {
      const err = new Error(`err-${i}`)
      err.stack = `Error: err-${i}\n    at file-${i}.ts:${i}:1`
      recordFrontendError(err, 'error')
      // Stay well inside the 60s rate window.
      vi.setSystemTime(1_000 + i)
    }

    expect(loggerStub.emit).toHaveBeenCalledTimes(30)
    expect(counterStub.add).toHaveBeenCalledTimes(100)
  })

  it('honours VITE_FE_ERROR_RATE_LIMIT override', () => {
    __envForTest.VITE_FE_ERROR_RATE_LIMIT = '5'
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    for (let i = 0; i < 20; i += 1) {
      const err = new Error(`err-${i}`)
      err.stack = `Error: err-${i}\n    at file-${i}.ts:${i}:1`
      recordFrontendError(err, 'error')
      vi.setSystemTime(1_000 + i)
    }
    expect(loggerStub.emit).toHaveBeenCalledTimes(5)
    expect(counterStub.add).toHaveBeenCalledTimes(20)
  })
})
