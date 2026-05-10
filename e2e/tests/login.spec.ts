import { test, expect } from '../src/fixtures/test.ts'
import { randomSignupInput, signupViaApi } from '../src/helpers/signup.ts'

test('login flow: signup, log in, see /home, log out', async ({ page, apiClient }) => {
  const input = randomSignupInput()
  await signupViaApi(apiClient, input)

  await page.goto('/login')
  await expect(page.getByRole('heading', { name: 'Log in' })).toBeVisible()

  await page.getByLabel('Email').fill(input.email)
  await page.getByLabel('Password').fill(input.password)
  await page.getByRole('button', { name: 'Log in' }).click()

  await expect(page.getByRole('heading', { name: `Hello, ${input.displayName}` })).toBeVisible()

  await page.getByRole('button', { name: 'Log out' }).click()
  await expect(page.getByRole('heading', { name: 'Log in' })).toBeVisible()
})
