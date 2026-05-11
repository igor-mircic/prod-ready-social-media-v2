import { test, expect } from '../src/fixtures/test.ts'
import { randomSignupInput } from '../src/helpers/signup.ts'

test('signup success card offers a working "Continue to log in" link', async ({ page }) => {
  const input = randomSignupInput()

  await page.goto('/signup')
  await page.getByLabel('Email').fill(input.email)
  await page.getByLabel('Password').fill(input.password)
  await page.getByLabel('Display name').fill(input.displayName)
  await page.getByRole('button', { name: 'Sign up' }).click()

  await expect(page.getByRole('heading', { name: 'Account created' })).toBeVisible()

  const continueLink = page.getByRole('link', { name: /continue to log in/i })
  await expect(continueLink).toBeVisible()
  await continueLink.click()

  await expect(page).toHaveURL(/\/login$/)
  await expect(page.getByRole('heading', { name: 'Log in' })).toBeVisible()
})
