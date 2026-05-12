import { afterEach, beforeEach, test, expect } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'

import App from './App'
import { QueryProvider } from './api/query-provider'
import { __resetClientState } from './api/client'
import { server } from './test/msw-server'

beforeEach(() => {
  window.history.pushState({}, '', '/')
})

afterEach(() => {
  __resetClientState()
})

test('root redirects unauthenticated users to /login', async () => {
  render(
    <QueryProvider>
      <App />
    </QueryProvider>,
  )
  await waitFor(() => {
    expect(screen.getByRole('heading', { name: /log in/i })).toBeTruthy()
  })
})

test('protected /users/:userId redirects unauthenticated visitors to /login', async () => {
  // Force refresh to fail so the boot leaves the AuthProvider unauthenticated.
  server.use(
    http.post('*/api/v1/auth/refresh', () =>
      HttpResponse.json(
        { type: 'about:blank', title: 'Unauthorized', status: 401 },
        {
          status: 401,
          headers: { 'content-type': 'application/problem+json' },
        },
      ),
    ),
  )

  window.history.pushState(
    {},
    '',
    '/users/11111111-1111-1111-1111-111111111111',
  )
  render(
    <QueryProvider>
      <App />
    </QueryProvider>,
  )
  await waitFor(() => {
    expect(screen.getByRole('heading', { name: /log in/i })).toBeTruthy()
  })
})
