import { useEffect, useState } from 'react'
import { test, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

import { AuthProvider, useAuth } from '../auth/AuthContext'
import { getGetFeedQueryKey } from '@/api/generated/queries/feed-controller/feed-controller'
import { ProfilePage } from './ProfilePage'
import { server } from '../../test/msw-server'

const ALICE_ID = '11111111-1111-1111-1111-111111111111'
const BOB_ID = '22222222-2222-2222-2222-222222222222'

function followStatsHandler(
  userId: string,
  body: { followers: number; following: number; viewerFollows: boolean },
) {
  return http.get(`*/api/v1/users/${userId}/follow-stats`, () =>
    HttpResponse.json(body, { status: 200 }),
  )
}

function findCountsText(pattern: RegExp): HTMLElement {
  return screen.getByText(
    (_, el) =>
      el?.tagName === 'P' &&
      pattern.test((el.textContent ?? '').replace(/\s+/g, ' ').trim()),
  )
}

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
    followStatsHandler(ALICE_ID, {
      followers: 0,
      following: 0,
      viewerFollows: false,
    }),
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
    followStatsHandler(ALICE_ID, {
      followers: 0,
      following: 0,
      viewerFollows: false,
    }),
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
    followStatsHandler(ALICE_ID, {
      followers: 0,
      following: 0,
      viewerFollows: false,
    }),
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

test('non-own profile with viewerFollows=false renders Follow button', async () => {
  server.use(
    http.get(`*/api/v1/users/${ALICE_ID}`, () =>
      HttpResponse.json(
        { id: ALICE_ID, displayName: 'Alice' },
        { status: 200 },
      ),
    ),
    followStatsHandler(ALICE_ID, {
      followers: 0,
      following: 0,
      viewerFollows: false,
    }),
    http.get(`*/api/v1/users/${ALICE_ID}/posts`, () =>
      HttpResponse.json({ items: [], nextCursor: null }, { status: 200 }),
    ),
  )

  renderProfileFor(ALICE_ID, BOB_ID, 'Bob')

  expect(await screen.findByRole('button', { name: 'Follow' })).toBeTruthy()
  expect(findCountsText(/0 followers/)).toBeTruthy()
})

test('non-own profile with viewerFollows=true renders Unfollow button', async () => {
  server.use(
    http.get(`*/api/v1/users/${ALICE_ID}`, () =>
      HttpResponse.json(
        { id: ALICE_ID, displayName: 'Alice' },
        { status: 200 },
      ),
    ),
    followStatsHandler(ALICE_ID, {
      followers: 1,
      following: 0,
      viewerFollows: true,
    }),
    http.get(`*/api/v1/users/${ALICE_ID}/posts`, () =>
      HttpResponse.json({ items: [], nextCursor: null }, { status: 200 }),
    ),
  )

  renderProfileFor(ALICE_ID, BOB_ID, 'Bob')

  expect(await screen.findByRole('button', { name: 'Unfollow' })).toBeTruthy()
  expect(findCountsText(/1 follower\b/)).toBeTruthy()
})

test('own profile renders counts but no toggle button', async () => {
  server.use(
    http.get(`*/api/v1/users/${ALICE_ID}`, () =>
      HttpResponse.json(
        { id: ALICE_ID, displayName: 'Alice' },
        { status: 200 },
      ),
    ),
    followStatsHandler(ALICE_ID, {
      followers: 5,
      following: 4,
      viewerFollows: false,
    }),
    http.get(`*/api/v1/users/${ALICE_ID}/posts`, () =>
      HttpResponse.json({ items: [], nextCursor: null }, { status: 200 }),
    ),
  )

  renderProfileFor(ALICE_ID, ALICE_ID, 'Alice')

  await waitFor(() => expect(findCountsText(/5 followers/)).toBeTruthy())
  expect(findCountsText(/4 following/)).toBeTruthy()
  expect(
    screen.queryByRole('button', { name: /^(follow|unfollow|following)$/i }),
  ).toBeNull()
})

test('clicking Follow invokes the mutation and refetches stats', async () => {
  let followCallCount = 0
  let statsCallCount = 0
  server.use(
    http.get(`*/api/v1/users/${ALICE_ID}`, () =>
      HttpResponse.json(
        { id: ALICE_ID, displayName: 'Alice' },
        { status: 200 },
      ),
    ),
    http.get(`*/api/v1/users/${ALICE_ID}/follow-stats`, () => {
      statsCallCount += 1
      if (statsCallCount === 1) {
        return HttpResponse.json(
          { followers: 0, following: 0, viewerFollows: false },
          { status: 200 },
        )
      }
      return HttpResponse.json(
        { followers: 1, following: 0, viewerFollows: true },
        { status: 200 },
      )
    }),
    http.post(`*/api/v1/users/${ALICE_ID}/follow`, () => {
      followCallCount += 1
      return new HttpResponse(null, { status: 204 })
    }),
    http.get(`*/api/v1/users/${ALICE_ID}/posts`, () =>
      HttpResponse.json({ items: [], nextCursor: null }, { status: 200 }),
    ),
  )

  renderProfileFor(ALICE_ID, BOB_ID, 'Bob')

  const followBtn = await screen.findByRole('button', { name: 'Follow' })
  await userEvent.click(followBtn)

  expect(await screen.findByRole('button', { name: 'Unfollow' })).toBeTruthy()
  await waitFor(() => expect(findCountsText(/1 follower\b/)).toBeTruthy())
  expect(followCallCount).toBe(1)
})

test('clicking Follow invalidates the feed query key', async () => {
  const spy = vi.spyOn(QueryClient.prototype, 'invalidateQueries')
  server.use(
    http.get(`*/api/v1/users/${ALICE_ID}`, () =>
      HttpResponse.json(
        { id: ALICE_ID, displayName: 'Alice' },
        { status: 200 },
      ),
    ),
    followStatsHandler(ALICE_ID, {
      followers: 0,
      following: 0,
      viewerFollows: false,
    }),
    http.post(
      `*/api/v1/users/${ALICE_ID}/follow`,
      () => new HttpResponse(null, { status: 204 }),
    ),
    http.get(`*/api/v1/users/${ALICE_ID}/posts`, () =>
      HttpResponse.json({ items: [], nextCursor: null }, { status: 200 }),
    ),
  )

  renderProfileFor(ALICE_ID, BOB_ID, 'Bob')

  const followBtn = await screen.findByRole('button', { name: 'Follow' })
  await userEvent.click(followBtn)

  const expectedKey = getGetFeedQueryKey()
  await waitFor(() =>
    expect(
      spy.mock.calls.some(([arg]) => {
        if (!arg || typeof arg !== 'object') return false
        const queryKey = (arg as { queryKey?: readonly unknown[] }).queryKey
        return (
          Array.isArray(queryKey) &&
          queryKey.length === expectedKey.length &&
          queryKey.every((v, i) => v === expectedKey[i])
        )
      }),
    ).toBe(true),
  )
  spy.mockRestore()
})

test('clicking Unfollow invalidates the feed query key', async () => {
  const spy = vi.spyOn(QueryClient.prototype, 'invalidateQueries')
  server.use(
    http.get(`*/api/v1/users/${ALICE_ID}`, () =>
      HttpResponse.json(
        { id: ALICE_ID, displayName: 'Alice' },
        { status: 200 },
      ),
    ),
    followStatsHandler(ALICE_ID, {
      followers: 1,
      following: 0,
      viewerFollows: true,
    }),
    http.delete(
      `*/api/v1/users/${ALICE_ID}/follow`,
      () => new HttpResponse(null, { status: 204 }),
    ),
    http.get(`*/api/v1/users/${ALICE_ID}/posts`, () =>
      HttpResponse.json({ items: [], nextCursor: null }, { status: 200 }),
    ),
  )

  renderProfileFor(ALICE_ID, BOB_ID, 'Bob')

  const unfollowBtn = await screen.findByRole('button', { name: 'Unfollow' })
  await userEvent.click(unfollowBtn)

  const expectedKey = getGetFeedQueryKey()
  await waitFor(() =>
    expect(
      spy.mock.calls.some(([arg]) => {
        if (!arg || typeof arg !== 'object') return false
        const queryKey = (arg as { queryKey?: readonly unknown[] }).queryKey
        return (
          Array.isArray(queryKey) &&
          queryKey.length === expectedKey.length &&
          queryKey.every((v, i) => v === expectedKey[i])
        )
      }),
    ).toBe(true),
  )
  spy.mockRestore()
})

test('clicking Unfollow invokes the mutation and refetches stats', async () => {
  let unfollowCallCount = 0
  let statsCallCount = 0
  server.use(
    http.get(`*/api/v1/users/${ALICE_ID}`, () =>
      HttpResponse.json(
        { id: ALICE_ID, displayName: 'Alice' },
        { status: 200 },
      ),
    ),
    http.get(`*/api/v1/users/${ALICE_ID}/follow-stats`, () => {
      statsCallCount += 1
      if (statsCallCount === 1) {
        return HttpResponse.json(
          { followers: 1, following: 0, viewerFollows: true },
          { status: 200 },
        )
      }
      return HttpResponse.json(
        { followers: 0, following: 0, viewerFollows: false },
        { status: 200 },
      )
    }),
    http.delete(`*/api/v1/users/${ALICE_ID}/follow`, () => {
      unfollowCallCount += 1
      return new HttpResponse(null, { status: 204 })
    }),
    http.get(`*/api/v1/users/${ALICE_ID}/posts`, () =>
      HttpResponse.json({ items: [], nextCursor: null }, { status: 200 }),
    ),
  )

  renderProfileFor(ALICE_ID, BOB_ID, 'Bob')

  const unfollowBtn = await screen.findByRole('button', { name: 'Unfollow' })
  await userEvent.click(unfollowBtn)

  expect(await screen.findByRole('button', { name: 'Follow' })).toBeTruthy()
  await waitFor(() => expect(findCountsText(/0 followers/)).toBeTruthy())
  expect(unfollowCallCount).toBe(1)
})
