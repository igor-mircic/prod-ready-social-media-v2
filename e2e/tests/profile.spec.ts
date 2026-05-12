// End-to-end coverage of the /users/:userId profile route: own-profile
// navigation via the rendered PostCard author link, and cross-user direct
// URL navigation. Both scenarios prove the round-trip against the real
// backend and frontend.
import { test, expect } from '../src/fixtures/test.ts'
import { randomSignupInput, signupViaApi } from '../src/helpers/signup.ts'
import { loginAndLandOnHome, loginViaApi } from '../src/helpers/login.ts'

test.describe('user profile route', () => {
  test('author navigates to their own profile via the PostCard author link', async ({
    page,
    apiClient,
  }) => {
    const aliceInput = randomSignupInput({ displayName: 'Alice' })
    const alice = await signupViaApi(apiClient, aliceInput)
    const aliceId = alice.id
    expect(aliceId, 'signup must return Alice id').toBeTruthy()

    const { accessToken: aliceToken } = await loginViaApi(apiClient, {
      email: aliceInput.email,
      password: aliceInput.password,
    })
    const seedBody = 'Profile seed post'
    const seeded = await apiClient.createPost(aliceToken, { body: seedBody })
    expect(seeded.status).toBe(201)

    await loginAndLandOnHome(page, aliceInput)
    await expect(
      page.getByRole('article', { name: 'Post' }).filter({ hasText: seedBody }),
    ).toBeVisible()

    await page.getByRole('link', { name: aliceInput.displayName }).first().click()

    await expect(page).toHaveURL(new RegExp(`/users/${aliceId}$`))
    await expect(page.getByRole('heading', { name: aliceInput.displayName })).toBeVisible()
    await expect(
      page.getByRole('article', { name: 'Post' }).filter({ hasText: seedBody }),
    ).toBeVisible()
    await expect(page.getByRole('textbox')).toHaveCount(0)
  })

  test('non-author visits another user profile directly by URL', async ({ page, apiClient }) => {
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
    const seedBody = 'Profile cross-user seed post'
    const seeded = await apiClient.createPost(aliceToken, { body: seedBody })
    expect(seeded.status).toBe(201)

    await loginAndLandOnHome(page, bobInput)
    await page.goto(`/users/${aliceId}`)

    await expect(page).toHaveURL(new RegExp(`/users/${aliceId}$`))
    await expect(page.getByRole('heading', { name: aliceInput.displayName })).toBeVisible()
    const aliceCard = page.getByRole('article', { name: 'Post' }).filter({ hasText: seedBody })
    await expect(aliceCard).toBeVisible()
    await expect(aliceCard.getByRole('button', { name: 'Delete post' })).toHaveCount(0)
    await expect(page.getByRole('textbox')).toHaveCount(0)
  })
})
