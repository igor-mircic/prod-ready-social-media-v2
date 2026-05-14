import { trace, ProxyTracerProvider } from '@opentelemetry/api'
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions'
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest'

import { frontendResource } from './resource'
import { __envForTest, bootstrapTelemetry } from './tracer'

describe('bootstrapTelemetry', () => {
  let consoleInfoSpy: MockInstance<(typeof console)['info']>

  beforeEach(() => {
    consoleInfoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
  })

  afterEach(() => {
    consoleInfoSpy.mockRestore()
    delete __envForTest.VITE_OTEL_ENABLED
    delete __envForTest.VITE_OTEL_TRACES_ENDPOINT
  })

  it('is a no-op when VITE_OTEL_ENABLED is unset', () => {
    expect(() => bootstrapTelemetry()).not.toThrow()
    expect(consoleInfoSpy).not.toHaveBeenCalled()

    const provider = trace.getTracerProvider()
    expect(provider).toBeInstanceOf(ProxyTracerProvider)
    const delegate = (provider as ProxyTracerProvider).getDelegate()
    expect(delegate.constructor.name).toBe('NoopTracerProvider')
  })

  it('logs the enable line exactly once when VITE_OTEL_ENABLED=true', () => {
    __envForTest.VITE_OTEL_ENABLED = 'true'
    __envForTest.VITE_OTEL_TRACES_ENDPOINT = 'http://stub/v1/traces'

    bootstrapTelemetry()

    expect(consoleInfoSpy).toHaveBeenCalledTimes(1)
    expect(consoleInfoSpy).toHaveBeenCalledWith(
      'OTel telemetry enabled: traces → http://stub/v1/traces',
    )
  })

  it('registers a non-noop tracer provider after enabled boot', () => {
    const provider = trace.getTracerProvider()
    expect(provider).toBeInstanceOf(ProxyTracerProvider)
    const delegate = (provider as ProxyTracerProvider).getDelegate()
    expect(delegate.constructor.name).not.toBe('NoopTracerProvider')
  })
})

describe('frontendResource (shared by tracer and meter)', () => {
  // The shared resource module is the single source of truth for
  // `service.name` and `service.version`. Both `tracer.ts` and (slice 6)
  // `meter.ts` import the same instance, so a drift between FE traces
  // and FE metrics on these attributes cannot happen without changing
  // this constant — and this test.
  it('carries service.name="frontend"', () => {
    expect(frontendResource.attributes[ATTR_SERVICE_NAME]).toBe('frontend')
  })

  it('carries the Vite-injected VITE_APP_VERSION as service.version', () => {
    // `vite.config.ts` injects `import.meta.env.VITE_APP_VERSION` from
    // `package.json` at build/test time. The resource module reads that
    // env var (defaulting to `'unknown'` if absent), so the attribute
    // here is a non-empty string and matches whatever the build pipeline
    // resolved — never `undefined`.
    const version = frontendResource.attributes[ATTR_SERVICE_VERSION]
    expect(typeof version).toBe('string')
    expect(version).toBeTruthy()
  })
})
