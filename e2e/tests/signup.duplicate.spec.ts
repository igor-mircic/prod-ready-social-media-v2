import { test, expect } from '../src/fixtures/test.ts'
import { randomSignupInput, signupViaApi } from '../src/helpers/signup.ts'

test('signup form surfaces ProblemDetail.detail on duplicate email', async ({
  page,
  apiClient,
}) => {
  const input = randomSignupInput()
  await signupViaApi(apiClient, input)

  const duplicate = await apiClient.signup(input)
  expect(duplicate.status).toBe(409)
  const expectedDetail = (duplicate.body as { detail?: string }).detail
  expect(expectedDetail, 'backend ProblemDetail.detail').toBeTruthy()

  await page.goto('/')
  await page.getByLabel('Email').fill(input.email)
  await page.getByLabel('Password').fill(input.password)
  await page.getByLabel('Display name').fill(input.displayName)
  await page.getByRole('button', { name: 'Sign up' }).click()

  await expect(page.getByRole('alert').filter({ hasText: expectedDetail! })).toBeVisible()
})
