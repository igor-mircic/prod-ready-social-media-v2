import { afterEach, beforeEach, test, expect } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom'
import { useEffect, type ReactNode } from 'react'

import { server } from '../../test/msw-server'
import { AuthProvider, useAuth } from './AuthContext'
import { __resetClientState, apiFetch } from '../../api/client'

interface CallResult {
  status: number
  data: unknown
}

function CallProtected({
  initialToken,
  onResults,
  fireCount = 1,
}: {
  initialToken: string
  onResults: (results: CallResult[]) => void
  fireCount?: number
}) {
  const auth = useAuth()
  useEffect(() => {
    auth.login(initialToken, {
      id: 'u1',
      email: 'a@b.c',
      displayName: 'Alice',
      createdAt: '2026-01-01T00:00:00Z',
    })
    const fire = async () => {
      const calls: Promise<CallResult>[] = []
      for (let i = 0; i < fireCount; i += 1) {
        calls.push(
          apiFetch<CallResult>('/api/v1/protected').catch((e) => ({
            status: (e as { status?: number }).status ?? 0,
            data: e,
          })),
        )
      }
      const results = await Promise.all(calls)
      onResults(results)
    }
    void fire()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return <div>token={auth.accessToken ?? 'none'}</div>
}

function LoginStub() {
  return <p>login-route</p>
}

function AuthBridge({ children }: { children: ReactNode }) {
  const navigate = useNavigate()
  return (
    <AuthProvider onSessionExpired={() => navigate('/login')}>
      {children}
    </AuthProvider>
  )
}

function renderHarness(node: ReactNode, initialEntries: string[] = ['/']) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <AuthBridge>
        <Routes>
          <Route path="/" element={node} />
          <Route path="/login" element={<LoginStub />} />
        </Routes>
      </AuthBridge>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  server.resetHandlers()
})

afterEach(() => {
  __resetClientState()
})

test('401 on protected call triggers single refresh and retries with new token', async () => {
  let protectedHits = 0
  let refreshHits = 0
  server.use(
    http.get('*/api/v1/protected', ({ request }) => {
      protectedHits += 1
      const auth = request.headers.get('Authorization')
      if (auth === 'Bearer new-token') {
        return HttpResponse.json({ value: 'ok' }, { status: 200 })
      }
      return HttpResponse.json(
        { type: 'about:blank', title: 'Unauthorized', status: 401, detail: 'expired' },
        { status: 401, headers: { 'Content-Type': 'application/problem+json' } },
      )
    }),
    http.post('*/api/v1/auth/refresh', () => {
      refreshHits += 1
      return HttpResponse.json({ accessToken: 'new-token', expiresIn: 900 }, { status: 200 })
    }),
  )

  const captured: { value: CallResult[] | null } = { value: null }
  renderHarness(
    <CallProtected
      initialToken="old-token"
      onResults={(r) => {
        captured.value = r
      }}
    />,
  )

  await waitFor(() => expect(captured.value).not.toBeNull())
  expect(refreshHits).toBe(1)
  expect(protectedHits).toBe(2)
  expect(captured.value![0].status).toBe(200)
  await waitFor(() => {
    expect(screen.getByText('token=new-token')).toBeTruthy()
  })
})

test('refresh failure clears auth context and navigates to /login', async () => {
  server.use(
    http.get('*/api/v1/protected', () =>
      HttpResponse.json(
        { type: 'about:blank', title: 'Unauthorized', status: 401, detail: 'expired' },
        { status: 401, headers: { 'Content-Type': 'application/problem+json' } },
      ),
    ),
    http.post('*/api/v1/auth/refresh', () =>
      HttpResponse.json(
        { type: 'about:blank', title: 'Unauthorized', status: 401, detail: 'invalid refresh' },
        { status: 401, headers: { 'Content-Type': 'application/problem+json' } },
      ),
    ),
  )

  function CallAndExpose({ onDone }: { onDone: () => void }) {
    const auth = useAuth()
    useEffect(() => {
      auth.login('old-token', {
        id: 'u1',
        email: 'a@b.c',
        displayName: 'Alice',
        createdAt: '2026-01-01T00:00:00Z',
      })
      apiFetch<unknown>('/api/v1/protected')
        .catch(() => {})
        .finally(onDone)
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])
    return <p>user={auth.currentUser?.displayName ?? 'none'}</p>
  }

  let done = false
  renderHarness(<CallAndExpose onDone={() => (done = true)} />)

  await waitFor(() => expect(done).toBe(true))
  await waitFor(() => {
    expect(screen.getByText('login-route')).toBeTruthy()
  })
})

test('two concurrent 401s share one refresh', async () => {
  let refreshHits = 0
  server.use(
    http.get('*/api/v1/protected', ({ request }) => {
      const auth = request.headers.get('Authorization')
      if (auth === 'Bearer new-token') {
        return HttpResponse.json({ value: 'ok' }, { status: 200 })
      }
      return HttpResponse.json(
        { type: 'about:blank', title: 'Unauthorized', status: 401, detail: 'expired' },
        { status: 401, headers: { 'Content-Type': 'application/problem+json' } },
      )
    }),
    http.post('*/api/v1/auth/refresh', async () => {
      refreshHits += 1
      // Slight delay so the second 401 arrives while refresh is still in flight.
      await new Promise((r) => setTimeout(r, 20))
      return HttpResponse.json({ accessToken: 'new-token', expiresIn: 900 }, { status: 200 })
    }),
  )

  const captured: { value: CallResult[] | null } = { value: null }
  renderHarness(
    <CallProtected
      initialToken="old-token"
      fireCount={2}
      onResults={(r) => {
        captured.value = r
      }}
    />,
  )

  await waitFor(() => expect(captured.value).not.toBeNull())
  expect(refreshHits).toBe(1)
  expect(captured.value!.length).toBe(2)
  expect(captured.value!.every((c) => c.status === 200)).toBe(true)
})
