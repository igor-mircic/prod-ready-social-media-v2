import { useEffect, useState } from 'react'
import { test, expect, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'

import { AuthProvider, useAuth } from '../auth/AuthContext'
import { HomePage } from './HomePage'
import { server } from '../../test/msw-server'

const ALICE_ID = '11111111-1111-1111-1111-111111111111'

function AuthSeeder({
  userId,
  displayName,
  children,
}: {
  userId: string
  displayName: string
  children: React.ReactNode
}) {
  const auth = useAuth()
  const [seeded, setSeeded] = useState(false)
  useEffect(() => {
    if (auth.booting) return
    auth.login('test-token', {
      id: userId,
      email: 'test@example.com',
      displayName,
      createdAt: '2026-01-01T00:00:00Z',
    })
    setSeeded(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, displayName, auth.booting])
  if (!seeded) return null
  return <>{children}</>
}

function renderHome() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <AuthProvider>
        <AuthSeeder userId={ALICE_ID} displayName="Alice">
          <MemoryRouter>
            <HomePage />
          </MemoryRouter>
        </AuthSeeder>
      </AuthProvider>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  server.resetHandlers()
})

test('HomePage renders the FeedList and does not request the per-author list', async () => {
  let perAuthorCalls = 0

  server.use(
    http.get('*/api/v1/auth/me', () =>
      HttpResponse.json(
        {
          id: ALICE_ID,
          email: 'alice@example.com',
          displayName: 'Alice',
          createdAt: '2026-01-01T00:00:00Z',
        },
        { status: 200 },
      ),
    ),
    http.get('*/api/v1/feed', () =>
      HttpResponse.json(
        {
          items: [
            {
              id: '00000000-0000-0000-0000-000000000001',
              author: { id: ALICE_ID, displayName: 'Alice' },
              body: 'feed-only post',
              createdAt: '2026-05-11T12:00:00Z',
            },
          ],
          nextCursor: null,
        },
        { status: 200 },
      ),
    ),
    http.get(`*/api/v1/users/${ALICE_ID}/posts`, () => {
      perAuthorCalls++
      return HttpResponse.json({ items: [], nextCursor: null }, { status: 200 })
    }),
  )

  renderHome()

  await waitFor(() => expect(screen.getByText('feed-only post')).toBeTruthy())
  // Allow any in-flight stray request from the previous wiring to settle.
  await new Promise((r) => setTimeout(r, 50))
  expect(perAuthorCalls).toBe(0)
})
