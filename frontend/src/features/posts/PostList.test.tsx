import { test, expect, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'

import { AuthProvider } from '../auth/AuthContext'
import { PostList } from './PostList'
import { server } from '../../test/msw-server'

const ALICE_ID = '11111111-1111-1111-1111-111111111111'

function renderList() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <AuthProvider>
        <MemoryRouter>
          <PostList userId={ALICE_ID} />
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  server.resetHandlers()
})

test('paginates across two pages and stops fetching when nextCursor is null', async () => {
  const user = userEvent.setup()
  let calls = 0
  const cursorBetweenPages = 'CURSOR-PAGE-2'

  server.use(
    http.get(`*/api/v1/users/${ALICE_ID}/posts`, ({ request }) => {
      calls++
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

  renderList()

  await waitFor(() => expect(screen.getByText('page-1-item-1')).toBeTruthy())
  expect(screen.getByText('page-1-item-2')).toBeTruthy()

  const loadMore = screen.getByRole('button', { name: /load more/i })
  await user.click(loadMore)

  await waitFor(() => expect(screen.getByText('page-2-item-1')).toBeTruthy())

  // All three items remain visible — second page is appended, not replacing.
  expect(screen.getByText('page-1-item-1')).toBeTruthy()
  expect(screen.getByText('page-1-item-2')).toBeTruthy()
  expect(screen.getByText('page-2-item-1')).toBeTruthy()

  // Once nextCursor is null, the Load more button must be gone.
  expect(screen.queryByRole('button', { name: /load more/i })).toBeNull()

  // No further fetches after page 2.
  const callsAfterPage2 = calls
  await new Promise((r) => setTimeout(r, 50))
  expect(calls).toBe(callsAfterPage2)
  expect(calls).toBe(2)
})
