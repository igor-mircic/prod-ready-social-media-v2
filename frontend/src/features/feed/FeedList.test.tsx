import { useEffect, useState } from 'react'
import { test, expect, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'

import { AuthProvider, useAuth } from '../auth/AuthContext'
import { FeedList } from './FeedList'
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

function renderFeed(currentUserId = ALICE_ID, displayName = 'Alice') {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <AuthProvider>
        <AuthSeeder userId={currentUserId} displayName={displayName}>
          <MemoryRouter>
            <FeedList />
          </MemoryRouter>
        </AuthSeeder>
      </AuthProvider>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  server.resetHandlers()
})

test('empty state renders when feed returns no items', async () => {
  server.use(
    http.get('*/api/v1/feed', () =>
      HttpResponse.json({ items: [], nextCursor: null }, { status: 200 }),
    ),
  )

  renderFeed()

  await waitFor(() => expect(screen.getByText(/no posts yet/i)).toBeTruthy())
})

test('single page renders one article per item', async () => {
  server.use(
    http.get('*/api/v1/feed', () =>
      HttpResponse.json(
        {
          items: [
            {
              id: '00000000-0000-0000-0000-000000000001',
              author: { id: ALICE_ID, displayName: 'Alice' },
              body: 'feed-1',
              createdAt: '2026-05-11T12:00:00Z',
            },
            {
              id: '00000000-0000-0000-0000-000000000002',
              author: { id: ALICE_ID, displayName: 'Alice' },
              body: 'feed-2',
              createdAt: '2026-05-11T11:00:00Z',
            },
            {
              id: '00000000-0000-0000-0000-000000000003',
              author: { id: ALICE_ID, displayName: 'Alice' },
              body: 'feed-3',
              createdAt: '2026-05-11T10:00:00Z',
            },
          ],
          nextCursor: null,
        },
        { status: 200 },
      ),
    ),
  )

  renderFeed()

  await waitFor(() => expect(screen.getByText('feed-1')).toBeTruthy())
  expect(screen.getByText('feed-2')).toBeTruthy()
  expect(screen.getByText('feed-3')).toBeTruthy()
  expect(screen.queryByRole('button', { name: /load more/i })).toBeNull()
})

test('two-page pagination walks via Load more', async () => {
  const user = userEvent.setup()
  const cursorBetweenPages = 'CURSOR-PAGE-2'

  server.use(
    http.get('*/api/v1/feed', ({ request }) => {
      const url = new URL(request.url)
      const cursor = url.searchParams.get('cursor')
      if (!cursor) {
        return HttpResponse.json(
          {
            items: [
              {
                id: '00000000-0000-0000-0000-000000000001',
                author: { id: ALICE_ID, displayName: 'Alice' },
                body: 'page-1-item-1',
                createdAt: '2026-05-11T12:00:00Z',
              },
              {
                id: '00000000-0000-0000-0000-000000000002',
                author: { id: ALICE_ID, displayName: 'Alice' },
                body: 'page-1-item-2',
                createdAt: '2026-05-11T11:00:00Z',
              },
            ],
            nextCursor: cursorBetweenPages,
          },
          { status: 200 },
        )
      }
      if (cursor === cursorBetweenPages) {
        return HttpResponse.json(
          {
            items: [
              {
                id: '00000000-0000-0000-0000-000000000003',
                author: { id: ALICE_ID, displayName: 'Alice' },
                body: 'page-2-item-1',
                createdAt: '2026-05-11T10:00:00Z',
              },
            ],
            nextCursor: null,
          },
          { status: 200 },
        )
      }
      return HttpResponse.json({ items: [], nextCursor: null }, { status: 200 })
    }),
  )

  renderFeed()

  await waitFor(() => expect(screen.getByText('page-1-item-1')).toBeTruthy())
  expect(screen.getByText('page-1-item-2')).toBeTruthy()

  const loadMore = screen.getByRole('button', { name: /load more/i })
  await user.click(loadMore)

  await waitFor(() => expect(screen.getByText('page-2-item-1')).toBeTruthy())
  expect(screen.queryByRole('button', { name: /load more/i })).toBeNull()
})

test('error state renders alert when feed request fails', async () => {
  server.use(
    http.get('*/api/v1/feed', () => HttpResponse.json({}, { status: 500 })),
  )

  renderFeed()

  await waitFor(() =>
    expect(screen.getByRole('alert', { name: undefined })).toBeTruthy(),
  )
})

test('delete-from-feed refetches and removes the deleted post', async () => {
  const user = userEvent.setup()
  const POST_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
  let alivePost = true

  server.use(
    http.get('*/api/v1/feed', () =>
      HttpResponse.json(
        alivePost
          ? {
              items: [
                {
                  id: POST_ID,
                  author: { id: ALICE_ID, displayName: 'Alice' },
                  body: 'my own feed post',
                  createdAt: '2026-05-11T12:00:00Z',
                },
              ],
              nextCursor: null,
            }
          : { items: [], nextCursor: null },
        { status: 200 },
      ),
    ),
    http.delete(`*/api/v1/posts/${POST_ID}`, () => {
      alivePost = false
      return new HttpResponse(null, { status: 204 })
    }),
  )

  renderFeed()

  await waitFor(() => expect(screen.getByText('my own feed post')).toBeTruthy())
  const deleteBtn = screen.getByRole('button', { name: /delete post/i })
  await user.click(deleteBtn)

  await waitFor(() => expect(screen.queryByText('my own feed post')).toBeNull())
  // Empty state copy appears after the refetch returns zero items.
  await waitFor(() => expect(screen.getByText(/no posts yet/i)).toBeTruthy())
})
