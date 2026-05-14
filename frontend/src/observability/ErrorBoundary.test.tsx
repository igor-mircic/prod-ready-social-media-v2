import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FrontendErrorBoundary } from './ErrorBoundary'

const recordFrontendError = vi.fn()

vi.mock('./error-sink', () => ({
  recordFrontendError: (...args: unknown[]) => recordFrontendError(...args),
}))

function Thrower(): never {
  throw new TypeError('boundary-test')
}

describe('FrontendErrorBoundary', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    recordFrontendError.mockReset()
    // React 19 logs caught errors to console.error in dev — suppress
    // the noise so test output stays scannable.
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    errorSpy.mockRestore()
  })

  it('renders children when no error', () => {
    render(
      <FrontendErrorBoundary>
        <span>healthy</span>
      </FrontendErrorBoundary>,
    )
    expect(screen.getByText('healthy')).toBeInTheDocument()
  })

  it('catches a thrown child and calls the sink with kind="boundary"', () => {
    render(
      <FrontendErrorBoundary>
        <Thrower />
      </FrontendErrorBoundary>,
    )

    expect(recordFrontendError).toHaveBeenCalledTimes(1)
    const [err, kind, ctx] = recordFrontendError.mock.calls[0]
    expect(err).toBeInstanceOf(TypeError)
    expect((err as Error).message).toBe('boundary-test')
    expect(kind).toBe('boundary')
    expect(ctx).toMatchObject({ componentStack: expect.any(String) })
  })

  it('renders the fallback UI after catching', () => {
    render(
      <FrontendErrorBoundary>
        <Thrower />
      </FrontendErrorBoundary>,
    )
    expect(
      screen.getByRole('heading', { name: /Something went wrong/i }),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Refresh/i })).toBeInTheDocument()
  })
})
