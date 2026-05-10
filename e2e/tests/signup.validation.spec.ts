import { test, expect } from '../src/fixtures/test.ts'
import { randomSignupInput } from '../src/helpers/signup.ts'

const cases = [
  {
    label: 'short password',
    overrides: { password: 'short' },
  },
  {
    label: 'malformed email',
    overrides: { email: 'not-an-email' },
  },
  {
    label: 'oversized displayName',
    overrides: { displayName: 'x'.repeat(81) },
  },
] as const

for (const { label, overrides } of cases) {
  test(`signup validation: ${label} blocks submission and shows inline error`, async ({
    page,
  }) => {
    const requests: string[] = []
    page.on('request', (req) => {
      if (req.url().includes('/api/v1/auth/signup')) {
        requests.push(req.url())
      }
    })

    const input = randomSignupInput(overrides)

    await page.goto('/')
    await page.getByLabel('Email').fill(input.email)
    await page.getByLabel('Password').fill(input.password)
    await page.getByLabel('Display name').fill(input.displayName)
    await page.getByRole('button', { name: 'Sign up' }).click()

    await expect(page.getByRole('alert').first()).toBeVisible()
    expect(requests, `no signup request should fire for ${label}`).toEqual([])
  })
}
