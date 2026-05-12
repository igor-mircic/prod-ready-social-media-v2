// Proves server-side access-token revocation on SPA logout. The existing
// auth.session.spec.ts pins the SPA-side outcome (URL stays on /login after
// reload); this spec pins the security half by capturing the access token
// from the SPA's login response, driving the SPA logout via the UI, then
// replaying the captured token against a protected endpoint and asserting 401.
import { test, expect } from '../src/fixtures/test.ts'
import { randomSignupInput, signupViaApi } from '../src/helpers/signup.ts'
import { getMeUrl } from '../src/api/generated/auth-controller/auth-controller.ts'
import type { LoginResponse } from '../src/api/generated/openAPIDefinition.schemas.ts'

test('logout: replayed access token is rejected by the backend', async ({
  page,
  apiClient,
  backendURL,
}) => {
  const input = randomSignupInput()
  await signupViaApi(apiClient, input)

  let capturedToken: string | undefined
  page.on('response', async (res) => {
    if (
      res.request().method() === 'POST' &&
      /\/api\/v1\/auth\/login(\?|$)/.test(res.url()) &&
      res.status() === 200
    ) {
      const body = (await res.json()) as LoginResponse
      capturedToken = body.accessToken
    }
  })

  await page.goto('/login')
  await page.getByLabel('Email').fill(input.email)
  await page.getByLabel('Password').fill(input.password)
  await page.getByRole('button', { name: 'Log in' }).click()
  await expect(
    page.getByRole('heading', { name: `Hello, ${input.displayName}` }),
  ).toBeVisible()

  expect(capturedToken).toBeTruthy()
  expect(typeof capturedToken).toBe('string')
  expect((capturedToken as string).length).toBeGreaterThan(0)

  await page.getByRole('button', { name: 'Log out' }).click()
  await expect(page).toHaveURL(/\/login$/)
  await expect(page.getByRole('heading', { name: 'Log in' })).toBeVisible()

  const replay = await fetch(`${backendURL}${getMeUrl()}`, {
    method: 'GET',
    headers: {
      Accept: 'application/json, application/problem+json',
      Authorization: `Bearer ${capturedToken}`,
    },
  })
  expect(replay.status).toBe(401)
})
