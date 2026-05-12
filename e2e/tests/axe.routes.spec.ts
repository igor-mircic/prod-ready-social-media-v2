// Explicit axe scans on /login, /signup, /home, and /users/:userId. The
// implicit per-test hook in `e2e/src/fixtures/test.ts` already scans the
// final URL of each test; this spec pins clean scans on each of the four
// key routes explicitly. The /home scan runs against a populated feed (Bob
// follows Alice; Alice has 2 posts seeded via the API; Bob composes one via
// the SPA) so the feed accessibility is exercised with three rendered
// PostCards rather than an empty / single-self-post page.
import { test, expect } from '../src/fixtures/test.ts'
import { runAxeScan } from '../src/fixtures/axe.ts'
import { randomSignupInput, signupViaApi } from '../src/helpers/signup.ts'
import { loginAndLandOnHome, loginViaApi } from '../src/helpers/login.ts'

test('axe scans clean across /login, /signup, /home, and /users/:userId', async ({
  page,
  apiClient,
}, testInfo) => {
  await page.goto('/login')
  await expect(page.getByRole('button', { name: 'Log in' })).toBeVisible()
  await runAxeScan(page, testInfo)

  await page.goto('/signup')
  await expect(page.getByRole('button', { name: 'Sign up' })).toBeVisible()
  await runAxeScan(page, testInfo)

  // Seed: Alice signs up + posts 2 via API; Bob signs up + follows Alice via
  // API. Then Bob logs into the SPA and composes 1 post.
  const aliceInput = randomSignupInput({ displayName: 'Alice' })
  const bobInput = randomSignupInput({ displayName: 'Bob' })
  const alice = await signupViaApi(apiClient, aliceInput)
  await signupViaApi(apiClient, bobInput)
  const aliceId = alice.id
  expect(aliceId, 'signup must return Alice id').toBeTruthy()

  const { accessToken: aliceToken } = await loginViaApi(apiClient, {
    email: aliceInput.email,
    password: aliceInput.password,
  })
  const { accessToken: bobToken } = await loginViaApi(apiClient, {
    email: bobInput.email,
    password: bobInput.password,
  })

  expect(
    (await apiClient.createPost(aliceToken, { body: 'alice-axe-1' })).status,
  ).toBe(201)
  await new Promise((r) => setTimeout(r, 3))
  expect(
    (await apiClient.createPost(aliceToken, { body: 'alice-axe-2' })).status,
  ).toBe(201)
  expect((await apiClient.follow(bobToken, aliceId!)).status).toBe(204)

  await loginAndLandOnHome(page, bobInput)
  await page.getByLabel('Body').fill('bob-axe-1')
  await page.getByRole('button', { name: 'Post', exact: true }).click()
  await expect(page.getByText('bob-axe-1')).toBeVisible()

  // /home now shows 3 PostCards: Bob's own + Alice's 2.
  await expect(page.getByRole('article', { name: 'Post' })).toHaveCount(3)
  await runAxeScan(page, testInfo)

  // Bob views Alice's profile (followed state).
  await page.goto(`/users/${aliceId}`)
  await expect(
    page.getByRole('heading', { name: aliceInput.displayName }),
  ).toBeVisible()
  await expect(page.getByText(/1 follower\b/i)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Unfollow' })).toBeVisible()
  await runAxeScan(page, testInfo)
})

test('axe scans clean on /not-found (unauthenticated)', async ({
  page,
}, testInfo) => {
  await page.goto('/this-does-not-exist')
  await expect(page.getByText(/not found|404/i).first()).toBeVisible()
  await runAxeScan(page, testInfo)
})

test('axe scans clean on /not-found (authenticated)', async ({
  page,
  apiClient,
}, testInfo) => {
  const input = randomSignupInput()
  await signupViaApi(apiClient, input)
  await loginAndLandOnHome(page, input)

  await page.goto('/this-does-not-exist')
  await expect(page.getByText(/not found|404/i).first()).toBeVisible()
  await runAxeScan(page, testInfo)
})
