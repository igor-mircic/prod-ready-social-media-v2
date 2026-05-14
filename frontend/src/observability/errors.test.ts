import { logs, type LoggerProvider } from '@opentelemetry/api-logs'
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest'

import { __envForTest, bootstrapErrorReporting } from './errors'

describe('bootstrapErrorReporting', () => {
  let consoleInfoSpy: MockInstance<(typeof console)['info']>
  let setProviderSpy: MockInstance<typeof logs.setGlobalLoggerProvider>

  beforeEach(() => {
    consoleInfoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
    setProviderSpy = vi
      .spyOn(logs, 'setGlobalLoggerProvider')
      .mockImplementation((provider) => provider as LoggerProvider)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete __envForTest.VITE_OTEL_ENABLED
    delete __envForTest.VITE_OTEL_LOGS_ENDPOINT
  })

  it('is a no-op when VITE_OTEL_ENABLED is unset', () => {
    expect(() => bootstrapErrorReporting()).not.toThrow()
    expect(setProviderSpy).not.toHaveBeenCalled()
    expect(consoleInfoSpy).not.toHaveBeenCalled()
  })

  it('registers a LoggerProvider when VITE_OTEL_ENABLED=true', () => {
    __envForTest.VITE_OTEL_ENABLED = 'true'
    __envForTest.VITE_OTEL_LOGS_ENDPOINT = 'http://stub/v1/logs'

    bootstrapErrorReporting()

    expect(setProviderSpy).toHaveBeenCalledTimes(1)
    expect(consoleInfoSpy).toHaveBeenCalledWith(
      'OTel telemetry enabled: logs → http://stub/v1/logs',
    )
  })
})
