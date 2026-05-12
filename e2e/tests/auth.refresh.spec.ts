// Proves the SPA's Axios refresh-on-401 wire end-to-end against the real
// backend. The e2e harness boots the backend with a short
// `app.auth.access-token-ttl` (see `e2e/src/setup/backend.ts`); this test
// lapses the access token mid-session, triggers a protected SPA action, and
// asserts the network sequence shows one 401 followed by one /refresh
// followed by a successful retry — and that the SPA stays on /home.
import { test, expect } from '../src/fixtures/test.ts'
import { randomSignupInput, signupViaApi } from '../src/helpers/signup.ts'
import { loginAndLandOnHome } from '../src/helpers/login.ts'

test('refresh-on-401: lapsed access token triggers transparent refresh + retry', async ({
  page,
  apiClient,
}) => {
  const input = randomSignupInput()
  await signupViaApi(apiClient, input)
  await loginAndLandOnHome(page, input)

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

  const body = `Refresh-on-401 ${Date.now()}`
  await page.getByLabel('Body').fill(body)
  await page.getByRole('button', { name: 'Post', exact: true }).click()

  const postCard = page.getByRole('article', { name: 'Post' }).filter({ hasText: body })
  await expect(postCard).toBeVisible()

  const postsSeq = captured.filter((r) => /\/api\/v1\/posts(\?|$)/.test(r.url))
  const refreshSeq = captured.filter((r) => /\/api\/v1\/auth\/refresh(\?|$)/.test(r.url))
  expect(postsSeq.length, `POST /posts sequence: ${JSON.stringify(captured)}`).toBe(2)
  expect(postsSeq[0]?.status).toBe(401)
  expect(postsSeq[1]?.status).toBe(201)
  expect(refreshSeq.length, `refresh sequence: ${JSON.stringify(captured)}`).toBe(1)
  expect(refreshSeq[0]?.status).toBe(200)

  const posts401Index = captured.findIndex(
    (r) => /\/api\/v1\/posts(\?|$)/.test(r.url) && r.status === 401,
  )
  const refreshIndex = captured.findIndex(
    (r) => /\/api\/v1\/auth\/refresh(\?|$)/.test(r.url) && r.status === 200,
  )
  const posts201Index = captured.findIndex(
    (r) => /\/api\/v1\/posts(\?|$)/.test(r.url) && r.status === 201,
  )
  expect(posts401Index).toBeGreaterThanOrEqual(0)
  expect(refreshIndex).toBeGreaterThan(posts401Index)
  expect(posts201Index).toBeGreaterThan(refreshIndex)

  expect(page.url()).toMatch(/\/home$/)
})
