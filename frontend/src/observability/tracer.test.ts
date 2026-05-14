import { trace, ProxyTracerProvider } from '@opentelemetry/api'
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest'

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
