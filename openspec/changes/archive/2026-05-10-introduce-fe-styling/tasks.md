## 1. Path alias and Vite wiring

- [x] 1.1 Add `@` → `./src/*` path alias to `frontend/tsconfig.json` (or the appropriate chained `tsconfig.app.json`), setting `baseUrl` as needed
- [x] 1.2 Add a matching `resolve.alias` entry for `@` in `frontend/vite.config.ts`
- [x] 1.3 Install `@types/node` if not already present (required for `path.resolve` in `vite.config.ts`)
- [x] 1.4 Verify `pnpm tsc -b` and `pnpm build` still succeed

## 2. Install Tailwind v4

- [x] 2.1 Install `tailwindcss@^4` and `@tailwindcss/vite@^4` as dependencies
- [x] 2.2 Add the `@tailwindcss/vite` plugin to the `plugins` array in `frontend/vite.config.ts` alongside the existing React plugin
- [x] 2.3 Replace the body of `frontend/src/index.css` with a Tailwind v4 import (`@import "tailwindcss";`) and a starter `@theme` block
- [x] 2.4 Boot `pnpm dev` and confirm Tailwind utilities apply (e.g., `text-red-500` on a temporary element); revert the test element

## 3. Design tokens and dark mode

- [x] 3.1 In `frontend/src/index.css`, declare the full color token set in the `@theme` block (background, foreground, primary, primary-foreground, secondary, secondary-foreground, muted, muted-foreground, accent, accent-foreground, destructive, destructive-foreground, border, input, ring, card, card-foreground, popover, popover-foreground) using the shadcn neutral default palette
- [x] 3.2 Declare a `--radius` token and a `--font-sans` token in the `@theme` block
- [x] 3.3 Add a `.dark { ... }` selector below `@theme` that overrides every color token with dark-appropriate values
- [x] 3.4 Add a small inline `<script>` to `frontend/index.html` (placed in `<head>` before any module scripts) that reads `window.matchMedia('(prefers-color-scheme: dark)').matches` and toggles the `.dark` class on `<html>` accordingly, before React hydrates
- [x] 3.5 Verify the page renders with both light and dark palettes by toggling the OS preference (manually confirmed; the inline bootstrap script also listens for `prefers-color-scheme` change events so OS toggles flip the palette live without a page reload)

## 4. Bootstrap shadcn/ui

- [x] 4.1 Run `pnpm dlx shadcn@latest init` inside `frontend/`, selecting the chosen base style and the existing `index.css`; this produces `components.json` at `frontend/components.json` and writes `frontend/src/lib/utils.ts` with the `cn()` helper
- [x] 4.2 Verify `components.json` records the `@/components`, `@/lib/utils` aliases and points at `src/index.css`
- [x] 4.3 Verify `frontend/src/lib/utils.ts` exports `cn(...inputs)` composed from `clsx` + `tailwind-merge`
- [x] 4.4 Confirm `class-variance-authority`, `clsx`, `tailwind-merge`, and `lucide-react` were added to `frontend/package.json`
- [x] 4.5 Confirm no package named `shadcn`, `shadcn-ui`, or `@shadcn/ui` was added to `dependencies` or `devDependencies` (only the CLI runs via `pnpm dlx`)

## 5. Generate baseline primitives

- [x] 5.1 Run `pnpm dlx shadcn@latest add button` and verify `frontend/src/components/ui/button.tsx` is generated
- [x] 5.2 Run `pnpm dlx shadcn@latest add input` and verify `frontend/src/components/ui/input.tsx` is generated
- [x] 5.3 Run `pnpm dlx shadcn@latest add label` and verify `frontend/src/components/ui/label.tsx` is generated
- [x] 5.4 Run `pnpm dlx shadcn@latest add card` and verify `frontend/src/components/ui/card.tsx` is generated
- [x] 5.5 Run `pnpm dlx shadcn@latest add field` (the v4 replacement for the deprecated `form` primitive) and verify `frontend/src/components/ui/field.tsx` is generated, plus the `separator.tsx` it depends on. The new `field` is form-library-agnostic — `FieldError` consumes a `react-hook-form` errors array directly, so no Form/FormField wrapper is shipped or needed.
- [x] 5.6 Confirm `pnpm tsc -b` passes with the generated files in place

## 6. Refactor login screen

- [x] 6.1 Locate the login feature components under `frontend/src/features/` and identify all visible elements (form wrapper, fields, labels, submit button, error display)
- [x] 6.2 Replace native inputs with `Input` from `@/components/ui/input`
- [x] 6.3 Replace native labels with `Label` from `@/components/ui/label`
- [x] 6.4 Replace the submit element with `Button` from `@/components/ui/button`, preserving the loading state (using the existing `react-hook-form` / `@tanstack/react-query` integration)
- [x] 6.5 Compose each field with the shadcn `Field` / `FieldLabel` / `FieldError` primitives (the v4 replacements for `Form`/`FormField`/`FormItem`/`FormMessage`), keeping the existing `zodResolver(loginSchema)` configuration on `useForm`. `FieldError` accepts the `react-hook-form` per-field error directly via its `errors` prop.
- [x] 6.6 Compose the page layout with Tailwind utilities and (where appropriate) a `Card` container; remove any inline `style` props and any references to classes defined in `App.css`
- [x] 6.7 Run `pnpm test` and fix any selector failures by switching to role/text/`data-testid` selectors — do not change behavioral assertions
- [x] 6.8 Manually verify the login flow in `pnpm dev` (happy path + a validation error + a wrong-credentials error)

## 7. Refactor signup + home screens (substituted proving ground; see design Decision 5)

- [x] 7.1 Refactor `frontend/src/features/signup/SignupForm.tsx` to use `Input` / `Label` / `Button` and the shadcn `Form` primitives, mirroring the login refactor; preserve existing `zodResolver(SignupBody)` configuration and the post-success `<section aria-live="polite">` confirmation
- [x] 7.2 Refactor `frontend/src/features/home/HomePage.tsx` to render the logout action with `Button` from `@/components/ui/button` (preserving `disabled` state during logout) and compose the layout (header + body + optional `Card`) with Tailwind utilities
- [x] 7.3 Remove any inline `style` props and any references to classes defined in `App.css` from the signup and home components
- [x] 7.4 Run `pnpm test` and fix any selector failures by switching to role/text/`data-testid` selectors — do not change behavioral assertions
- [x] 7.5 Manually verify the signup happy path + a validation error in `pnpm dev`
- [x] 7.6 Manually verify the post-login home page + logout in `pnpm dev`

## 8. Remove legacy boilerplate

- [x] 8.1 Remove the `import "./App.css"` statement from `frontend/src/App.tsx`
- [x] 8.2 Delete `frontend/src/App.css` (or empty it if a file-existence convention requires the file to stay)
- [x] 8.3 Remove any stale logo/asset imports referenced only by the deleted boilerplate (also deleted the now-orphaned `src/assets/{hero.png,react.svg,vite.svg}` and the empty `src/assets/` directory; nothing in the source tree referenced them)
- [x] 8.4 Run `pnpm lint`, `pnpm tsc -b`, and `pnpm build` — `tsc -b` and `build` succeed; `lint` is clean for everything this change touches (added an `eslint.config.js` exception for the vendored `src/components/ui/**` shadcn primitives and an ignore for the generated `src/api/generated/`). Two `react-refresh/only-export-components` errors remain in pre-existing files (`src/api/query-provider.tsx`, `src/features/auth/AuthContext.tsx`) — they predate this branch and CI does not gate on `pnpm lint`. Out of scope for this change; flagged for a follow-up.

## 9. End-to-end verification

- [x] 9.1 Run the existing Playwright suite against the rebuilt frontend; update any class-name-coupled selectors to role/text/`data-testid` selectors (audit found every selector already uses role/label/text — no updates needed)
- [x] 9.2 Confirm all existing E2E flows still pass without behavioral changes (7/7 chromium pass: login, signup happy/duplicate/3× validation, smoke)
- [x] 9.3 Toggle OS dark mode and confirm the proving-ground screens render correctly in both palettes
- [x] 9.4 Run `openspec validate introduce-fe-styling` and confirm it reports the change is valid
