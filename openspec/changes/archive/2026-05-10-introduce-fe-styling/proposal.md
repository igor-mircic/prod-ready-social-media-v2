## Why

The frontend has shipped real screens (login, sessions) but has no styling system — only ad-hoc CSS in `App.css` and `index.css`. Every new feature will either accumulate one-off CSS or be blocked on this decision. We need a foundation that gives us consistent visual primitives, accessibility for free, and stays maintainable as the product grows into a content-dense social UI.

## What Changes

- Adopt **Tailwind CSS v4** as the styling primitive (utility classes inline in JSX).
- Adopt **shadcn/ui** as the component layer — components are generated *into* the repo (vendored, not imported from npm), built on Radix primitives for accessibility.
- Establish a **design-token foundation** before building feature components: color palette, spacing scale, typography scale, border radius, and dark-mode strategy. Tokens live as CSS custom properties consumed by Tailwind.
- Add a **`components/ui/`** directory under `frontend/src/` to house shadcn-generated primitives (Button, Input, Card, etc.).
- **Refactor the existing login, signup, and home screens** as the first proving ground for the new system — no new feature work is in scope. (The original artifacts referenced an "active-session listing" screen; that screen does not exist in the repo — sessions in the prior change were a backend-only concern. Scope substituted to the actual logged-in surface, `HomePage`, plus the near-identical `SignupForm`, to keep the form + non-form coverage intended by the design.)
- Add Tailwind, shadcn-cli, and supporting deps (`tailwindcss`, `@tailwindcss/vite`, `class-variance-authority`, `clsx`, `tailwind-merge`, `lucide-react`) to `frontend/package.json`.
- Wire Tailwind into Vite (`@tailwindcss/vite` plugin) and replace existing `App.css` / `index.css` boilerplate.

## Capabilities

### New Capabilities
- `frontend-styling`: Defines the project's styling system — Tailwind as the utility layer, shadcn/ui as the owned component layer, design tokens (color, spacing, typography, radius, dark mode) as the contract that all feature UI is built against.

### Modified Capabilities
None. The Tailwind dependency additions and Vite plugin wiring don't modify any existing `frontend-scaffold` requirement (the scaffold spec covers `create vite` baseline deps and proxy/build behavior, none of which change here). All new requirements live in the new `frontend-styling` capability.

## Impact

- **Code**: `frontend/src/index.css`, `frontend/src/App.css`, `frontend/vite.config.ts`, `frontend/package.json`, the existing login/signup/home feature components under `frontend/src/features/`. A new `frontend/src/components/ui/` directory is introduced, plus a `frontend/src/lib/utils.ts` for the shadcn `cn()` helper, plus `components.json` at the frontend root for shadcn config.
- **Dependencies**: New runtime deps (`tailwindcss`, `@tailwindcss/vite`, `class-variance-authority`, `clsx`, `tailwind-merge`, `lucide-react`, `tw-animate-css`, plus the Radix primitives the generated components rely on — the `radix-ui` umbrella package on the current shadcn registry, or individual `@radix-ui/react-*` packages on older registries). The current shadcn preset also brings the `@fontsource-variable/geist` font as a runtime dep. No removals.
- **APIs**: No backend or HTTP contract changes.
- **Tests**: Existing Vitest component tests must continue to pass. Playwright E2E selectors that rely on visible text or `data-testid` continue to work; any selectors coupled to current class names will need updating.
- **Build & CI**: No new CI jobs; existing `pnpm build` / `pnpm test` jobs cover the change. Bundle size will grow modestly from Tailwind's JIT output and Radix primitives used by shadcn components.
- **Lock-in**: None — shadcn components are owned in-repo and Tailwind is removable like any utility CSS.
