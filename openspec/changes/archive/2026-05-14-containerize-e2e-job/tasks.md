## 1. CI — switch the e2e job to the Playwright container

- [x] 1.1 Read the `@playwright/test` version pinned in `e2e/pnpm-lock.yaml` (currently `1.59.1`); the image tag for the workflow is `mcr.microsoft.com/playwright:v<that-version>-noble`.
- [x] 1.2 In `.github/workflows/ci.yml`, add a `container:` block to the `e2e` job with `image: mcr.microsoft.com/playwright:v1.59.1-noble` and `options: --volume /var/run/docker.sock:/var/run/docker.sock` so Testcontainers can spawn sibling Postgres containers via the host Docker daemon.
- [x] 1.3 Delete the `Install Playwright system deps (${{ matrix.browser }})` step and its `for attempt in 1 2; do sudo --preserve-env=PATH timeout … pnpm exec playwright install-deps ${{ matrix.browser }}` wrapper.
- [x] 1.4 Keep the `Install Playwright browser binaries (${{ matrix.browser }})` step but reword its `name:` to reflect that it is now a defence-in-depth no-op on a clean pin. Keep its `nick-fields/retry@v3` wrapper with `timeout_minutes: 3`, `max_attempts: 2`, `retry_on: any`. Confirm the command does NOT invoke `sudo`.
- [x] 1.5 Keep the `Cache Playwright browsers (${{ matrix.browser }})` step unchanged (path, key, restore-keys). Confirm the step is NOT wrapped in retry.

## 2. CI — fail-fast pin-drift assertion

- [x] 2.1 Add a new step to the `e2e` job titled `Assert container image tag matches @playwright/test`, scheduled before any Playwright-touching step. The step SHALL extract the `@playwright/test` version from `e2e/pnpm-lock.yaml` (e.g., `node -e "console.log(require('./e2e/package.json').devDependencies['@playwright/test'].replace(/^[^0-9]*/, ''))"` or an equivalent one-liner that reads the resolved version), compare it to the literal tag in the workflow YAML (or to a derived `PLAYWRIGHT_VERSION` env var), and exit non-zero on mismatch with a clear error message naming both versions.
- [x] 2.2 The fail-fast step SHALL run inside the container (so the comparison sees the same filesystem the rest of the job sees).

## 3. CI — auxiliary step hygiene under the container

- [x] 3.1 Confirm `actions/setup-java@v4` continues to run; the container does not ship a JDK and the e2e harness invokes the backend bootJar.
- [x] 3.2 Confirm `actions/setup-node@v4` continues to run; the action's pnpm-cache-dir plumbing layers cleanly on top of the container's Node. If empirical CI runs surface a conflict (PATH ordering, Node version mismatch warnings), document and revisit.
- [x] 3.3 Confirm `pnpm/action-setup@v4` continues to source the pnpm version from `e2e/package.json`'s `packageManager` field (slice-3 invariant preserved).

## 4. CI — verify Testcontainers Postgres still works under the container

- [x] 4.1 Open the e2e job's pull request; confirm the matrix shard runs reach the `globalSetup` Testcontainers Postgres provisioning step and the Flyway migrations complete before the first Playwright test runs.
- [x] 4.2 If the first run fails with a Docker permission denied on `/var/run/docker.sock`, add `options: --user root --volume /var/run/docker.sock:/var/run/docker.sock` to the container configuration and re-run. Record the working form in the workflow YAML.
- [x] 4.3 Confirm no `services:` Postgres block is added or implied; Testcontainers SHALL remain the sole provisioner.

## 5. Documentation

- [x] 5.1 No README change is required (the developer-facing dev loop is unchanged: `pnpm exec playwright test` locally still installs deps via Playwright's own `--with-deps` flag). Confirm `e2e/README.md` does not contain stale claims about CI's apt-install behaviour; update inline if needed.

## 6. CI — smoke and observability

- [x] 6.1 Push the change to a feature branch; observe the three matrix legs (chromium, firefox, webkit) on the resulting CI run.
- [x] 6.2 Confirm the `Install Playwright system deps` step is absent in every leg's log.
- [x] 6.3 Confirm the `Install Playwright browser binaries` step reports "already installed" (or equivalent no-op) on every leg's log when the pin is clean.
- [x] 6.4 Confirm the webkit leg's wall-clock drops by approximately the duration that `playwright install-deps` previously consumed (empirically ~2 minutes on this repo).
- [x] 6.5 Confirm the harness's Testcontainers Postgres provisioning completes in every leg before the first test runs; check the legs' summary view for the Flyway migration log lines.

## 7. OpenSpec hygiene

- [x] 7.1 Run `openspec validate containerize-e2e-job --strict` and resolve any failures.
- [x] 7.2 Confirm `git status` shows only `.github/workflows/ci.yml` (and any inline `e2e/README.md` clarification, if 5.1 produced one) modified — no incidental edits.
