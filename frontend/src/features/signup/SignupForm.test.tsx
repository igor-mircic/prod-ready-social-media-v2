import { test, expect, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'

import { SignupForm } from './SignupForm'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { server } from '../../test/msw-server'

function renderWithClient() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <SignupForm />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  server.resetHandlers()
})

test('successful signup renders success state', async () => {
  const user = userEvent.setup()
  server.use(
    http.post('*/api/v1/auth/signup', () =>
      HttpResponse.json(
        {
          id: '00000000-0000-0000-0000-000000000001',
          email: 'alice@example.com',
          displayName: 'Alice',
          createdAt: '2026-01-01T00:00:00Z',
        },
        { status: 201 },
      ),
    ),
  )

  renderWithClient()

  await user.type(screen.getByLabelText(/email/i), 'alice@example.com')
  await user.type(screen.getByLabelText(/password/i), 'correcthorse')
  await user.type(screen.getByLabelText(/display name/i), 'Alice')
  await user.click(screen.getByRole('button', { name: /sign up/i }))

  await waitFor(() => {
    expect(screen.getByText(/account created/i)).toBeTruthy()
  })
  expect(screen.getByText(/welcome, alice/i)).toBeTruthy()
})

test('409 conflict renders ProblemDetail.detail', async () => {
  const user = userEvent.setup()
  server.use(
    http.post('*/api/v1/auth/signup', () =>
      HttpResponse.json(
        {
          type: 'about:blank',
          title: 'Email already registered',
          status: 409,
          detail: 'Email already registered: alice@example.com',
        },
        { status: 409, headers: { 'Content-Type': 'application/problem+json' } },
      ),
    ),
  )

  renderWithClient()

  await user.type(screen.getByLabelText(/email/i), 'alice@example.com')
  await user.type(screen.getByLabelText(/password/i), 'correcthorse')
  await user.type(screen.getByLabelText(/display name/i), 'Alice')
  await user.click(screen.getByRole('button', { name: /sign up/i }))

  await waitFor(() => {
    expect(
      screen.getByText('Email already registered: alice@example.com'),
    ).toBeTruthy()
  })
})

test('client-side validation blocks submit and does not call the server', async () => {
  const user = userEvent.setup()
  let serverHit = false
  server.use(
    http.post('*/api/v1/auth/signup', () => {
      serverHit = true
      return HttpResponse.json({}, { status: 201 })
    }),
  )

  renderWithClient()

  await user.type(screen.getByLabelText(/email/i), 'not-an-email')
  await user.type(screen.getByLabelText(/password/i), 'short')
  await user.type(screen.getByLabelText(/display name/i), 'Alice')
  await user.click(screen.getByRole('button', { name: /sign up/i }))

  await waitFor(() => {
    expect(screen.getAllByRole('alert').length).toBeGreaterThan(0)
  })

  // Wait briefly to ensure no async fetch fired.
  await new Promise((r) => setTimeout(r, 30))
  expect(serverHit).toBe(false)
})
