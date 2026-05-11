import { randomUUID } from 'node:crypto'

import { test, expect } from '../src/fixtures/test.ts'
import { randomSignupInput, signupViaApi } from '../src/helpers/signup.ts'

test('wrong password surfaces an inline role=alert error', async ({ page, apiClient }) => {
  const input = randomSignupInput()
  await signupViaApi(apiClient, input)

  await page.goto('/login')
  await page.getByLabel('Email').fill(input.email)
  await page.getByLabel('Password').fill('Wrong-Password-9!')
  await page.getByRole('button', { name: 'Log in' }).click()

  await expect(page.getByRole('alert')).toBeVisible()
})

test('unknown email error text is byte-for-byte identical to wrong-password error', async ({
  page,
  apiClient,
}) => {
  const input = randomSignupInput()
  await signupViaApi(apiClient, input)

  // Step 1: capture the wrong-password error text for a real account.
  await page.goto('/login')
  await page.getByLabel('Email').fill(input.email)
  await page.getByLabel('Password').fill('Wrong-Password-9!')
  await page.getByRole('button', { name: 'Log in' }).click()
  const wrongPasswordText = (await page.getByRole('alert').innerText()).trim()
  expect(wrongPasswordText.length).toBeGreaterThan(0)

  // Step 2: same form, but with an email that was never registered.
  const unknownEmail = `never-${randomUUID()}@example.test`
  await page.goto('/login')
  await page.getByLabel('Email').fill(unknownEmail)
  await page.getByLabel('Password').fill('Wrong-Password-9!')
  await page.getByRole('button', { name: 'Log in' }).click()
  const unknownEmailText = (await page.getByRole('alert').innerText()).trim()

  expect(unknownEmailText).toBe(wrongPasswordText)
})

test('empty form submit fires no POST /api/v1/auth/login request', async ({ page }) => {
  const loginRequests: string[] = []
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().includes('/api/v1/auth/login')) {
      loginRequests.push(req.url())
    }
  })

  await page.goto('/login')
  await page.getByRole('button', { name: 'Log in' }).click()

  // Wait briefly to ensure no async fetch fired.
  await page.waitForTimeout(150)
  expect(loginRequests).toEqual([])
})
