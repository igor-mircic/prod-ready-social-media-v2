import { test, expect } from '../src/fixtures/test.ts'
import { randomSignupInput, signupViaApi } from '../src/helpers/signup.ts'

async function loginAndLandOnHome(
  page: import('@playwright/test').Page,
  input: { email: string; password: string; displayName: string },
) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(input.email)
  await page.getByLabel('Password').fill(input.password)
  await page.getByRole('button', { name: 'Log in' }).click()
  await expect(
    page.getByRole('heading', { name: `Hello, ${input.displayName}` }),
  ).toBeVisible()
}

test('authenticated user visiting /login is redirected to /home', async ({
  page,
  apiClient,
}) => {
  const input = randomSignupInput()
  await signupViaApi(apiClient, input)
  await loginAndLandOnHome(page, input)

  await page.goto('/login')

  await expect(page).toHaveURL(/\/home$/)
  await expect(
    page.getByRole('heading', { name: `Hello, ${input.displayName}` }),
  ).toBeVisible()
})

test('authenticated user visiting /signup is redirected to /home', async ({
  page,
  apiClient,
}) => {
  const input = randomSignupInput()
  await signupViaApi(apiClient, input)
  await loginAndLandOnHome(page, input)

  await page.goto('/signup')

  await expect(page).toHaveURL(/\/home$/)
  await expect(
    page.getByRole('heading', { name: `Hello, ${input.displayName}` }),
  ).toBeVisible()
})

test('unauthenticated user visiting /home is redirected to /login', async ({ page }) => {
  await page.goto('/home')

  await expect(page).toHaveURL(/\/login$/)
  await expect(page.getByRole('heading', { name: 'Log in' })).toBeVisible()
})
