// End-to-end coverage of the follow / unfollow vertical: UI round-trip plus
// the API-level edge cases (self-follow, idempotency, unknown ids, 401).
import { randomUUID } from 'node:crypto'
import { test, expect } from '../src/fixtures/test.ts'
import {
  getFollowUserUrl,
  getUnfollowUserUrl,
  getGetFollowStatsUrl,
} from '../src/api/generated/follows-controller/follows-controller.ts'
import { randomSignupInput, signupViaApi } from '../src/helpers/signup.ts'
import { loginAndLandOnHome, loginViaApi } from '../src/helpers/login.ts'

test.describe('UI vertical', () => {
  test('Bob follows then unfollows Alice through the SPA', async ({
    page,
    apiClient,
  }) => {
    const aliceInput = randomSignupInput({ displayName: 'Alice' })
    const bobInput = randomSignupInput({ displayName: 'Bob' })
    const alice = await signupViaApi(apiClient, aliceInput)
    const bob = await signupViaApi(apiClient, bobInput)
    const aliceId = alice.id
    const bobId = bob.id
    expect(aliceId, 'signup must return Alice id').toBeTruthy()
    expect(bobId, 'signup must return Bob id').toBeTruthy()

    const { accessToken: aliceToken } = await loginViaApi(apiClient, {
      email: aliceInput.email,
      password: aliceInput.password,
    })
    const { accessToken: bobToken } = await loginViaApi(apiClient, {
      email: bobInput.email,
      password: bobInput.password,
    })

    await loginAndLandOnHome(page, bobInput)
    await page.goto(`/users/${aliceId}`)

    await expect(
      page.getByRole('heading', { name: aliceInput.displayName }),
    ).toBeVisible()
    await expect(page.getByText(/0 followers/i)).toBeVisible()
    await expect(page.getByText(/0 following/i)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Follow' })).toBeVisible()

    await page.getByRole('button', { name: 'Follow' }).click()

    await expect(page.getByText(/1 follower\b/i)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Unfollow' })).toBeVisible()

    const aliceStats = await apiClient.getFollowStats(aliceToken!, aliceId!)
    expect(aliceStats.status).toBe(200)
    expect(aliceStats.body).toMatchObject({
      followers: 1,
      following: 0,
      viewerFollows: false,
    })

    const bobStats = await apiClient.getFollowStats(bobToken!, bobId!)
    expect(bobStats.status).toBe(200)
    expect(bobStats.body).toMatchObject({
      followers: 0,
      following: 1,
      viewerFollows: false,
    })

    await page.getByRole('button', { name: 'Unfollow' }).click()

    await expect(page.getByText(/0 followers/i)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Follow' })).toBeVisible()
  })
})

test.describe('API edges', () => {
  test('self-follow returns 400', async ({ apiClient }) => {
    const aliceInput = randomSignupInput({ displayName: 'Alice' })
    const alice = await signupViaApi(apiClient, aliceInput)
    const { accessToken: aliceToken } = await loginViaApi(apiClient, {
      email: aliceInput.email,
      password: aliceInput.password,
    })

    const result = await apiClient.follow(aliceToken, alice.id!)
    expect(result.status).toBe(400)
    expect(result.body).toMatchObject({ status: 400 })
  })

  test('repeated follow is idempotent at the API', async ({ apiClient }) => {
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

    const first = await apiClient.follow(bobToken, alice.id!)
    const second = await apiClient.follow(bobToken, alice.id!)
    expect(first.status).toBe(204)
    expect(second.status).toBe(204)

    const stats = await apiClient.getFollowStats(aliceToken, alice.id!)
    expect(stats.status).toBe(200)
    expect((stats.body as { followers: number }).followers).toBe(1)
  })

  test('unfollow when not following is idempotent', async ({ apiClient }) => {
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

    const result = await apiClient.unfollow(bobToken, alice.id!)
    expect(result.status).toBe(204)

    const stats = await apiClient.getFollowStats(aliceToken, alice.id!)
    expect(stats.status).toBe(200)
    expect((stats.body as { followers: number }).followers).toBe(0)
  })

  test('follow/unfollow/stats on an unknown id return 404', async ({
    apiClient,
  }) => {
    const bobInput = randomSignupInput({ displayName: 'Bob' })
    await signupViaApi(apiClient, bobInput)
    const { accessToken: bobToken } = await loginViaApi(apiClient, {
      email: bobInput.email,
      password: bobInput.password,
    })
    const unknown = randomUUID()

    const followRes = await apiClient.follow(bobToken, unknown)
    const unfollowRes = await apiClient.unfollow(bobToken, unknown)
    const statsRes = await apiClient.getFollowStats(bobToken, unknown)

    expect(followRes.status).toBe(404)
    expect(unfollowRes.status).toBe(404)
    expect(statsRes.status).toBe(404)
    expect(followRes.body).toMatchObject({ status: 404 })
    expect(unfollowRes.body).toMatchObject({ status: 404 })
    expect(statsRes.body).toMatchObject({ status: 404 })
  })

  test('all three endpoints reject unauthenticated calls with 401', async ({
    apiClient,
  }) => {
    const someUserId = randomUUID()
    const followUrl = `${apiClient.baseURL}${getFollowUserUrl(someUserId)}`
    const unfollowUrl = `${apiClient.baseURL}${getUnfollowUserUrl(someUserId)}`
    const statsUrl = `${apiClient.baseURL}${getGetFollowStatsUrl(someUserId)}`
    const headers = { Accept: 'application/json, application/problem+json' }

    const followRes = await fetch(followUrl, { method: 'POST', headers })
    const unfollowRes = await fetch(unfollowUrl, { method: 'DELETE', headers })
    const statsRes = await fetch(statsUrl, { method: 'GET', headers })

    expect(followRes.status).toBe(401)
    expect(unfollowRes.status).toBe(401)
    expect(statsRes.status).toBe(401)

    for (const res of [followRes, unfollowRes, statsRes]) {
      const body = (await res.json()) as { status: number }
      expect(body).toMatchObject({ status: 401 })
    }
  })
})
