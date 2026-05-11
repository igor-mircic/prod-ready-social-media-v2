import { test, expect } from '../src/fixtures/test.ts'
import { randomSignupInput, signupViaApi } from '../src/helpers/signup.ts'

test('unknown URL renders a 404 indicator for an unauthenticated user', async ({ page }) => {
  await page.goto('/this-does-not-exist')

  await expect(page).toHaveURL(/\/this-does-not-exist$/)
  await expect(page.getByText(/not found|404/i).first()).toBeVisible()
})

test('unknown URL renders a 404 indicator for an authenticated user', async ({
  page,
  apiClient,
}) => {
  const input = randomSignupInput()
  await signupViaApi(apiClient, input)

  await page.goto('/login')
  await page.getByLabel('Email').fill(input.email)
  await page.getByLabel('Password').fill(input.password)
  await page.getByRole('button', { name: 'Log in' }).click()
  await expect(
    page.getByRole('heading', { name: `Hello, ${input.displayName}` }),
  ).toBeVisible()

  await page.goto('/this-does-not-exist')

  await expect(page).toHaveURL(/\/this-does-not-exist$/)
  await expect(page.getByText(/not found|404/i).first()).toBeVisible()
})
