// Proves cross-user cursor pagination via the e2e apiClient: Bob walks
// Alice's two pages of posts using his own bearer token. API-only because
// the SPA has no route to view another user's posts.
import { test, expect } from '../src/fixtures/test.ts'
import { randomSignupInput, signupViaApi } from '../src/helpers/signup.ts'
import { loginViaApi } from '../src/helpers/login.ts'
import { seedPosts } from '../src/helpers/seedPosts.ts'
import type {
  PostListResponse,
  UserResponse,
} from '../src/api/generated/openAPIDefinition.schemas.ts'

const seedBody = (i: number) => `Cross-user pagination post ${i.toString().padStart(2, '0')}`

test('cross-user pagination: Bob walks Alice\'s two pages via apiClient', async ({ apiClient }) => {
  const aliceInput = randomSignupInput({ displayName: 'Alice' })
  const alice: UserResponse = await signupViaApi(apiClient, aliceInput)
  const aliceId = alice.id as string
  expect(aliceId, 'signup must return Alice\'s id').toBeTruthy()

  const { accessToken: aliceToken } = await loginViaApi(apiClient, {
    email: aliceInput.email,
    password: aliceInput.password,
  })

  const created = await seedPosts(apiClient, aliceToken, 21, seedBody)
  const seededBodies = new Set(created.map((p) => p.body as string))
  expect(seededBodies.size).toBe(21)

  const bobInput = randomSignupInput({ displayName: 'Bob' })
  await signupViaApi(apiClient, bobInput)
  const { accessToken: bobToken } = await loginViaApi(apiClient, {
    email: bobInput.email,
    password: bobInput.password,
  })

  const collected = new Set<string>()

  const page1 = await apiClient.listPostsByAuthor(bobToken, aliceId)
  expect(page1.status).toBe(200)
  const page1Body = page1.body as PostListResponse
  expect(page1Body.items?.length ?? 0).toBe(20)
  const nextCursor = page1Body.nextCursor
  expect(typeof nextCursor).toBe('string')
  expect((nextCursor ?? '').length).toBeGreaterThan(0)
  for (const item of page1Body.items ?? []) {
    expect(item.body, 'page-1 item must have a body').toBeTruthy()
    collected.add(item.body as string)
  }

  const page2 = await apiClient.listPostsByAuthor(bobToken, aliceId, { cursor: nextCursor })
  expect(page2.status).toBe(200)
  const page2Body = page2.body as PostListResponse
  expect(page2Body.items?.length ?? 0).toBe(1)
  expect(page2Body.nextCursor == null).toBe(true)
  for (const item of page2Body.items ?? []) {
    expect(item.body, 'page-2 item must have a body').toBeTruthy()
    collected.add(item.body as string)
  }

  expect(collected.size).toBe(21)
  for (const body of seededBodies) {
    expect(collected.has(body), `seeded body must appear in collected set: ${body}`).toBe(true)
  }
})
