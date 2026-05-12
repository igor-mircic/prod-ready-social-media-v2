// Proves the SPA's single-flight refresh guard end-to-end against the real
// backend. Two PostCard.Delete buttons each own an independent useDeletePost
// mutation; both clicked in parallel after the access token has lapsed fire
// two near-simultaneous DELETE /api/v1/posts/{id} requests through the same
// Axios mutator. The `inflightRefresh` module-scoped promise in
// frontend/src/api/client.ts SHALL serialize the two 401s into a single
// /refresh call, and both DELETE retries SHALL succeed against the rotated
// access token. The SPA stays on /home.
import { test, expect } from '../src/fixtures/test.ts'
import { randomSignupInput, signupViaApi } from '../src/helpers/signup.ts'
import { loginViaApi, loginAndLandOnHome } from '../src/helpers/login.ts'

test('refresh single-flight: concurrent 401s share exactly one /refresh', async ({
  page,
  apiClient,
}) => {
  const input = randomSignupInput()
  await signupViaApi(apiClient, input)
  const { accessToken } = await loginViaApi(apiClient, {
    email: input.email,
    password: input.password,
  })
  const bodyA = `single-flight A ${Date.now()}`
  const bodyB = `single-flight B ${Date.now()}`
  await apiClient.createPost(accessToken, { body: bodyA })
  await apiClient.createPost(accessToken, { body: bodyB })

  await loginAndLandOnHome(page, input)

  const articles = page.getByRole('article', { name: 'Post' })
  await expect(articles).toHaveCount(2)
  const deleteA = articles.filter({ hasText: bodyA }).getByRole('button', { name: 'Delete post' })
  const deleteB = articles.filter({ hasText: bodyB }).getByRole('button', { name: 'Delete post' })
  await expect(deleteA).toBeEnabled()
  await expect(deleteB).toBeEnabled()

  // Throttle the refresh response so both DELETE 401s reach `refreshOnce`
  // while the in-flight refresh promise is still pending. Without this, fast
  // browsers (esp. Firefox) complete A's whole 401→refresh→retry cycle
  // before B's click even actuates, and each DELETE ends up firing its own
  // refresh — defeating the single-flight property under test. This is
  // network shaping (a Playwright route handler), not a test-flow sleep.
  await page.route('**/api/v1/auth/refresh', async (route) => {
    await new Promise((r) => setTimeout(r, 800))
    await route.continue()
  })

  type Captured = { method: string; url: string; status: number }
  const captured: Captured[] = []
  page.on('response', (res) => {
    const url = res.url()
    const method = res.request().method()
    if (method === 'DELETE' && /\/api\/v1\/posts\/[^/?]+(\?|$)/.test(url)) {
      captured.push({ method, url, status: res.status() })
    } else if (method === 'POST' && /\/api\/v1\/auth\/refresh(\?|$)/.test(url)) {
      captured.push({ method, url, status: res.status() })
    }
  })

  // Lapsing app.auth.access-token-ttl = PT2S (configured by the harness in
  // e2e/src/setup/backend.ts). The 1000ms margin absorbs WebKit timer skew.
  const TTL_MS = 2000
  await page.waitForTimeout(TTL_MS + 1000)

  // Dispatch both clicks within the same JS tick so the two `mutate()` calls
  // fire their DELETE requests near-simultaneously. Promise.all on two
  // Playwright clicks serializes per-click actionability checks, which on
  // some browsers spaces the two clicks far enough apart that the first
  // DELETE's full 401→refresh→retry cycle completes before the second
  // click even actuates — i.e. there is no concurrency to test.
  await page.evaluate(() => {
    const buttons = Array.from(
      document.querySelectorAll<HTMLButtonElement>('button[aria-label="Delete post"]'),
    )
    for (const b of buttons) b.click()
  })

  await expect(articles).toHaveCount(0)

  const deletesSeq = captured.filter((r) => r.method === 'DELETE')
  const refreshSeq = captured.filter((r) => r.method === 'POST')
  expect(refreshSeq.length, `refresh sequence: ${JSON.stringify(captured)}`).toBe(1)
  expect(refreshSeq[0]?.status).toBe(200)
  expect(deletesSeq.length, `delete sequence: ${JSON.stringify(captured)}`).toBe(4)
  const deletes401 = deletesSeq.filter((r) => r.status === 401)
  const deletes204 = deletesSeq.filter((r) => r.status === 204)
  expect(deletes401.length).toBe(2)
  expect(deletes204.length).toBe(2)

  const refreshIndex = captured.findIndex(
    (r) => r.method === 'POST' && /\/api\/v1\/auth\/refresh(\?|$)/.test(r.url),
  )
  const delete401Indices = captured
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => r.method === 'DELETE' && r.status === 401)
    .map(({ i }) => i)
  const delete204Indices = captured
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => r.method === 'DELETE' && r.status === 204)
    .map(({ i }) => i)
  expect(refreshIndex).toBeGreaterThanOrEqual(0)
  for (const i of delete401Indices) expect(i).toBeLessThan(refreshIndex)
  for (const i of delete204Indices) expect(i).toBeGreaterThan(refreshIndex)

  expect(page.url()).toMatch(/\/home$/)
})
