import { test, expect } from '../src/fixtures/test.ts'
import { randomSignupInput, signupViaApi } from '../src/helpers/signup.ts'

test('reload after login keeps the session on /home', async ({ page, apiClient }) => {
  const input = randomSignupInput()
  await signupViaApi(apiClient, input)

  await page.goto('/login')
  await page.getByLabel('Email').fill(input.email)
  await page.getByLabel('Password').fill(input.password)
  await page.getByRole('button', { name: 'Log in' }).click()
  await expect(
    page.getByRole('heading', { name: `Hello, ${input.displayName}` }),
  ).toBeVisible()

  await page.reload()

  await expect(page).toHaveURL(/\/home$/)
  await expect(
    page.getByRole('heading', { name: `Hello, ${input.displayName}` }),
  ).toBeVisible()
})

test('reload after logout stays on /login', async ({ page, apiClient }) => {
  const input = randomSignupInput()
  await signupViaApi(apiClient, input)

  await page.goto('/login')
  await page.getByLabel('Email').fill(input.email)
  await page.getByLabel('Password').fill(input.password)
  await page.getByRole('button', { name: 'Log in' }).click()
  await expect(
    page.getByRole('heading', { name: `Hello, ${input.displayName}` }),
  ).toBeVisible()

  await page.getByRole('button', { name: 'Log out' }).click()
  await expect(page.getByRole('heading', { name: 'Log in' })).toBeVisible()

  await page.reload()

  await expect(page).toHaveURL(/\/login$/)
  await expect(page.getByRole('heading', { name: 'Log in' })).toBeVisible()
})
