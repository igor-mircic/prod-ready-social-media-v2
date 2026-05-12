## 1. Harness wiring

- [ ] 1.1 Add `APP_AUTH_ACCESS_TOKEN_TTL: 'PT2S'` to the `env` block in `e2e/src/setup/backend.ts`, adjacent to the existing `APP_AUTH_REFRESH_COOKIE_SECURE: 'false'` line. Add a comment naming the spec key being overridden and why the harness is doing it (`refresh-on-401 e2e proof`).
- [ ] 1.2 Run the existing e2e suite locally (`pnpm --dir e2e test`) with the short TTL in place; confirm no test regresses. If WebKit shows flake on borderline tests, bump TTL to `PT5S` and document the change in the task notes.
- [ ] 1.3 Grep CI workflows, deploy manifests, and `backend/src/main/resources/application*.yml` to confirm no `APP_AUTH_ACCESS_TOKEN_TTL` reference exists outside `e2e/src/setup/backend.ts`. (Satisfies the "Override does not bleed into production or dev defaults" spec scenario.)

## 2. New spec: refresh-on-401

- [ ] 2.1 Create `e2e/tests/auth.refresh.spec.ts`.
- [ ] 2.2 Use `signupViaApi` + `loginAndLandOnHome` to seed and land a user on `/home`.
- [ ] 2.3 Install a `page.on('response', ...)` listener that records the sequence of responses on `POST /api/v1/posts` (the trigger endpoint) and `POST /api/v1/auth/refresh`.
- [ ] 2.4 Lapse the access token with `await page.waitForTimeout(TTL_MS + 1000)` where `TTL_MS` is `2000` for `PT2S`. Add the spec-required adjacent comment naming `app.auth.access-token-ttl` and the assumed value.
- [ ] 2.5 Trigger an authenticated SPA action — fill `Body` and click `Post` — then assert the new `PostCard` is visible.
- [ ] 2.6 Assert the captured response sequence contains, in order: one `401` on `POST /api/v1/posts`, then one `200` on `POST /api/v1/auth/refresh`, then one `201` on the retried `POST /api/v1/posts`.
- [ ] 2.7 Assert `page.url()` still ends on `/home`.

## 3. New spec: logout server-side revocation

- [ ] 3.1 Create `e2e/tests/auth.logout-revocation.spec.ts`.
- [ ] 3.2 Use `signupViaApi` to create a user. Drive the SPA login form; install a `page.on('response', ...)` listener filtered to `POST /api/v1/auth/login` that parses the JSON body and captures `accessToken`.
- [ ] 3.3 Confirm landing on `/home` and assert the captured token is a non-empty string.
- [ ] 3.4 Click the SPA `Log out` button; confirm the SPA URL is `/login` and the Log-in heading is visible.
- [ ] 3.5 Replay the captured token via `fetch` (or `apiClient` if a token-bearing wrapper exists) against a protected endpoint — prefer `GET /api/v1/auth/me` for its minimal coupling — with header `Authorization: Bearer <captured-token>`.
- [ ] 3.6 Assert the replay's status is `401`.

## 4. Extend `auth.routing.spec.ts` with the unauth `/home` bounce

- [ ] 4.1 Append one `test()` to `e2e/tests/auth.routing.spec.ts`: from a fresh, unauthenticated `page`, call `page.goto('/home')`.
- [ ] 4.2 Assert `await expect(page).toHaveURL(/\/login$/)` and that the heading `Log in` is visible.

## 5. Extend `axe.routes.spec.ts` with `/not-found` scans

- [ ] 5.1 Append one `test()` to `e2e/tests/axe.routes.spec.ts` for an unauthenticated `/not-found` scan: `page.goto('/this-does-not-exist')`, assert the 404 indicator is visible, then `runAxeScan`.
- [ ] 5.2 In the same file, append a second `test()` for an authenticated `/not-found` scan: signup + log in via `loginAndLandOnHome`, then `page.goto('/this-does-not-exist')`, assert the 404 indicator, then `runAxeScan`.

## 6. Spec sync

- [ ] 6.1 Confirm the deltas in `openspec/changes/harden-auth-e2e/specs/` describe exactly what shipped — if the implementation chose `PT5S` over `PT2S`, or `GET /me` over `GET /users/{userId}/posts` for the replay endpoint, update the delta scenarios before opening the PR.
- [ ] 6.2 Run `openspec validate harden-auth-e2e` and resolve any errors.

## 7. Full-suite smoke

- [ ] 7.1 Run the whole e2e suite once locally on Chromium, Firefox, and WebKit. Pay attention to: (a) no unexpected flake from the short TTL, (b) refresh-on-401 spec is stable across three runs, (c) the new specs participate in the implicit per-test axe scan without failing.
- [ ] 7.2 If any existing test breaks because its login → last-protected-call duration exceeds the new TTL, fix it by tightening the test (preferred) or by bumping the TTL value in step 1.1 (fallback). Do NOT widen the spec exception to absorb a third pattern.

## 8. PR

- [ ] 8.1 Open a PR titled `harden-auth-e2e` referencing PRs #10–#14 in the body as the motivating context (continuation of the posts-e2e hardening cadence applied to auth).
- [ ] 8.2 In the PR description, call out the `Tests do not use waitForTimeout` spec modification explicitly so reviewers see the rule has tightened (comment requirement) rather than loosened.
