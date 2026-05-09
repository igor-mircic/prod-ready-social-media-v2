## Why

The repo has a runnable backend but no frontend. The monorepo's root README reserves `frontend/` for a React client; this change creates it. Doing the scaffold in its own change — before any UI feature lands — prevents the first feature change from quietly absorbing tooling decisions (build tool, package manager, test framework, format enforcement) under deadline pressure.

This is the symmetric sibling of the backend scaffold: plumbing only, no domain features, mainstream defaults, AI-iteration speed weighted as a first-class criterion.

## What Changes

**Frontend module (`frontend/`, Vite + React + TypeScript):**
- Generate the project via the official Vite scaffolder: `npm create vite@latest frontend -- --template react-ts`, pinned to whatever Vite/React/TS versions the scaffolder produces at run time.
- Switch the package manager to pnpm: declare `packageManager` in `package.json`, commit `pnpm-lock.yaml`, delete the `package-lock.json` Vite generates.
- Add a Vite dev-server proxy entry forwarding `/actuator/*` to `http://localhost:8080`, so future feature changes calling the backend don't need to re-litigate CORS in dev.
- Add Vitest + `@testing-library/react` + `jsdom` and a single smoke test that renders `<App />` and asserts a visible string. Mirrors the backend's `ApplicationContextIT` — smallest test that fails if the build is broken.
- Keep ESLint + Prettier as `create vite` configures them; do not swap to Biome.
- Pin the Node version with `.nvmrc` and an `engines.node` entry.
- Add `frontend/README.md` documenting prerequisites (Node, pnpm) and the canonical commands (`pnpm install`, `pnpm dev`, `pnpm test`, `pnpm build`).

**Repo-root deltas:**
- Update root `README.md` so `frontend/` is listed as **exists** instead of **reserved**.
- No `docker-compose.yml` change — the frontend's dev loop needs no new local services in this change.

## Capabilities

### New Capabilities
- `frontend-scaffold`: The runnable React frontend project — Vite build, pnpm-managed dependencies, ESLint+Prettier format enforcement, Vitest smoke test, dev-server proxy to the backend. Future product capabilities (UI for accounts, posts, feed) build on top of this.

### Modified Capabilities
- `monorepo-layout`: The "no empty placeholder directories" scenario currently lists `frontend/` as not-yet-created; this change removes it from that list. Other scenarios (root README, `.gitignore`, `.gitattributes`, `.editorconfig`, `docker-compose.yml`) are unchanged in substance — only the README's wording flips `frontend/` from reserved to exists.

## Impact

- New frontend tree:
  - `frontend/package.json`, `frontend/pnpm-lock.yaml`, `frontend/.nvmrc`
  - `frontend/index.html`, `frontend/vite.config.ts`, `frontend/tsconfig*.json`
  - `frontend/eslint.config.js`, `frontend/.prettierrc` (or whatever `create vite` generates)
  - `frontend/src/main.tsx`, `frontend/src/App.tsx`, `frontend/src/App.test.tsx`
  - `frontend/README.md`
- Modified: root `README.md` (frontend row flips to "exists").
- New hard dev prerequisites: Node (version pinned in `.nvmrc`) and pnpm. Documented in `frontend/README.md`.
- No effect on `backend/`, `docker-compose.yml`, or `openspec/`.
- No CI, deploy story, real API client, routing, or styling system in this change — separate scaffolds.
