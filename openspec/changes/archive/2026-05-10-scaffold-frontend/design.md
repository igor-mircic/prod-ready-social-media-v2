## Context

The backend scaffold is in place. This change introduces the second executable component of the monorepo and the first opinions about the JavaScript/TypeScript build chain, package manager, and frontend test framework. As with the backend scaffold, several decisions made here will be hard to reverse cheaply once feature changes start landing on top — pick mainstream defaults that match enterprise practice, weight AI-workflow iteration speed, and prefer official scaffolders over hand-written config.

Constraints:
- Stack is fixed by project context: React frontend, talking to a Spring backend on a separate origin in dev.
- No agreed coding conventions yet — use what `create vite` provides; do not invent additional rules.
- Repo is a flat monorepo (`backend/` exists, `frontend/` lands here, `e2e/`/`infra/` reserved).

## Goals / Non-Goals

**Goals:**
- A single `cd frontend && pnpm install && pnpm test` (after `pnpm install` once) runs the smoke test from a clean clone.
- The dependency and tooling baseline (React, TS, Vite, Vitest, Testing Library, ESLint, Prettier) covers obvious near-term needs so the first feature change adds business code, not infrastructure.
- AI-driven inner loop is fast: Vite's native HMR, Vitest's smart watch mode, pnpm's content-addressable store and hard-linked installs.
- Cloning the repo and running `cd frontend && pnpm install && pnpm dev` starts a dev server with no further setup.

**Non-Goals:**
- Routing, state management, styling system, real API client, UI component library — out of scope; needs a feature to motivate decisions.
- Production build/deploy story — separate change.
- CORS hardening, auth wiring, real backend integration — separate changes.
- Monorepo task runner (Turbo, Nx) — premature with two components.
- Component-level Storybook, visual regression, a11y testing — separate changes.
- CI workflow — separate change (see backend scaffold's same non-goal).
- Same-origin deployment topology (Spring serving built static files) — out of scope; dev uses two origins.

## Decisions

### Decision 1: Generate the frontend skeleton via `npm create vite@latest` (react-ts template)

Run `npm create vite@latest frontend -- --template react-ts` from the repo root. Vite is the SPA scaffolder React's own docs endorse for the "React + your-own-backend" case (the alternatives — Next.js, Remix — bring routing, server rendering, and a deploy model that don't fit a separate Spring backend). Hand-writing a Vite project is faster to type but slower to get right (entry HTML, TS configs split between app/node, ESLint flat-config peculiarities all drift between Vite versions).

Use `npm create` rather than `pnpm create` for the generation step itself: the Vite scaffolder's documentation universally shows the `npm create` form, so this matches what a reader will look up. The package manager swap to pnpm happens immediately after, before any `node_modules` work matters.

### Decision 2: pnpm as the project package manager

Pin `packageManager` in `package.json` to a pnpm version, commit `pnpm-lock.yaml`, and delete the `package-lock.json` Vite generates. pnpm gives a content-addressable store and hard-linked installs — cheap installs across branches, minimal disk churn during AI iteration. The "AI-workflow speed" rationale that picked Gradle's caching/configuration-cache flags applies equally here.

Alternatives considered: **npm** is the zero-tool baseline (no `corepack` dance, no extra install step on a fresh machine), but its disk and install-time costs are noticeably worse on multi-branch AI workflows. **bun** is faster but its ecosystem is younger and Vite/Vitest/Testing Library compatibility, while present, is less battle-tested. pnpm is the sweet spot.

The cost: contributors need pnpm installed. Mitigation: `packageManager` plus Corepack means a new contributor with a recent Node and `corepack enable` already gets the right pnpm version automatically. Document this in `frontend/README.md`.

### Decision 3: TypeScript, not JavaScript

The `react-ts` Vite template. TS is the default for "prod-ready" React in 2026 — Vite, Vitest, Testing Library, ESLint, and React itself all ship first-party TS types. No tradeoff worth discussing; flagged here only because the template choice is explicit.

### Decision 4: Vitest + `@testing-library/react` + `jsdom` for the smoke test

Vitest is Vite-native — it shares the dev-server's transform pipeline, so the test config is essentially "import the same `vite.config.ts`." Jest would require a parallel Babel/SWC config, type-stripping setup, and module-resolution shims that drift from the dev pipeline. Vitest reuses what's already there.

The smoke test renders `<App />` and asserts a known visible string. Mirrors `ApplicationContextIT`: smallest possible test that fails if the build, the type-check, the test runner, or the rendering pipeline is broken. The test runs in `jsdom` and does not hit the backend — no Vite dev server, no proxy, no network. The proxy decision (Decision 5) is independent of the smoke test.

### Decision 5: Vite dev-server proxy entry forwards `/actuator/*` to `http://localhost:8080`

Add `server.proxy` to `vite.config.ts`. Nothing in this change calls it; the proxy is here so the first feature change that touches the backend doesn't have to re-litigate dev-time CORS. This is the same shape of "plumbing-ahead" decision the backend scaffold made when it created the empty `db/migration/` directory and added Flyway before the first migration existed.

The spec scenario for this proxy is **syntactic** ("config exists in `vite.config.ts` mapping `/actuator` to `http://localhost:8080`"), not behavioral — there is no caller in this change to verify it works end-to-end. The first feature change that uses the proxy is also responsible for the first behavioral test of it.

Alternative: defer the proxy to the first feature change. Rejected because the marginal cost is ~5 lines of config and the file it lives in (`vite.config.ts`) gets touched by every Vite-config change anyway — better to land it once with the rationale recorded here.

### Decision 6: Keep ESLint + Prettier as `create vite` configures them; do not swap to Biome

`create vite` generates an ESLint flat config. Prettier integration is conventional ("eslint-config-prettier" to disable conflicting rules). Both tools have decades of community config and AI-training data, with no surprises for a reader.

Biome is the "single tool, faster" alternative and aligns with the AI-iteration-speed argument. Rejected for this scaffold: swapping Biome in means deleting Vite's defaults and reaching for something less canonical. The "use official scaffolders, don't hand-write build files from memory" stance dominates the speed argument here. Revisit if format/lint speed becomes a measurable inner-loop bottleneck.

### Decision 7: Pin Node version with `.nvmrc` and `engines.node` in package.json

`.nvmrc` lets `nvm` (and most Node version managers) auto-switch on `cd frontend`. `engines.node` makes pnpm warn if a contributor uses a too-old Node. Both are conventional; cheap to add now, painful to debug later.

Pick whatever Node version is the active LTS at scaffold time. Document it in `frontend/README.md` so a fresh-machine developer knows what to install before `pnpm install`.

### Decision 8: No Turbo/Nx, no monorepo orchestrator

Two components is not enough to justify a monorepo task runner. The CI workflow (separate change) will run backend and frontend tasks independently. Adding Turbo now is speculative complexity. Revisit if a third or fourth component lands and cross-component caching becomes valuable.

### Decision 9: Modify `monorepo-layout`'s "no empty placeholder directories" scenario, not the "Layout is documented" scenario

Two scenarios in `monorepo-layout` mention `frontend/`. Only the "no empty placeholder directories" scenario needs a wording change (drop `frontend/` from the list of not-yet-created dirs). The "Layout is documented" scenario already says "lists backend/, frontend/, e2e/, infra/" and "notes which exist and which are reserved" — those statements remain true after this change, with `frontend/` simply flipping sides. The README content update is captured in tasks, not as a spec delta.

## Risks / Trade-offs

- **Vite 7+ ecosystem flux** → Vite, Vitest, and the React plugin sometimes require coordinated bumps. Mitigation: pin via the lockfile and bump together; the smoke test will catch breakage.
- **pnpm as a hard prerequisite** → Contributors need it installed. Mitigation: `packageManager` field + Corepack handles this on recent Node; documented in `frontend/README.md`.
- **No CI yet** → Smoke test depends on developers running it locally. Mitigation: CI scaffold is the natural next change after this one.
- **Proxy entry has no behavioral verification in this change** → Accepted; first feature using the proxy is responsible for the first end-to-end test of it. The syntactic spec scenario at least catches accidental deletion.
- **Vite scaffolder regenerates files between visits** → Run the scaffolder once, capture exact versions in `package.json`/`pnpm-lock.yaml`, and don't re-run it. Future bumps go through targeted dependency updates, not re-scaffolding.

## Migration Plan

Not applicable — there is no existing frontend code to migrate from.

## Open Questions

- **CSS strategy (Tailwind, CSS modules, vanilla)** — defer; first UI feature picks. Vite's default plain CSS is fine for the smoke test.
- **API client (fetch + TanStack Query, generated from OpenAPI, etc.)** — defer; first feature that calls the backend picks.
- **Path aliases (`@/`)** — defer; add in the first feature change that benefits.
- **Should `pnpm test` run typecheck?** — defer; for the smoke test, `vitest run` alone is enough. Revisit when there's enough TS code that drift becomes a real concern.
