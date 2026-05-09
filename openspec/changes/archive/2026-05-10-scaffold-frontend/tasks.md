## 1. Generate frontend skeleton via the Vite scaffolder

- [x] 1.1 From the repo root, run `npm create vite@latest frontend -- --template react-ts`. Confirm the scaffolder picks the latest stable Vite + React + TS versions before running.
- [x] 1.2 Confirm Vite generated `frontend/package.json`, `frontend/index.html`, `frontend/vite.config.ts`, `frontend/tsconfig.json` (and any related TS configs the template ships, e.g., `tsconfig.app.json`, `tsconfig.node.json`), `frontend/eslint.config.js`, and `frontend/src/{main.tsx,App.tsx,App.css,index.css,assets/*}`.
- [x] 1.3 Verify the scaffolder did NOT create a `frontend/node_modules/` (or remove it if it did) — pnpm will regenerate it in the next section.

## 2. Switch the project to pnpm

- [x] 2.1 Delete `frontend/package-lock.json` if Vite generated one.
- [x] 2.2 Add a `packageManager` field to `frontend/package.json` pinning a specific pnpm version (e.g., `"packageManager": "pnpm@<version>"`). Use the current pnpm release at the time of scaffolding.
- [x] 2.3 From `frontend/`, run `pnpm install`. Confirm it produces `frontend/pnpm-lock.yaml` and a hard-linked `frontend/node_modules/`.

## 3. Pin Node version

- [x] 3.1 Create `frontend/.nvmrc` containing the active Node LTS version (e.g., the same version `pnpm install` ran under).
- [x] 3.2 Add an `engines.node` field to `frontend/package.json` with a constraint compatible with the `.nvmrc` version (e.g., `">=22"` if `.nvmrc` is `22`).

## 4. Wire the Vite dev-server proxy

- [x] 4.1 Edit `frontend/vite.config.ts` to add `server.proxy` with one entry: `'/actuator': 'http://localhost:8080'`. Keep the existing `defineConfig` and React plugin intact.

## 5. Add Vitest + Testing Library smoke test

- [x] 5.1 Add dev dependencies via `pnpm add -D vitest @testing-library/react @testing-library/jest-dom jsdom @types/node`. Use the current stable versions at scaffolding time; pnpm pins them in the lockfile.
- [x] 5.2 Configure Vitest in `frontend/vite.config.ts` (extend the existing config with a `test` block: `environment: 'jsdom'`, `globals: true`, `setupFiles: './src/test-setup.ts'`). Add the `/// <reference types="vitest" />` triple-slash directive at the top of the file.
- [x] 5.3 Create `frontend/src/test-setup.ts` containing `import '@testing-library/jest-dom'` so the matchers are loaded.
- [x] 5.4 Create `frontend/src/App.test.tsx` that renders `<App />` via `@testing-library/react`'s `render`, then asserts a visible string from the App's default content (e.g., the `Vite + React` heading the template ships) is in the document. Exactly one `test`/`it` block.
- [x] 5.5 Add a `test` script to `frontend/package.json`: `"test": "vitest run"`. Keep the template's existing `dev`, `build`, `preview`, and `lint` scripts.

## 6. Frontend README and tsconfig sanity

- [x] 6.1 Create `frontend/README.md` documenting Node (referencing `.nvmrc`) and pnpm prerequisites, plus the `pnpm install` / `pnpm dev` / `pnpm test` / `pnpm build` / `pnpm lint` commands.
- [x] 6.2 Confirm `frontend/tsconfig*.json` includes the `App.test.tsx` path under its `include` (or that the test file isn't excluded by `tsconfig.app.json`'s narrower include — adjust if needed so type-checking covers the test).

## 7. Update root README

- [x] 7.1 In the repo-root `README.md`, edit the monorepo-layout table so the `frontend/` row is marked as **exists** (matching the format used for `backend/`), with status notes adjusted accordingly. Keep `e2e/` and `infra/` as **reserved**.

## 8. Verify

- [x] 8.1 From `frontend/`, run `pnpm install` from a clean state and confirm it succeeds and `pnpm-lock.yaml` is unchanged afterwards (no drift).
- [x] 8.2 From `frontend/`, run `pnpm lint` and confirm it passes on the freshly generated code.
- [x] 8.3 From `frontend/`, run `pnpm test` and confirm the single smoke test passes.
- [x] 8.4 From `frontend/`, run `pnpm build` and confirm `dist/` is produced with no errors.
- [x] 8.5 From `frontend/`, run `pnpm dev` in the background, then `curl -sI http://localhost:5173/` and confirm HTTP 200, then stop the dev server.
- [x] 8.6 With `docker-compose up -d postgres` and `cd backend && ./gradlew bootRun &` already running, restart `pnpm dev` and `curl -s http://localhost:5173/actuator/health` and confirm the proxy forwards to the backend (HTTP 200, JSON body with `status`). Stop both servers afterward.
- [x] 8.7 Re-read each scenario in `specs/frontend-scaffold/spec.md` and the modified scenario in `specs/monorepo-layout/spec.md` and confirm the file contents satisfy them.
- [x] 8.8 Run `git status` and confirm no `frontend/node_modules/` or `frontend/dist/` is tracked — the existing root `.gitignore` should be excluding them.
