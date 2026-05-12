// Cross-user posts contract: any authenticated user can list another user's
// non-deleted posts, but only the author can delete; a non-author DELETE is
// folded into 404 (non-disclosure) and the post remains visible to its author.
import { test, expect } from '../src/fixtures/test.ts'
import { randomSignupInput, signupViaApi } from '../src/helpers/signup.ts'
import { loginAndLandOnHome } from '../src/helpers/login.ts'
import type {
  LoginResponse,
  PostListResponse,
  PostResponse,
  ProblemDetail,
} from '../src/api/generated/openAPIDefinition.schemas.ts'

test.describe('posts cross-user contract', () => {
  test('Bob can list Alice\'s post; Bob\'s delete is rejected 404; Alice\'s post remains', async ({
    page,
    apiClient,
  }) => {
    // 1. Alice and Bob sign up via API.
    const aliceInput = randomSignupInput({ displayName: 'Alice' })
    const bobInput = randomSignupInput({ displayName: 'Bob' })
    const alice = await signupViaApi(apiClient, aliceInput)
    await signupViaApi(apiClient, bobInput)
    const aliceId = alice.id
    expect(aliceId, 'signup must return Alice\'s id').toBeTruthy()

    // 2. Alice logs in through the SPA.
    await loginAndLandOnHome(page, aliceInput)

    // 3. Alice composes a post via the SPA; capture the new post id from the
    //    POST /api/v1/posts response body.
    const body = `Hello from Alice ${Date.now()}`
    const composeResponsePromise = page.waitForResponse(
      (res) => res.url().includes('/api/v1/posts') && res.request().method() === 'POST',
    )
    await page.getByLabel('Body').fill(body)
    await page.getByRole('button', { name: 'Post', exact: true }).click()
    const composeResponse = await composeResponsePromise
    expect(composeResponse.status()).toBe(201)
    const createdPost = (await composeResponse.json()) as PostResponse
    const alicePostId = createdPost.id
    expect(alicePostId, 'create-post response must include id').toBeTruthy()

    // 4. Alice's post is visible in her rendered list.
    await expect(page.getByText(body)).toBeVisible()

    // 5. Bob logs in via API; extract bearer access token.
    const bobLogin = await apiClient.login({
      email: bobInput.email,
      password: bobInput.password,
    })
    expect(bobLogin.status).toBe(200)
    const bobToken = (bobLogin.body as LoginResponse).accessToken
    expect(bobToken, 'login response must include accessToken').toBeTruthy()

    // 6. Bob lists Alice's posts; sees her post.
    const list = await apiClient.listPostsByAuthor(bobToken, aliceId as string)
    expect(list.status).toBe(200)
    const listBody = list.body as PostListResponse
    expect(listBody.items?.length ?? 0).toBeGreaterThanOrEqual(1)
    const match = listBody.items?.find((p) => p.id === alicePostId)
    expect(match, 'Alice\'s post must appear in Bob\'s listing').toBeDefined()
    expect(match?.body).toBe(body)

    // 7. Bob's delete attempt is rejected with 404 (non-disclosure).
    const del = await apiClient.deletePost(bobToken, alicePostId as string)
    expect(del.status).toBe(404)
    const problem = del.body as ProblemDetail
    expect(problem.status).toBe(404)

    // 8. Alice reloads /home; her post is still rendered.
    await page.reload()
    await expect(page.getByText(body)).toBeVisible()
  })
})
