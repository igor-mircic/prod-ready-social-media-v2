// End-to-end coverage of the home feed: the UI vertical proves that following /
// unfollowing through the SPA reflects on /home; the API-edges block covers the
// corner cases that don't surface in the UI (empty, self-fanout, cursor
// pagination, malformed cursor, unauth, re-follow idempotency).
import { test, expect } from '../src/fixtures/test.ts'
import { getGetFeedUrl } from '../src/api/generated/feed-controller/feed-controller.ts'
import { randomSignupInput, signupViaApi } from '../src/helpers/signup.ts'
import { loginAndLandOnHome, loginViaApi } from '../src/helpers/login.ts'
import type {
  PostListResponse,
  PostResponse,
} from '../src/api/generated/openAPIDefinition.schemas.ts'

test.describe('UI vertical', () => {
  test("Bob's home feed reflects follow / unfollow of Alice", async ({
    page,
    apiClient,
  }) => {
    const aliceInput = randomSignupInput({ displayName: 'Alice' })
    const bobInput = randomSignupInput({ displayName: 'Bob' })
    const alice = await signupViaApi(apiClient, aliceInput)
    await signupViaApi(apiClient, bobInput)
    const aliceId = alice.id!

    const { accessToken: aliceToken } = await loginViaApi(apiClient, {
      email: aliceInput.email,
      password: aliceInput.password,
    })

    // Alice posts 2 posts via the API (timestamps distinct).
    await apiClient.createPost(aliceToken, { body: 'alice-1' })
    await new Promise((r) => setTimeout(r, 3))
    const aliceSecond = (
      await apiClient.createPost(aliceToken, { body: 'alice-2' })
    ).body as PostResponse
    expect(aliceSecond.id, 'alice-2 must have an id').toBeTruthy()

    // Bob composes 1 post through the SPA composer.
    await loginAndLandOnHome(page, bobInput)
    await page.getByLabel('Body').fill('bob-1')
    await page.getByRole('button', { name: 'Post', exact: true }).click()
    await expect(page.getByText('bob-1')).toBeVisible()

    // Sanity: only Bob's own post is on /home (he doesn't follow Alice yet).
    await expect(page.getByRole('article', { name: 'Post' })).toHaveCount(1)
    await expect(page.getByText('alice-1')).toBeHidden()
    await expect(page.getByText('alice-2')).toBeHidden()

    // Follow Alice via her profile.
    await page.goto(`/users/${aliceId}`)
    await expect(page.getByRole('button', { name: 'Follow' })).toBeVisible()
    await page.getByRole('button', { name: 'Follow' }).click()
    await expect(page.getByRole('button', { name: 'Unfollow' })).toBeVisible()

    // Back to /home: 3 posts (Bob's one + Alice's two). Order is
    // (created_at DESC) which depends on actual seeding timing, so we assert
    // contents rather than position here; the alice-fresh "topmost" check
    // below is the load-bearing order assertion.
    await page.goto('/home')
    await expect(page.getByRole('article', { name: 'Post' })).toHaveCount(3)
    await expect(page.getByText('bob-1')).toBeVisible()
    await expect(page.getByText('alice-1')).toBeVisible()
    await expect(page.getByText('alice-2')).toBeVisible()

    // Alice posts a new third post via the API.
    await new Promise((r) => setTimeout(r, 3))
    await apiClient.createPost(aliceToken, { body: 'alice-fresh' })

    // Reload /home: 4 posts, alice-fresh on top.
    await page.reload()
    await expect(page.getByRole('article', { name: 'Post' })).toHaveCount(4)
    await expect(
      page.getByRole('article', { name: 'Post' }).first(),
    ).toContainText('alice-fresh')

    // Unfollow Alice via her profile; /home returns to 1 post.
    await page.goto(`/users/${aliceId}`)
    await page.getByRole('button', { name: 'Unfollow' }).click()
    await expect(page.getByRole('button', { name: 'Follow' })).toBeVisible()

    await page.goto('/home')
    await expect(page.getByRole('article', { name: 'Post' })).toHaveCount(1)
    await expect(page.getByText('bob-1')).toBeVisible()
    await expect(page.getByText('alice-1')).toBeHidden()
  })
})

test.describe('API edges', () => {
  test('brand-new user gets empty feed via API', async ({ apiClient }) => {
    const input = randomSignupInput({ displayName: 'Solo' })
    await signupViaApi(apiClient, input)
    const { accessToken } = await loginViaApi(apiClient, {
      email: input.email,
      password: input.password,
    })

    const res = await apiClient.getFeed(accessToken)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ items: [], nextCursor: null })
  })

  test('self-fanout: a fresh user authoring a post via SPA sees it via apiClient.getFeed', async ({
    page,
    apiClient,
  }) => {
    const input = randomSignupInput({ displayName: 'Alice' })
    await signupViaApi(apiClient, input)
    const { accessToken } = await loginViaApi(apiClient, {
      email: input.email,
      password: input.password,
    })

    const body = `self-fanout-${Date.now()}`
    await loginAndLandOnHome(page, input)
    await page.getByLabel('Body').fill(body)
    await page.getByRole('button', { name: 'Post', exact: true }).click()
    await expect(page.getByText(body)).toBeVisible()

    const res = await apiClient.getFeed(accessToken)
    expect(res.status).toBe(200)
    const list = res.body as PostListResponse
    expect(list.items?.length).toBe(1)
    expect(list.items?.[0]?.body).toBe(body)
  })

  test('cursor pagination walks a 21-post multi-author feed across two pages', async ({
    apiClient,
  }) => {
    const aliceInput = randomSignupInput({ displayName: 'Alice' })
    const bobInput = randomSignupInput({ displayName: 'Bob' })
    const alice = await signupViaApi(apiClient, aliceInput)
    await signupViaApi(apiClient, bobInput)
    const { accessToken: aliceToken } = await loginViaApi(apiClient, {
      email: aliceInput.email,
      password: aliceInput.password,
    })
    const { accessToken: bobToken } = await loginViaApi(apiClient, {
      email: bobInput.email,
      password: bobInput.password,
    })

    // Bob follows Alice BEFORE posts are created so Alice's 11 posts forward-
    // fan-out into Bob's feed. Bob's own 10 posts self-fanout.
    expect((await apiClient.follow(bobToken, alice.id!)).status).toBe(204)

    // Alice posts 11.
    for (let i = 0; i < 11; i++) {
      await apiClient.createPost(aliceToken, { body: `alice-${i}` })
      await new Promise((r) => setTimeout(r, 2))
    }
    // Bob posts 10.
    for (let i = 0; i < 10; i++) {
      await apiClient.createPost(bobToken, { body: `bob-${i}` })
      await new Promise((r) => setTimeout(r, 2))
    }

    const page1 = await apiClient.getFeed(bobToken, { limit: 20 })
    expect(page1.status).toBe(200)
    const page1Body = page1.body as PostListResponse
    expect(page1Body.items?.length).toBe(20)
    expect(page1Body.nextCursor).toBeTruthy()

    const page2 = await apiClient.getFeed(bobToken, {
      limit: 20,
      cursor: page1Body.nextCursor as string,
    })
    expect(page2.status).toBe(200)
    const page2Body = page2.body as PostListResponse
    expect(page2Body.items?.length).toBe(1)
    expect(page2Body.nextCursor).toBeNull()

    const collected = new Set<string>([
      ...(page1Body.items ?? []).map((p) => p.body ?? ''),
      ...(page2Body.items ?? []).map((p) => p.body ?? ''),
    ])
    expect(collected.size).toBe(21)
  })

  test('malformed cursor returns 400 + ProblemDetail', async ({
    apiClient,
  }) => {
    const input = randomSignupInput({ displayName: 'Alice' })
    await signupViaApi(apiClient, input)
    const { accessToken } = await loginViaApi(apiClient, {
      email: input.email,
      password: input.password,
    })

    const res = await apiClient.getFeed(accessToken, {
      cursor: 'not-base64url-something',
    })
    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({ status: 400 })
  })

  test('unauthenticated returns 401 + ProblemDetail', async ({ apiClient }) => {
    const url = `${apiClient.baseURL}${getGetFeedUrl()}`
    const res = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json, application/problem+json' },
    })
    expect(res.status).toBe(401)
    const body = (await res.json()) as { status: number }
    expect(body).toMatchObject({ status: 401 })
  })

  test('re-follow idempotency: feed contains followee posts exactly once', async ({
    apiClient,
  }) => {
    const aliceInput = randomSignupInput({ displayName: 'Alice' })
    const bobInput = randomSignupInput({ displayName: 'Bob' })
    const alice = await signupViaApi(apiClient, aliceInput)
    await signupViaApi(apiClient, bobInput)
    const { accessToken: aliceToken } = await loginViaApi(apiClient, {
      email: aliceInput.email,
      password: aliceInput.password,
    })
    const { accessToken: bobToken } = await loginViaApi(apiClient, {
      email: bobInput.email,
      password: bobInput.password,
    })

    await apiClient.createPost(aliceToken, { body: 'a1' })
    await new Promise((r) => setTimeout(r, 2))
    await apiClient.createPost(aliceToken, { body: 'a2' })
    await new Promise((r) => setTimeout(r, 2))
    await apiClient.createPost(aliceToken, { body: 'a3' })

    // follow → unfollow → follow
    expect((await apiClient.follow(bobToken, alice.id!)).status).toBe(204)
    expect((await apiClient.unfollow(bobToken, alice.id!)).status).toBe(204)
    expect((await apiClient.follow(bobToken, alice.id!)).status).toBe(204)

    const res = await apiClient.getFeed(bobToken)
    expect(res.status).toBe(200)
    const list = res.body as PostListResponse
    const bodies = (list.items ?? []).map((p) => p.body)
    expect(bodies).toHaveLength(3)
    expect(new Set(bodies)).toEqual(new Set(['a1', 'a2', 'a3']))
  })
})
