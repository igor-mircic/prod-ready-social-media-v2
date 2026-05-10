import { afterEach, beforeEach, test, expect } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

import { LoginForm } from './LoginForm'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { server } from '../../test/msw-server'
import { AuthProvider, useAuth } from '../auth/AuthContext'
import { __resetClientState } from '../../api/client'

function HomeStub() {
  const auth = useAuth()
  return (
    <div>
      <p>home-route</p>
      <p>token={auth.accessToken ?? 'none'}</p>
      <p>user={auth.currentUser?.displayName ?? 'none'}</p>
    </div>
  )
}

function renderLogin() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/login']}>
        <AuthProvider>
          <Routes>
            <Route path="/login" element={<LoginForm />} />
            <Route path="/home" element={<HomeStub />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  server.resetHandlers()
})

afterEach(() => {
  __resetClientState()
})

test('successful login stores token and navigates to /home', async () => {
  const user = userEvent.setup()
  server.use(
    http.post('*/api/v1/auth/login', () =>
      HttpResponse.json({ accessToken: 'tkn-1', expiresIn: 900 }, { status: 200 }),
    ),
    http.get('*/api/v1/auth/me', ({ request }) => {
      const auth = request.headers.get('Authorization')
      if (auth !== 'Bearer tkn-1') {
        return HttpResponse.json(
          { type: 'about:blank', title: 'Unauthorized', status: 401, detail: 'Authentication required' },
          { status: 401, headers: { 'Content-Type': 'application/problem+json' } },
        )
      }
      return HttpResponse.json(
        {
          id: '00000000-0000-0000-0000-000000000001',
          email: 'alice@example.com',
          displayName: 'Alice',
          createdAt: '2026-01-01T00:00:00Z',
        },
        { status: 200 },
      )
    }),
  )

  renderLogin()

  await user.type(screen.getByLabelText(/email/i), 'alice@example.com')
  await user.type(screen.getByLabelText(/password/i), 'correcthorse')
  await user.click(screen.getByRole('button', { name: /log in/i }))

  await waitFor(() => {
    expect(screen.getByText('home-route')).toBeTruthy()
  })
  expect(screen.getByText('token=tkn-1')).toBeTruthy()
  expect(screen.getByText('user=Alice')).toBeTruthy()
})

test('401 from login renders ProblemDetail.detail and stays on /login', async () => {
  const user = userEvent.setup()
  server.use(
    http.post('*/api/v1/auth/login', () =>
      HttpResponse.json(
        {
          type: 'about:blank',
          title: 'Unauthorized',
          status: 401,
          detail: 'Invalid email or password',
        },
        { status: 401, headers: { 'Content-Type': 'application/problem+json' } },
      ),
    ),
  )

  renderLogin()

  await user.type(screen.getByLabelText(/email/i), 'alice@example.com')
  await user.type(screen.getByLabelText(/password/i), 'wrongpassword')
  await user.click(screen.getByRole('button', { name: /log in/i }))

  await waitFor(() => {
    expect(screen.getByText('Invalid email or password')).toBeTruthy()
  })
  expect(screen.queryByText('home-route')).toBeNull()
})
