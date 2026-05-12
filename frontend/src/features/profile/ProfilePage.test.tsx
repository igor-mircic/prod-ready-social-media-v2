import { useEffect, useState } from 'react'
import { test, expect, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

import { AuthProvider, useAuth } from '../auth/AuthContext'
import { ProfilePage } from './ProfilePage'
import { server } from '../../test/msw-server'

const ALICE_ID = '11111111-1111-1111-1111-111111111111'
const BOB_ID = '22222222-2222-2222-2222-222222222222'

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
      email: 'viewer@example.com',
      displayName,
      createdAt: '2026-01-01T00:00:00Z',
    })
    setSeeded(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, displayName, auth.booting])
  if (!seeded) return null
  return <>{children}</>
}

function renderProfileFor(
  routeUserId: string,
  viewerUserId: string,
  viewerDisplayName = 'Viewer',
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <AuthProvider>
        <AuthSeeder userId={viewerUserId} displayName={viewerDisplayName}>
          <MemoryRouter initialEntries={[`/users/${routeUserId}`]}>
            <Routes>
              <Route path="/users/:userId" element={<ProfilePage />} />
            </Routes>
          </MemoryRouter>
        </AuthSeeder>
      </AuthProvider>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  server.resetHandlers()
})

test('renders the header and a Post when the user has seeded posts', async () => {
  server.use(
    http.get(`*/api/v1/users/${ALICE_ID}`, () =>
      HttpResponse.json(
        { id: ALICE_ID, displayName: 'Alice' },
        { status: 200 },
      ),
    ),
    http.get(`*/api/v1/users/${ALICE_ID}/posts`, () =>
      HttpResponse.json(
        {
          items: [
            {
              id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
              author: { id: ALICE_ID, displayName: 'Alice' },
              body: 'profile seed post',
              createdAt: '2026-05-11T12:00:00Z',
            },
          ],
          nextCursor: null,
        },
        { status: 200 },
      ),
    ),
  )

  renderProfileFor(ALICE_ID, BOB_ID, 'Bob')

  await waitFor(() =>
    expect(screen.getByRole('heading', { name: 'Alice' })).toBeTruthy(),
  )
  await waitFor(() =>
    expect(screen.getByRole('article', { name: 'Post' }).textContent).toContain(
      'profile seed post',
    ),
  )
  expect(screen.queryByRole('textbox')).toBeNull()
})

test('renders the header and the empty-state when the user has zero posts', async () => {
  server.use(
    http.get(`*/api/v1/users/${ALICE_ID}`, () =>
      HttpResponse.json(
        { id: ALICE_ID, displayName: 'Alice' },
        { status: 200 },
      ),
    ),
    http.get(`*/api/v1/users/${ALICE_ID}/posts`, () =>
      HttpResponse.json({ items: [], nextCursor: null }, { status: 200 }),
    ),
  )

  renderProfileFor(ALICE_ID, BOB_ID, 'Bob')

  await waitFor(() =>
    expect(screen.getByRole('heading', { name: 'Alice' })).toBeTruthy(),
  )
  expect(screen.queryByRole('article', { name: 'Post' })).toBeNull()
  expect(screen.getByText(/no posts yet/i)).toBeTruthy()
  expect(screen.queryByRole('textbox')).toBeNull()
})

test('renders the User-not-found affordance when getUser returns 404', async () => {
  server.use(
    http.get(`*/api/v1/users/${ALICE_ID}`, () =>
      HttpResponse.json(
        {
          type: 'about:blank',
          title: 'Not Found',
          status: 404,
          detail: 'User not found',
        },
        {
          status: 404,
          headers: { 'content-type': 'application/problem+json' },
        },
      ),
    ),
    http.get(`*/api/v1/users/${ALICE_ID}/posts`, () =>
      HttpResponse.json(
        { type: 'about:blank', title: 'Not Found', status: 404 },
        {
          status: 404,
          headers: { 'content-type': 'application/problem+json' },
        },
      ),
    ),
  )

  renderProfileFor(ALICE_ID, BOB_ID, 'Bob')

  await waitFor(() => expect(screen.getByText(/user not found/i)).toBeTruthy())
  expect(screen.queryByRole('heading', { name: 'Alice' })).toBeNull()
  expect(screen.queryByRole('article', { name: 'Post' })).toBeNull()
})

test('never renders a composer textbox', async () => {
  server.use(
    http.get(`*/api/v1/users/${ALICE_ID}`, () =>
      HttpResponse.json(
        { id: ALICE_ID, displayName: 'Alice' },
        { status: 200 },
      ),
    ),
    http.get(`*/api/v1/users/${ALICE_ID}/posts`, () =>
      HttpResponse.json({ items: [], nextCursor: null }, { status: 200 }),
    ),
  )

  // Viewer is the same as the profile owner — composer would be tempting on
  // /home but must remain hidden on the profile route.
  renderProfileFor(ALICE_ID, ALICE_ID, 'Alice')

  await waitFor(() =>
    expect(screen.getByRole('heading', { name: 'Alice' })).toBeTruthy(),
  )
  expect(screen.queryByRole('textbox')).toBeNull()
})
