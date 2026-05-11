import { useEffect, useState } from 'react'
import { test, expect, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import { AuthProvider, useAuth } from '../auth/AuthContext'
import { PostCard } from './PostCard'
import { PostList } from './PostList'
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
    auth.login('test-token', {
      id: userId,
      email: 'test@example.com',
      displayName,
      createdAt: '2026-01-01T00:00:00Z',
    })
    setSeeded(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, displayName])
  if (!seeded) return null
  return <>{children}</>
}

function renderWithCurrentUser(
  currentUserId: string,
  ui: React.ReactNode,
  displayName = 'Alice',
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <AuthProvider>
        <AuthSeeder userId={currentUserId} displayName={displayName}>
          {ui}
        </AuthSeeder>
      </AuthProvider>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  server.resetHandlers()
})

test('renders delete control and invalidates list when caller is the author', async () => {
  const user = userEvent.setup()
  const POST_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
  let listCalls = 0
  let alivePost = true

  server.use(
    http.get(`*/api/v1/users/${ALICE_ID}/posts`, () => {
      listCalls++
      return HttpResponse.json(
        alivePost
          ? {
              items: [
                {
                  id: POST_ID,
                  author: { id: ALICE_ID, displayName: 'Alice' },
                  body: 'my own post',
                  createdAt: '2026-05-11T12:00:00Z',
                },
              ],
              nextCursor: null,
            }
          : { items: [], nextCursor: null },
        { status: 200 },
      )
    }),
    http.delete(`*/api/v1/posts/${POST_ID}`, () => {
      alivePost = false
      return new HttpResponse(null, { status: 204 })
    }),
  )

  renderWithCurrentUser(ALICE_ID, <PostList userId={ALICE_ID} />)

  await waitFor(() => expect(screen.getByText('my own post')).toBeTruthy())
  const deleteBtn = screen.getByRole('button', { name: /delete post/i })
  expect(deleteBtn).toBeTruthy()
  await user.click(deleteBtn)

  await waitFor(() => expect(screen.queryByText('my own post')).toBeNull())
  expect(listCalls).toBeGreaterThanOrEqual(2)
})

test('does NOT render the delete control when the post is not the caller’s', async () => {
  const POST_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'

  server.use(
    http.get(`*/api/v1/users/${ALICE_ID}/posts`, () =>
      HttpResponse.json(
        {
          items: [
            {
              id: POST_ID,
              // Author is Alice; but the current user is Bob — not the author.
              author: { id: ALICE_ID, displayName: 'Alice' },
              body: 'alice post viewed by bob',
              createdAt: '2026-05-11T12:00:00Z',
            },
          ],
          nextCursor: null,
        },
        { status: 200 },
      ),
    ),
  )

  renderWithCurrentUser(BOB_ID, <PostList userId={ALICE_ID} />, 'Bob')

  await waitFor(() =>
    expect(screen.getByText('alice post viewed by bob')).toBeTruthy(),
  )
  expect(screen.queryByRole('button', { name: /delete post/i })).toBeNull()
})

test('directly-rendered PostCard hides the delete control for non-author', () => {
  renderWithCurrentUser(
    BOB_ID,
    <PostCard
      listOwnerId={ALICE_ID}
      post={{
        id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
        author: { id: ALICE_ID, displayName: 'Alice' },
        body: 'standalone card',
        createdAt: '2026-05-11T12:00:00Z',
      }}
    />,
    'Bob',
  )
  expect(screen.getByText('standalone card')).toBeTruthy()
  expect(screen.queryByRole('button', { name: /delete post/i })).toBeNull()
})
