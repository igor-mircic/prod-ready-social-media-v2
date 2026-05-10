import { test, expect } from '../src/fixtures/test.ts'
import { randomSignupInput } from '../src/helpers/signup.ts'

test('signup happy path creates an account that the API recognises', async ({
  page,
  apiClient,
}) => {
  const input = randomSignupInput()

  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Create account' })).toBeVisible()

  await page.getByLabel('Email').fill(input.email)
  await page.getByLabel('Password').fill(input.password)
  await page.getByLabel('Display name').fill(input.displayName)
  await page.getByRole('button', { name: 'Sign up' }).click()

  await expect(page.getByRole('heading', { name: 'Account created' })).toBeVisible()
  await expect(page.getByText(`Welcome, ${input.displayName}.`)).toBeVisible()

  const duplicate = await apiClient.signup(input)
  expect(duplicate.status).toBe(409)
})
