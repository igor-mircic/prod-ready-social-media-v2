// Pins the SPA's pagination contract across three pages and the intermediate
// "Loading…" label on the Load more button while the next-page fetch is in
// flight.
import { test, expect } from '../src/fixtures/test.ts'
import { randomSignupInput, signupViaApi } from '../src/helpers/signup.ts'
import { loginAndLandOnHome, loginViaApi } from '../src/helpers/login.ts'
import { seedPosts } from '../src/helpers/seedPosts.ts'

const seedBody = (i: number) => `Deep pagination post ${i.toString().padStart(2, '0')}`

test('pagination: Load more flips to "Loading…" mid-fetch and is removed after the final page', async ({
  page,
  apiClient,
}) => {
  const aliceInput = randomSignupInput({ displayName: 'Alice' })
  await signupViaApi(apiClient, aliceInput)
  const { accessToken: aliceToken } = await loginViaApi(apiClient, {
    email: aliceInput.email,
    password: aliceInput.password,
  })

  await seedPosts(apiClient, aliceToken, 41, seedBody)

  // The local backend returns paginated pages in single-digit ms, which is
  // tighter than Playwright's polling can observe reliably. Delay the
  // paginated list calls (those carrying a `cursor` query parameter) by
  // ~250ms so the intermediate "Loading…" label is visible long enough to
  // assert. The first page request (no cursor) is not delayed.
  await page.route('**/users/*/posts?*', async (route) => {
    await new Promise((r) => setTimeout(r, 250))
    await route.continue()
  })

  await loginAndLandOnHome(page, aliceInput)

  const cards = page.getByRole('article', { name: 'Post' })
  await expect(cards).toHaveCount(20)

  const loadMore = page.getByRole('button', { name: 'Load more' })
  await expect(loadMore).toBeVisible()
  await loadMore.click()

  const loadingButton = page.getByRole('button', { name: 'Loading…' })
  await expect(loadingButton).toBeVisible()
  await expect(loadingButton).toBeDisabled()

  await expect(cards).toHaveCount(40)

  const loadMoreAgain = page.getByRole('button', { name: 'Load more' })
  await expect(loadMoreAgain).toBeVisible()
  await loadMoreAgain.click()

  await expect(cards).toHaveCount(41)
  await expect(page.getByRole('button', { name: 'Load more' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Loading…' })).toHaveCount(0)
})

test('pagination: three-page walk renders all 41 seeded bodies', async ({ page, apiClient }) => {
  const aliceInput = randomSignupInput({ displayName: 'Alice' })
  await signupViaApi(apiClient, aliceInput)
  const { accessToken: aliceToken } = await loginViaApi(apiClient, {
    email: aliceInput.email,
    password: aliceInput.password,
  })

  const created = await seedPosts(apiClient, aliceToken, 41, seedBody)
  const seededBodies = new Set(created.map((p) => p.body as string))
  expect(seededBodies.size).toBe(41)

  await loginAndLandOnHome(page, aliceInput)

  const cards = page.getByRole('article', { name: 'Post' })
  const loadMore = page.getByRole('button', { name: 'Load more' })

  await expect(cards).toHaveCount(20)
  await expect(loadMore).toBeVisible()

  await loadMore.click()
  await expect(cards).toHaveCount(40)
  await expect(page.getByRole('button', { name: 'Load more' })).toBeVisible()

  await page.getByRole('button', { name: 'Load more' }).click()
  await expect(cards).toHaveCount(41)
  await expect(page.getByRole('button', { name: 'Load more' })).toHaveCount(0)

  const renderedTexts = await cards.allInnerTexts()
  const renderedBodies = new Set<string>()
  for (const text of renderedTexts) {
    const match = [...seededBodies].find((b) => text.includes(b))
    expect(match, `rendered card text must include a seeded body: ${text}`).toBeDefined()
    renderedBodies.add(match as string)
  }
  expect(renderedBodies.size).toBe(seededBodies.size)
  for (const body of seededBodies) {
    expect(renderedBodies.has(body), `seeded body must be rendered: ${body}`).toBe(true)
  }
})
