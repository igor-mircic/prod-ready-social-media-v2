import { test, expect, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'

import { AuthProvider } from '../auth/AuthContext'
import { PostComposer } from './PostComposer'
import { PostList } from './PostList'
import { server } from '../../test/msw-server'

const ALICE_ID = '11111111-1111-1111-1111-111111111111'

function TestHarness() {
  return (
    <>
      <PostComposer authorUserId={ALICE_ID} />
      <PostList userId={ALICE_ID} />
    </>
  )
}

function renderHarness() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <AuthProvider>
        <MemoryRouter>
          <TestHarness />
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  server.resetHandlers()
})

test('successful compose invalidates the list and renders the new post', async () => {
  const user = userEvent.setup()
  let getCallCount = 0
  let posted = false
  server.use(
    http.get(`*/api/v1/users/${ALICE_ID}/posts`, () => {
      getCallCount++
      return HttpResponse.json(
        posted
          ? {
              items: [
                {
                  id: '99999999-9999-9999-9999-999999999999',
                  author: { id: ALICE_ID, displayName: 'Alice' },
                  body: 'hello world',
                  createdAt: '2026-05-11T12:00:00Z',
                },
              ],
              nextCursor: null,
            }
          : { items: [], nextCursor: null },
        { status: 200 },
      )
    }),
    http.post('*/api/v1/posts', async () => {
      posted = true
      return HttpResponse.json(
        {
          id: '99999999-9999-9999-9999-999999999999',
          author: { id: ALICE_ID, displayName: 'Alice' },
          body: 'hello world',
          createdAt: '2026-05-11T12:00:00Z',
        },
        { status: 201 },
      )
    }),
  )

  renderHarness()

  // Wait for initial empty list to render.
  await waitFor(() => expect(screen.getByText(/no posts yet/i)).toBeTruthy())

  await user.type(screen.getByLabelText(/body/i), 'hello world')
  await user.click(screen.getByRole('button', { name: /^post$/i }))

  await waitFor(() => {
    expect(screen.getByText('hello world')).toBeTruthy()
  })
  // Two GETs: initial render + post-mutation invalidation refetch.
  expect(getCallCount).toBeGreaterThanOrEqual(2)
})

test('empty body shows validation message and fires no network request', async () => {
  const user = userEvent.setup()
  let postHit = false
  server.use(
    http.get(`*/api/v1/users/${ALICE_ID}/posts`, () =>
      HttpResponse.json({ items: [], nextCursor: null }, { status: 200 }),
    ),
    http.post('*/api/v1/posts', () => {
      postHit = true
      return HttpResponse.json({}, { status: 201 })
    }),
  )

  renderHarness()

  await waitFor(() => expect(screen.getByText(/no posts yet/i)).toBeTruthy())

  const submit = screen.getByRole('button', { name: /^post$/i })
  // Empty body keeps the form invalid; the submit button must be disabled.
  expect(submit).toBeDisabled()
  await user.click(submit)

  await new Promise((r) => setTimeout(r, 50))
  expect(postHit).toBe(false)
})
