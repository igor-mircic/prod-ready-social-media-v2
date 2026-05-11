import { afterEach, beforeEach, test, expect } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'

import { server } from '../../test/msw-server'
import { AuthProvider, useAuth } from './AuthContext'
import { __resetClientState } from '../../api/client'

function ExposeAuth() {
  const { currentUser, booting, accessToken } = useAuth()
  return (
    <div>
      <p>booting={booting ? 'true' : 'false'}</p>
      <p>user={currentUser?.displayName ?? 'none'}</p>
      <p>token={accessToken ?? 'none'}</p>
    </div>
  )
}

beforeEach(() => {
  server.resetHandlers()
})

afterEach(() => {
  __resetClientState()
})

test('successful boot-time hydration populates currentUser and clears booting', async () => {
  let refreshHits = 0
  let meHits = 0
  server.use(
    http.post('*/api/v1/auth/refresh', () => {
      refreshHits += 1
      return HttpResponse.json({ accessToken: 'boot-token', expiresIn: 900 }, { status: 200 })
    }),
    http.get('*/api/v1/auth/me', ({ request }) => {
      meHits += 1
      const auth = request.headers.get('Authorization')
      if (auth !== 'Bearer boot-token') {
        return HttpResponse.json(
          { type: 'about:blank', title: 'Unauthorized', status: 401, detail: 'no token' },
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

  render(
    <AuthProvider>
      <ExposeAuth />
    </AuthProvider>,
  )

  expect(screen.getByText('booting=true')).toBeTruthy()

  await waitFor(() => {
    expect(screen.getByText('booting=false')).toBeTruthy()
  })
  expect(screen.getByText('user=Alice')).toBeTruthy()
  expect(screen.getByText('token=boot-token')).toBeTruthy()
  expect(refreshHits).toBe(1)
  expect(meHits).toBe(1)
})

test('failed boot-time refresh leaves SPA unauthenticated and does not call /me', async () => {
  let refreshHits = 0
  let meHits = 0
  server.use(
    http.post('*/api/v1/auth/refresh', () => {
      refreshHits += 1
      return HttpResponse.json(
        { type: 'about:blank', title: 'Unauthorized', status: 401, detail: 'no refresh' },
        { status: 401, headers: { 'Content-Type': 'application/problem+json' } },
      )
    }),
    http.get('*/api/v1/auth/me', () => {
      meHits += 1
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

  render(
    <AuthProvider>
      <ExposeAuth />
    </AuthProvider>,
  )

  await waitFor(() => {
    expect(screen.getByText('booting=false')).toBeTruthy()
  })
  expect(screen.getByText('user=none')).toBeTruthy()
  expect(screen.getByText('token=none')).toBeTruthy()
  expect(refreshHits).toBe(1)
  expect(meHits).toBe(0)
})
