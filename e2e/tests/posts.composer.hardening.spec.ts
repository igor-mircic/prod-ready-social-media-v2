// Pins the composer's hardening contract: HTML payloads render as literal text,
// rapid double-clicks produce exactly one post and one network call, and the
// 500-character cap on the textarea is enforced by the browser.
import { test, expect } from '../src/fixtures/test.ts'
import { randomSignupInput, signupViaApi } from '../src/helpers/signup.ts'
import { loginAndLandOnHome, loginViaApi } from '../src/helpers/login.ts'
import { XSS_PAYLOAD, maxLengthBody } from './fixtures/payloads.ts'
import type {
  PostListResponse,
  UserResponse,
} from '../src/api/generated/openAPIDefinition.schemas.ts'

test('composer: XSS payload renders as literal text, not HTML', async ({ page, apiClient }) => {
  const aliceInput = randomSignupInput({ displayName: 'Alice' })
  await signupViaApi(apiClient, aliceInput)
  await loginAndLandOnHome(page, aliceInput)

  await page.getByLabel('Body').fill(XSS_PAYLOAD)
  await page.getByRole('button', { name: 'Post', exact: true }).click()

  const postCard = page
    .getByRole('article', { name: 'Post' })
    .filter({ hasText: 'onerror=' })
  await expect(postCard).toHaveCount(1)
  await expect(postCard).toContainText(XSS_PAYLOAD)
  await expect(postCard.locator('script')).toHaveCount(0)
  await expect(postCard.locator('img')).toHaveCount(0)

  const xssGlobal = await page.evaluate(
    () => (globalThis as unknown as { __xss?: boolean }).__xss,
  )
  expect(xssGlobal).toBeUndefined()
})

test('composer: rapid double-click produces exactly one post and one network call', async ({
  page,
  apiClient,
}) => {
  const aliceInput = randomSignupInput({ displayName: 'Alice' })
  const alice: UserResponse = await signupViaApi(apiClient, aliceInput)
  const aliceId = alice.id as string
  expect(aliceId).toBeTruthy()

  const { accessToken: aliceToken } = await loginViaApi(apiClient, {
    email: aliceInput.email,
    password: aliceInput.password,
  })

  await loginAndLandOnHome(page, aliceInput)

  let createPostCount = 0
  page.on('request', (req) => {
    if (req.method() === 'POST' && /\/api\/v1\/posts(\?|$)/.test(req.url())) {
      createPostCount += 1
    }
  })

  const body = `Double-submit guard ${Date.now()}`
  await page.getByLabel('Body').fill(body)

  const submit = page.getByRole('button', { name: 'Post', exact: true })
  await Promise.all([submit.click({ force: true }), submit.click({ force: true })])

  const card = page.getByRole('article', { name: 'Post' }).filter({ hasText: body })
  await expect(card).toHaveCount(1)
  // Buffer for any belated duplicate POST to materialize on the wire. Mirrors
  // the timeout-after-force-click pattern already used in `posts.spec.ts`.
  await page.waitForTimeout(300)

  expect(createPostCount, 'exactly one POST /api/v1/posts must reach the wire').toBe(1)

  const list = await apiClient.listPostsByAuthor(aliceToken, aliceId)
  expect(list.status).toBe(200)
  const listBody = list.body as PostListResponse
  expect(listBody.items?.length ?? 0).toBe(1)
  expect(listBody.items?.[0]?.body).toBe(body)
})

test('composer: 500-character body submits and renders at length 500', async ({
  page,
  apiClient,
}) => {
  const aliceInput = randomSignupInput({ displayName: 'Alice' })
  await signupViaApi(apiClient, aliceInput)
  await loginAndLandOnHome(page, aliceInput)

  const body500 = maxLengthBody(500)
  expect(body500).toHaveLength(500)

  await page.getByLabel('Body').fill(body500)
  await page.getByRole('button', { name: 'Post', exact: true }).click()

  const card = page.getByRole('article', { name: 'Post' }).filter({ hasText: body500 })
  await expect(card).toHaveCount(1)
  const renderedBody = await card.locator('p').nth(1).innerText()
  expect(renderedBody).toHaveLength(500)
  expect(renderedBody).toBe(body500)
})

test('composer: 600-character fill is truncated to 500 before submission', async ({
  page,
  apiClient,
}) => {
  const aliceInput = randomSignupInput({ displayName: 'Alice' })
  await signupViaApi(apiClient, aliceInput)
  await loginAndLandOnHome(page, aliceInput)

  const body600 = maxLengthBody(600)
  expect(body600).toHaveLength(600)
  const truncated = body600.slice(0, 500)

  const textarea = page.getByLabel('Body')
  await textarea.fill(body600)
  await expect(textarea).toHaveValue(truncated)

  await page.getByRole('button', { name: 'Post', exact: true }).click()

  const card = page.getByRole('article', { name: 'Post' }).filter({ hasText: truncated })
  await expect(card).toHaveCount(1)
  const renderedBody = await card.locator('p').nth(1).innerText()
  expect(renderedBody).toHaveLength(500)
  expect(renderedBody).toBe(truncated)
})
