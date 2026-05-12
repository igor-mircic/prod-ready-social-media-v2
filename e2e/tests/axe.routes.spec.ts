// Explicit axe scans on /login, /signup, /home, and /users/:userId. The
// implicit per-test hook in `e2e/src/fixtures/test.ts` already scans the
// final URL of each test; this spec pins clean scans on each of the four
// key routes explicitly. The /home and /users/:userId scans run after a
// fresh user has logged in and seeded one post so the composer and list
// (on /home) and the profile header + seeded post (on /users/:userId) are
// both rendered with non-trivial content.
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

  const aliceInput = randomSignupInput({ displayName: 'Alice' })
  const alice = await signupViaApi(apiClient, aliceInput)
  const aliceId = alice.id
  expect(aliceId, 'signup must return Alice id').toBeTruthy()
  const { accessToken: aliceToken } = await loginViaApi(apiClient, {
    email: aliceInput.email,
    password: aliceInput.password,
  })

  const seedBody = 'Axe seed post'
  const seeded = await apiClient.createPost(aliceToken, { body: seedBody })
  expect(seeded.status).toBe(201)

  await loginAndLandOnHome(page, aliceInput)
  await expect(
    page.getByRole('article', { name: 'Post' }).filter({ hasText: seedBody }),
  ).toBeVisible()
  await runAxeScan(page, testInfo)

  await page.goto(`/users/${aliceId}`)
  await expect(page.getByRole('heading', { name: aliceInput.displayName })).toBeVisible()
  await expect(
    page.getByRole('article', { name: 'Post' }).filter({ hasText: seedBody }),
  ).toBeVisible()
  await runAxeScan(page, testInfo)
})

test('axe scans clean on /not-found (unauthenticated)', async ({ page }, testInfo) => {
  await page.goto('/this-does-not-exist')
  await expect(page.getByText(/not found|404/i).first()).toBeVisible()
  await runAxeScan(page, testInfo)
})

test('axe scans clean on /not-found (authenticated)', async ({ page, apiClient }, testInfo) => {
  const input = randomSignupInput()
  await signupViaApi(apiClient, input)
  await loginAndLandOnHome(page, input)

  await page.goto('/this-does-not-exist')
  await expect(page.getByText(/not found|404/i).first()).toBeVisible()
  await runAxeScan(page, testInfo)
})
