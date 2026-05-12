// Explicit axe scans on /login, /signup, and /home. The implicit per-test hook
// in `e2e/src/fixtures/test.ts` already scans the final URL of each test; this
// spec pins clean scans on each of the three key routes explicitly, with the
// /home scan running after a fresh user has logged in and seeded one post so
// the composer and list are both rendered with non-trivial content.
import { test, expect } from '../src/fixtures/test.ts'
import { runAxeScan } from '../src/fixtures/axe.ts'
import { randomSignupInput, signupViaApi } from '../src/helpers/signup.ts'
import { loginAndLandOnHome, loginViaApi } from '../src/helpers/login.ts'

test('axe scans clean across /login, /signup, and /home', async ({
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
  await signupViaApi(apiClient, aliceInput)
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
})
