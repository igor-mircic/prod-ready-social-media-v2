## 1. New spec: concurrent-401 single-flight refresh

- [x] 1.1 Create `e2e/tests/auth.refresh.concurrent.spec.ts`.
- [x] 1.2 Use `signupViaApi(apiClient, randomSignupInput())` to create a fresh user.
- [x] 1.3 Use `loginViaApi(apiClient, { email, password })` to obtain `{ accessToken, userId }`.
- [x] 1.4 Use `apiClient.createPost(accessToken, { body })` twice (sequentially awaited) to seed two posts so `/home` renders two `PostCard`s, each with a `Delete` button.
- [x] 1.5 Drive the SPA login flow via `loginAndLandOnHome(page, input)` so the in-browser `AuthContext` holds its own access token. Confirm the two `getByRole('button', { name: 'Delete post' })` are visible on `/home`.
- [x] 1.6 Install a `page.on('response', ...)` listener that records `{method, url, status}` for `DELETE /api/v1/posts/*` and `POST /api/v1/auth/refresh`.
- [x] 1.7 Lapse the access token via `await page.waitForTimeout(TTL_MS + 1000)` where `TTL_MS = 2000`. Include the spec-required adjacent comment naming `app.auth.access-token-ttl = PT2S` (matches the pattern in `auth.refresh.spec.ts`).
- [x] 1.8 Capture both delete buttons via `nth(0)` and `nth(1)` against the `getByRole('button', { name: 'Delete post' })` locator. Fire `await Promise.all([deleteA.click(), deleteB.click()])`.
- [x] 1.9 Wait until both `PostCard`s have disappeared (`expect(page.getByRole('article', { name: 'Post' })).toHaveCount(0)`).
- [x] 1.10 Assert the captured `POST /api/v1/auth/refresh` sequence has length exactly 1 and status 200.
- [x] 1.11 Assert the captured `DELETE /api/v1/posts/*` sequence has length exactly 4: two 401s followed by two successful retries (the retry status is whatever the backend returns for a successful delete, e.g. 204).
- [x] 1.12 Assert ordering: both 401 indices precede the refresh index; both retry indices follow the refresh index.
- [x] 1.13 Assert `page.url()` still ends on `/home`.

## 2. New spec: refresh-401 logout

- [x] 2.1 Create `e2e/tests/auth.refresh.failure.spec.ts`.
- [x] 2.2 Use `signupViaApi(apiClient, randomSignupInput())` then drive `loginAndLandOnHome(page, input)`.
- [x] 2.3 Capture the live `refresh_token` cookie attributes via `page.context().cookies()` filtered by name `refresh_token`. Record `domain`, `path`, `httpOnly`, `sameSite`, `secure`, `expires`.
- [x] 2.4 Overwrite the cookie with a bogus value via `page.context().addCookies([{ name: 'refresh_token', value: `bogus-${crypto.randomUUID()}`, ...capturedAttributes }])`. Verify the overwrite landed by re-reading `page.context().cookies()` and asserting `value` is the bogus one.
- [x] 2.5 Install a `page.on('response', ...)` listener that records `{method, url, status}` for `POST /api/v1/posts` and `POST /api/v1/auth/refresh`.
- [x] 2.6 Lapse the access token via `await page.waitForTimeout(TTL_MS + 1000)` where `TTL_MS = 2000`. Include the spec-required adjacent comment naming `app.auth.access-token-ttl = PT2S`.
- [x] 2.7 Trigger an authenticated SPA action: fill `getByLabel('Body')` with a unique body and click `getByRole('button', { name: 'Post', exact: true })`.
- [x] 2.8 Wait for the SPA to navigate to `/login` (`await expect(page).toHaveURL(/\/login$/)`). Assert the heading `Log in` is visible.
- [x] 2.9 Assert the captured `POST /api/v1/posts` sequence shows status `401` on the first (and only) entry.
- [x] 2.10 Assert the captured `POST /api/v1/auth/refresh` sequence has length exactly 1 and status `401`.

## 3. Spec sync

- [x] 3.1 Confirm the deltas in `openspec/changes/prove-refresh-interceptor-e2e/specs/` describe exactly what shipped — if implementation chose different role names or different DELETE response status, update the delta scenarios before opening the PR.
- [x] 3.2 Run `openspec validate prove-refresh-interceptor-e2e --strict` and resolve any errors.

## 4. Full-suite smoke

- [x] 4.1 Run the whole e2e suite once locally on Chromium, Firefox, and WebKit (`pnpm --dir e2e test`). Pay attention to: (a) no new flake from the two parallel delete clicks, (b) the refresh-401 spec is stable across three runs, (c) the implicit per-test axe scan still passes on `/login` after the refresh-failure redirect.
- [x] 4.2 If single-flight flake appears (more than one refresh observed on a fast run), investigate timing rather than masking — typical fixes are (i) ensure both delete buttons are *enabled* before the `Promise.all`, (ii) ensure both posts' query data has loaded before the lapse, (iii) on persistent ordering issues, add a single `page.waitForLoadState('networkidle')` before the lapse step. Do NOT relax the assertion to "≤ 1 refresh".
- [x] 4.3 If WebKit shows divergent cookie behavior in the refresh-401 spec (e.g., the overwrite doesn't take effect), capture the live cookie via the cookie URL filter `{ urls: [`${backendURL}/api/v1/auth/refresh`] }` and pass `url` alongside the attributes in `addCookies(...)` instead of `domain`+`path`.

## 5. PR

- [x] 5.1 Open a PR titled `prove-refresh-interceptor-e2e` referencing PR #15 in the body as the precedent (continuation of the auth-e2e hardening cadence, closing the unhappy-path halves of the refresh wire).
- [x] 5.2 In the PR description, call out that the change is test-only plus spec text: no `frontend/` source files change, no `backend/` source files change, no new harness env vars. Reviewers should be able to confirm the change set is `e2e/**` + `openspec/**`.
