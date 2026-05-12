import { test, expect } from '../src/fixtures/test.ts'
import { randomSignupInput, signupViaApi } from '../src/helpers/signup.ts'
import { loginAndLandOnHome } from '../src/helpers/login.ts'

test('posts vertical: compose, see in list, delete, list updates', async ({
  page,
  apiClient,
}) => {
  const input = randomSignupInput()
  await signupViaApi(apiClient, input)
  await loginAndLandOnHome(page, input)

  const body = `Hello from e2e ${Date.now()}`

  await page.getByLabel('Body').fill(body)
  await page.getByRole('button', { name: 'Post', exact: true }).click()

  // The new post appears in the rendered list.
  await expect(page.getByText(body)).toBeVisible()

  // The delete control is visible on the caller's own post; click it.
  const postCard = page.getByRole('article', { name: 'Post' }).filter({ hasText: body })
  await postCard.getByRole('button', { name: 'Delete post' }).click()

  // The post disappears.
  await expect(page.getByText(body)).toHaveCount(0)
})

test('composer: empty body cannot be submitted client-side', async ({ page, apiClient }) => {
  const input = randomSignupInput()
  await signupViaApi(apiClient, input)
  await loginAndLandOnHome(page, input)

  const submit = page.getByRole('button', { name: 'Post', exact: true })

  // With an empty body the Post button must be disabled (zod refine + RHF).
  await expect(submit).toBeDisabled()

  // Best-effort: attempt to click anyway and assert no POST hit the wire.
  // The disabled attribute prevents the click event, so this is mostly a
  // belt-and-braces check against accidental network traffic.
  let postFired = false
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().includes('/api/v1/posts')) {
      postFired = true
    }
  })
  await submit.click({ force: true }).catch(() => {
    // Disabled buttons throw under strict modes; that's the expected branch.
  })
  await page.waitForTimeout(150)
  expect(postFired).toBe(false)
})
