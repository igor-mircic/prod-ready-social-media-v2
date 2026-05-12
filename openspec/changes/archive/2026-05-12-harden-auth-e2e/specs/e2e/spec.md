## ADDED Requirements

### Requirement: E2E harness boots the backend with a short access-token TTL

The e2e harness SHALL pass a short ISO-8601 duration for `app.auth.access-token-ttl` to the backend process it boots in `globalSetup`, so refresh-flow scenarios can lapse the access token within a Playwright test budget. The duration SHALL be passed via the `APP_AUTH_ACCESS_TOKEN_TTL` environment variable on the spawned backend process, alongside the existing harness-only overrides (e.g. `APP_AUTH_REFRESH_COOKIE_SECURE=false`). The duration SHALL be at most `PT5S` so a deliberate lapse plus a small margin fits well under per-test timeouts. The override SHALL be scoped to the e2e harness only; production and dev defaults SHALL remain at `PT15M` as defined by the `user-accounts` capability spec.

#### Scenario: Harness sets the short TTL via env var

- **WHEN** a reader inspects the e2e harness boot path (`e2e/src/setup/backend.ts` or equivalent)
- **THEN** the spawn of the backend process passes `APP_AUTH_ACCESS_TOKEN_TTL` in its environment
- **AND** the value is an ISO-8601 duration of at most `PT5S`
- **AND** no equivalent override is applied at any non-e2e build, run, or deploy path.

#### Scenario: Override does not bleed into production or dev defaults

- **WHEN** a reader inspects `backend/src/main/resources/application.yml` (and any environment-specific override file shipped with the backend)
- **THEN** the configured `app.auth.access-token-ttl` value remains `PT15M`
- **AND** no `APP_AUTH_ACCESS_TOKEN_TTL` env var is referenced by any non-e2e CI workflow, dev script, or deploy manifest.

## MODIFIED Requirements

### Requirement: Tests do not use `waitForTimeout`

Tests SHALL NOT call `page.waitForTimeout` or any other fixed-duration sleep, EXCEPT in the two narrowly-scoped patterns below. All other waits SHALL rely on Playwright's auto-waiting locators (e.g., `expect(locator).toBeVisible()`, `expect(page).toHaveURL(...)`) or on event-based waits (`waitFor`, `waitForResponse`, `waitForLoadState`).

Permitted exceptions:

1. **Absence-assertion buffer.** When a test asserts that a particular network request, event, or DOM mutation did NOT occur in response to an action, the test MAY call `page.waitForTimeout(N)` immediately after the action where `N <= 500` (milliseconds), to give any belated event time to materialize before the assertion. An adjacent comment SHALL state which absence the buffer protects.
2. **Configured-TTL lapse.** When the harness deliberately configures a short wall-clock-based behavior under test (e.g. `app.auth.access-token-ttl` set via the harness's short-TTL env var), a test MAY call `page.waitForTimeout(TTL_MS + MARGIN_MS)` to lapse that configured duration, where `MARGIN_MS` is a small fixed margin (typically `500`–`1000`). An adjacent comment SHALL name the configured key being lapsed and the value the test assumes (e.g. `// lapsing app.auth.access-token-ttl = PT2S`).

All other fixed-duration sleeps (including `setTimeout`-based helpers used for synchronization) remain forbidden.

#### Scenario: No fixed-duration sleeps appear in the suite outside the two permitted patterns

- **WHEN** a reader greps the test suite under `e2e/`
- **THEN** every call to `page.waitForTimeout(...)` either: (a) is preceded or followed within a few lines by an assertion that some network request, event, or DOM mutation did NOT happen, with the buffer duration `<= 500` milliseconds; or (b) is annotated with a nearby comment naming a configured key being lapsed (e.g. `app.auth.access-token-ttl`)
- **AND** there are no calls to a `setTimeout`-based sleep helper used for synchronization.
