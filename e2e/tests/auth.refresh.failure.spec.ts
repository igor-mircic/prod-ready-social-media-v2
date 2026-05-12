// Proves the SPA's refresh-failure → clear AuthContext → redirect-to-/login
// wire end-to-end against the real backend. Cookie surgery via
// page.context().addCookies overwrites the browser's refresh_token cookie
// with a bogus opaque value; the backend's POST /api/v1/auth/refresh returns
// 401 because no auth_refresh_tokens row matches the bogus hash; the SPA's
// refreshFailureHandler (registered by AuthProvider, wired to
// onSessionExpired) clears auth state and navigates to /login.
import { randomUUID } from 'node:crypto'
import { test, expect } from '../src/fixtures/test.ts'
import { randomSignupInput, signupViaApi } from '../src/helpers/signup.ts'
import { loginAndLandOnHome } from '../src/helpers/login.ts'

test('refresh failure: bogus refresh cookie causes /refresh 401 and SPA bounces to /login', async ({
  page,
  apiClient,
}) => {
  const input = randomSignupInput()
  await signupViaApi(apiClient, input)
  await loginAndLandOnHome(page, input)

  const allCookies = await page.context().cookies()
  const liveRefresh = allCookies.find((c) => c.name === 'refresh_token')
  expect(liveRefresh, `expected live refresh_token cookie: ${JSON.stringify(allCookies)}`)
    .toBeTruthy()

  await page.context().addCookies([
    {
      name: 'refresh_token',
      value: `bogus-${randomUUID()}`,
      domain: liveRefresh!.domain,
      path: liveRefresh!.path,
      httpOnly: liveRefresh!.httpOnly,
      sameSite: liveRefresh!.sameSite,
      secure: liveRefresh!.secure,
      expires: liveRefresh!.expires,
    },
  ])
  const afterOverwrite = (await page.context().cookies()).find((c) => c.name === 'refresh_token')
  expect(afterOverwrite?.value).toMatch(/^bogus-/)

  type Captured = { method: string; url: string; status: number }
  const captured: Captured[] = []
  page.on('response', (res) => {
    const url = res.url()
    const method = res.request().method()
    if (method === 'POST' && /\/api\/v1\/posts(\?|$)/.test(url)) {
      captured.push({ method, url, status: res.status() })
    } else if (method === 'POST' && /\/api\/v1\/auth\/refresh(\?|$)/.test(url)) {
      captured.push({ method, url, status: res.status() })
    }
  })

  // Lapsing app.auth.access-token-ttl = PT2S (configured by the harness in
  // e2e/src/setup/backend.ts). The 1000ms margin absorbs WebKit timer skew.
  const TTL_MS = 2000
  await page.waitForTimeout(TTL_MS + 1000)

  const body = `Refresh-failure ${Date.now()}`
  await page.getByLabel('Body').fill(body)
  await page.getByRole('button', { name: 'Post', exact: true }).click()

  await expect(page).toHaveURL(/\/login$/)
  await expect(page.getByRole('heading', { name: 'Log in' })).toBeVisible()

  const postsSeq = captured.filter((r) => /\/api\/v1\/posts(\?|$)/.test(r.url))
  const refreshSeq = captured.filter((r) => /\/api\/v1\/auth\/refresh(\?|$)/.test(r.url))
  expect(postsSeq.length, `POST /posts sequence: ${JSON.stringify(captured)}`).toBe(1)
  expect(postsSeq[0]?.status).toBe(401)
  expect(refreshSeq.length, `refresh sequence: ${JSON.stringify(captured)}`).toBe(1)
  expect(refreshSeq[0]?.status).toBe(401)
})
