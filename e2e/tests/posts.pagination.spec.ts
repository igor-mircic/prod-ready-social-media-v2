// Proves cursor pagination through the SPA across two pages against the real backend:
// `useInfiniteQuery` round-trips the server-issued `nextCursor`, "Load more" advances
// to the next page, and disappears once the cursor is exhausted.
import { test, expect } from '../src/fixtures/test.ts'
import { randomSignupInput, signupViaApi } from '../src/helpers/signup.ts'
import { loginAndLandOnHome, loginViaApi } from '../src/helpers/login.ts'
import type { PostResponse } from '../src/api/generated/openAPIDefinition.schemas.ts'

test('posts pagination: walks two pages via "Load more" against the real stack', async ({
  page,
  apiClient,
}) => {
  const aliceInput = randomSignupInput({ displayName: 'Alice' })
  await signupViaApi(apiClient, aliceInput)
  const { accessToken: aliceToken } = await loginViaApi(apiClient, {
    email: aliceInput.email,
    password: aliceInput.password,
  })

  const seededBodies = new Set<string>()
  for (let i = 1; i <= 21; i++) {
    const body = `Pagination post ${i.toString().padStart(2, '0')}`
    const result = await apiClient.createPost(aliceToken, { body })
    expect(result.status, `createPost ${i} must succeed`).toBe(201)
    const created = result.body as PostResponse
    expect(created.body, `createPost ${i} response must include body`).toBe(body)
    seededBodies.add(body)
  }
  expect(seededBodies.size).toBe(21)

  await loginAndLandOnHome(page, aliceInput)

  const cards = page.getByRole('article', { name: 'Post' })
  const loadMore = page.getByRole('button', { name: 'Load more' })

  await expect(cards).toHaveCount(20)
  await expect(loadMore).toBeVisible()

  const pageOneBodies = await cards.allInnerTexts()
  expect(pageOneBodies).toHaveLength(20)
  for (const text of pageOneBodies) {
    const match = [...seededBodies].find((body) => text.includes(body))
    expect(match, `page-1 card text must include a seeded body: ${text}`).toBeDefined()
  }

  await loadMore.click()
  await expect(cards).toHaveCount(21)
  await expect(loadMore).toHaveCount(0)

  const pageTwoBodies = await cards.allInnerTexts()
  const renderedBodies = new Set<string>()
  for (const text of pageTwoBodies) {
    const match = [...seededBodies].find((body) => text.includes(body))
    expect(match, `page-2 card text must include a seeded body: ${text}`).toBeDefined()
    renderedBodies.add(match as string)
  }
  expect(renderedBodies.size).toBe(seededBodies.size)
  for (const body of seededBodies) {
    expect(renderedBodies.has(body), `seeded body must be rendered: ${body}`).toBe(true)
  }
})
