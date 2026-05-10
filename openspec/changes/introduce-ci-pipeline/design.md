## Context

A working `.github/workflows/ci.yml` already exists in the repo — it was created during `add-api-contract-codegen` as a quiet add-on, never spec'd, never mentioned in that change's proposal or tasks. It runs two jobs:

1. **backend** — `./gradlew test`, then regenerate `openapi/openapi.json` and fail on `git diff`.
2. **frontend** — `pnpm install --frozen-lockfile` (which triggers `orval` via `postinstall`), then `pnpm test`, then `pnpm build`.

The frontend job is currently red. `pnpm/action-setup@v4` errors with *"No pnpm version is specified"* because the action's `package_json_file` input defaults to `./package.json` (repo root), and this is a flat monorepo with no root `package.json`. The pnpm version pin lives where it should — `frontend/package.json`'s `packageManager: pnpm@10.33.2` field — but the action never looks there.

The two prior scaffold changes (`scaffold-spring-backend` and `scaffold-frontend`) both wrote in their design docs that "CI workflow — separate change" was a non-goal of those changes. That separate change never happened explicitly; the workflow snuck in instead. This change rectifies the bookkeeping while fixing the bug as the forcing function.

## Goals / Non-Goals

**Goals:**

- Treat CI as a tracked OpenSpec capability so its guarantees (especially the OpenAPI drift check) are protected against silent removal.
- Make the workflow green again on `main` and on PRs.
- Preserve the single-source-of-truth pin: pnpm version stays in `frontend/package.json`'s `packageManager` field; the workflow reads it, does not duplicate it.
- Keep the spec faithful to *what is*, not *what could be* — this change adopts the existing workflow shape, it does not redesign CI.

**Non-Goals:**

- No new jobs (no e2e job, no lint/format job, no deploy job, no security scan, no dependency-update bot). Those are separate future changes against the new `ci` capability.
- No move to a different CI system. GitHub Actions stays.
- No caching or speed optimizations beyond what the workflow already does (gradle action's built-in cache, `setup-node`'s pnpm cache via `cache-dependency-path`).
- No matrix builds (no multi-Java, multi-Node, multi-OS).
- No change to the pnpm version pin itself.
- No change to the `frontend/package.json`'s `packageManager` field.

## Decisions

### D1. The fix: tell `pnpm/action-setup` where the pin lives, don't duplicate it in the workflow

**Decision:** Add `package_json_file: frontend/package.json` to the `with:` block of the `pnpm/action-setup@v4` step in `.github/workflows/ci.yml`. The action then reads `packageManager` from `frontend/package.json` and pins pnpm to the version declared there.

**Alternatives considered:**

- *Pin via `with: { version: 10.33.2 }` in `ci.yml`*: works, but creates a second copy of the pnpm version. Whoever bumps `frontend/package.json`'s `packageManager` field will not necessarily remember to bump `ci.yml`. Drift between local dev and CI would silently appear and only surface when CI behavior diverges from a developer's machine. Rejected.
- *Add a root `package.json` containing only `packageManager`*: would let the action's default work, but introduces a fake root `package.json` that implies a workspace root that doesn't exist (no pnpm workspace, no Turbo). Misleading and not justified by anything else in the repo. Rejected.
- *Move the workflow inside `frontend/`*: GitHub Actions only reads workflows from `.github/workflows/` at the repo root, so this is not an option.

**Rationale:** The pin is already in the right file (`frontend/package.json`) for local dev — `corepack` and modern pnpm itself both read it. The fix is simply to point CI at the same file. One line, zero drift surface, no new files.

### D2. The `ci` capability spec describes guarantees, not workflow YAML

**Decision:** Requirements in `openspec/specs/ci/spec.md` describe *what CI must guarantee* (e.g., "the workflow fails if `openapi/openapi.json` is stale"), not *how the workflow is structured* (e.g., "the workflow has a step named X that runs Y"). Scenarios are written in terms of observable behavior — what happens to a PR — not in terms of YAML keys.

**Rationale:** Behavioral specs survive workflow refactors. If we move from `setup-gradle@v4` to a different action, or split the backend job in two, the spec should still be true. Requirements that quote workflow YAML rot the moment the YAML changes.

**Exception:** The pnpm pin location *is* called out in the spec, because it's the bug we just fixed and we want a future contributor not to regress it. This is a deliberate inversion of the rule — the spec says "pnpm version comes from `frontend/package.json`'s `packageManager` field", which is a strong claim about the workflow's wiring. The cost of the rigidity is small (this fact is unlikely to change), the benefit is preventing the exact recurrence the spec was written for.

### D3. Adopt the existing workflow as-is; no scope creep

**Decision:** The implementation step is two-fold and bounded:

1. Apply the one-line fix to `.github/workflows/ci.yml` (the `package_json_file:` addition).
2. Author `openspec/specs/ci/spec.md` (which lands when the change is archived/synced).

No other CI work in this change. No new jobs, no concurrency settings, no `permissions:` block tightening, no `paths:` filters, no required-checks GitHub configuration.

**Rationale:** Each of those is defensible on its own merits but each also has its own decision and its own surface area. Bundling them dilutes review and inflates the change. Keep this change tight: spec the existing workflow, fix the failing step, ship.

**Out-of-scope ideas explicitly noted as future changes:**

- Concurrency cancellation (`concurrency: { group: ..., cancel-in-progress: true }`) — productivity win, but a separate decision.
- Tightened `permissions: { contents: read }` block — defense in depth, but a separate decision.
- E2E job (depends on the future `e2e/` scaffold and on auth landing).
- Frontend-only / backend-only path filters — speed win, but premature given how small the repo is.

### D4. Drift check stays exactly as it is

**Decision:** The current drift check — regenerate `openapi.json` then `git diff --exit-code` — is locked into the spec verbatim in behavioral terms. The error message it prints today (telling the contributor to run `./gradlew generateOpenApiDocs --no-configuration-cache` from `backend/`) is also captured as a scenario, because the actionable message is the whole point of the check.

**Rationale:** This check is the linchpin of the contract pipeline established in `add-api-contract-codegen`. If it ever silently disappears, the backend and frontend can drift across PRs and the bug surfaces only when a frontend developer runs `pnpm install` and codegen produces a different shape. The spec exists primarily to make this check tamper-evident.

## Risks / Trade-offs

- **Risk:** Treating the existing workflow as "the spec implementation" means any quirk in the current YAML (e.g., the implicit dependency that `pnpm install`'s `postinstall` runs `orval`) becomes load-bearing. → **Mitigation:** The spec talks about *outcomes* (frontend tests run, frontend build succeeds), not *mechanism* (how generated code is produced). The `postinstall`-runs-orval contract belongs to the `frontend-scaffold` / `api-contract` capabilities, not to `ci`.

- **Risk:** Spec'ing the pnpm pin location couples the `ci` capability to a `frontend-scaffold` implementation detail (the `packageManager` field). → **Mitigation:** Accepted, with the rationale captured in D2. If the frontend scaffold ever moves the pin elsewhere, both capabilities change together — that's the right coupling, not a leak.

- **Trade-off:** Not adding `concurrency:` / `permissions:` now means we leave easy wins on the table for one more change cycle. → Accepted in favor of a tightly scoped change. The next CI change can carry both with their own rationale.

- **Risk:** The fix (`package_json_file: frontend/package.json`) is verified only by re-running CI. There's no local way to reproduce `pnpm/action-setup`'s behavior without `act` or pushing a branch. → **Mitigation:** The fix is one line, the failure mode is well-understood from the action's source, and the verification is the next CI run. Not worth introducing `act` for.
