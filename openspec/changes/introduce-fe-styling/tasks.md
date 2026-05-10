## 1. Path alias and Vite wiring

- [ ] 1.1 Add `@` → `./src/*` path alias to `frontend/tsconfig.json` (or the appropriate chained `tsconfig.app.json`), setting `baseUrl` as needed
- [ ] 1.2 Add a matching `resolve.alias` entry for `@` in `frontend/vite.config.ts`
- [ ] 1.3 Install `@types/node` if not already present (required for `path.resolve` in `vite.config.ts`)
- [ ] 1.4 Verify `pnpm tsc -b` and `pnpm build` still succeed

## 2. Install Tailwind v4

- [ ] 2.1 Install `tailwindcss@^4` and `@tailwindcss/vite@^4` as dependencies
- [ ] 2.2 Add the `@tailwindcss/vite` plugin to the `plugins` array in `frontend/vite.config.ts` alongside the existing React plugin
- [ ] 2.3 Replace the body of `frontend/src/index.css` with a Tailwind v4 import (`@import "tailwindcss";`) and a starter `@theme` block
- [ ] 2.4 Boot `pnpm dev` and confirm Tailwind utilities apply (e.g., `text-red-500` on a temporary element); revert the test element

## 3. Design tokens and dark mode

- [ ] 3.1 In `frontend/src/index.css`, declare the full color token set in the `@theme` block (background, foreground, primary, primary-foreground, secondary, secondary-foreground, muted, muted-foreground, accent, accent-foreground, destructive, destructive-foreground, border, input, ring, card, card-foreground, popover, popover-foreground) using the shadcn neutral default palette
- [ ] 3.2 Declare a `--radius` token and a `--font-sans` token in the `@theme` block
- [ ] 3.3 Add a `.dark { ... }` selector below `@theme` that overrides every color token with dark-appropriate values
- [ ] 3.4 Add a small inline `<script>` to `frontend/index.html` (placed in `<head>` before any module scripts) that reads `window.matchMedia('(prefers-color-scheme: dark)').matches` and toggles the `.dark` class on `<html>` accordingly, before React hydrates
- [ ] 3.5 Verify the page renders with both light and dark palettes by toggling the OS preference

## 4. Bootstrap shadcn/ui

- [ ] 4.1 Run `pnpm dlx shadcn@latest init` inside `frontend/`, selecting the chosen base style and the existing `index.css`; this produces `components.json` at `frontend/components.json` and writes `frontend/src/lib/utils.ts` with the `cn()` helper
- [ ] 4.2 Verify `components.json` records the `@/components`, `@/lib/utils` aliases and points at `src/index.css`
- [ ] 4.3 Verify `frontend/src/lib/utils.ts` exports `cn(...inputs)` composed from `clsx` + `tailwind-merge`
- [ ] 4.4 Confirm `class-variance-authority`, `clsx`, `tailwind-merge`, and `lucide-react` were added to `frontend/package.json`
- [ ] 4.5 Confirm no package named `shadcn`, `shadcn-ui`, or `@shadcn/ui` was added to `dependencies` or `devDependencies` (only the CLI runs via `pnpm dlx`)

## 5. Generate baseline primitives

- [ ] 5.1 Run `pnpm dlx shadcn@latest add button` and verify `frontend/src/components/ui/button.tsx` is generated
- [ ] 5.2 Run `pnpm dlx shadcn@latest add input` and verify `frontend/src/components/ui/input.tsx` is generated
- [ ] 5.3 Run `pnpm dlx shadcn@latest add label` and verify `frontend/src/components/ui/label.tsx` is generated
- [ ] 5.4 Run `pnpm dlx shadcn@latest add card` and verify `frontend/src/components/ui/card.tsx` is generated
- [ ] 5.5 Run `pnpm dlx shadcn@latest add form` and verify `frontend/src/components/ui/form.tsx` is generated (this pulls in `react-hook-form` integration helpers)
- [ ] 5.6 Confirm `pnpm tsc -b` passes with the generated files in place

## 6. Refactor login screen

- [ ] 6.1 Locate the login feature components under `frontend/src/features/` and identify all visible elements (form wrapper, fields, labels, submit button, error display)
- [ ] 6.2 Replace native inputs with `Input` from `@/components/ui/input`
- [ ] 6.3 Replace native labels with `Label` from `@/components/ui/label`
- [ ] 6.4 Replace the submit element with `Button` from `@/components/ui/button`, preserving the loading state (using the existing `react-hook-form` / `@tanstack/react-query` integration)
- [ ] 6.5 Wrap the form using the shadcn `Form` / `FormField` / `FormItem` / `FormMessage` primitives, keeping the existing `zodResolver(loginSchema)` configuration on `useForm`
- [ ] 6.6 Compose the page layout with Tailwind utilities and (where appropriate) a `Card` container; remove any inline `style` props and any references to classes defined in `App.css`
- [ ] 6.7 Run `pnpm test` and fix any selector failures by switching to role/text/`data-testid` selectors — do not change behavioral assertions
- [ ] 6.8 Manually verify the login flow in `pnpm dev` (happy path + a validation error + a wrong-credentials error)

## 7. Refactor active-session listing screen

- [ ] 7.1 Locate the session-listing feature components under `frontend/src/features/` and identify all visible elements (page header, list, list item, action controls, empty state)
- [ ] 7.2 Replace list item containers with `Card` (or an equivalent shadcn primitive) from `@/components/ui/`
- [ ] 7.3 Replace any action controls (e.g., revoke buttons) with `Button` from `@/components/ui/button`
- [ ] 7.4 Compose the empty state and page header with Tailwind utilities; remove inline `style` props and references to classes defined in `App.css`
- [ ] 7.5 Run `pnpm test` and fix any selector failures by switching to role/text/`data-testid` selectors — do not change behavioral assertions
- [ ] 7.6 Manually verify the session-listing flow in `pnpm dev` (populated list + empty state)

## 8. Remove legacy boilerplate

- [ ] 8.1 Remove the `import "./App.css"` statement from `frontend/src/App.tsx`
- [ ] 8.2 Delete `frontend/src/App.css` (or empty it if a file-existence convention requires the file to stay)
- [ ] 8.3 Remove any stale logo/asset imports referenced only by the deleted boilerplate
- [ ] 8.4 Run `pnpm lint`, `pnpm tsc -b`, and `pnpm build` — all must succeed

## 9. End-to-end verification

- [ ] 9.1 Run the existing Playwright suite against the rebuilt frontend; update any class-name-coupled selectors to role/text/`data-testid` selectors
- [ ] 9.2 Confirm all existing E2E flows still pass without behavioral changes
- [ ] 9.3 Toggle OS dark mode and confirm the proving-ground screens render correctly in both palettes
- [ ] 9.4 Run `openspec validate introduce-fe-styling` and confirm it reports the change is valid
