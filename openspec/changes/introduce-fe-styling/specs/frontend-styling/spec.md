## ADDED Requirements

### Requirement: Tailwind CSS v4 is the styling primitive

The `frontend/` project SHALL use Tailwind CSS v4 as its sole utility-CSS framework, wired into Vite via the official `@tailwindcss/vite` plugin. Tailwind utility classes SHALL be the primary mechanism for applying styles in feature components; hand-written CSS SHALL be limited to global concerns inside `frontend/src/index.css` (Tailwind imports, design tokens, dark-mode overrides, and base typography resets).

#### Scenario: Tailwind dependency is declared
- **WHEN** a reader inspects `frontend/package.json`
- **THEN** the `dependencies` (or `devDependencies`) block includes `tailwindcss` at a v4 major version
- **AND** includes `@tailwindcss/vite` at a matching major version.

#### Scenario: Vite is wired to Tailwind
- **WHEN** a reader opens `frontend/vite.config.ts`
- **THEN** the `plugins` array includes the `@tailwindcss/vite` plugin invocation
- **AND** the plugin is invoked alongside the existing React plugin without removing or reordering the React plugin.

#### Scenario: Global stylesheet imports Tailwind
- **WHEN** a reader opens `frontend/src/index.css`
- **THEN** the file imports Tailwind via the v4 syntax (`@import "tailwindcss";`)
- **AND** does not use the deprecated v3 `@tailwind base; @tailwind components; @tailwind utilities;` directives.

#### Scenario: No tailwind.config.js is committed
- **WHEN** a reader inspects `frontend/`
- **THEN** no `tailwind.config.js` or `tailwind.config.ts` file is present at the project root
- **AND** Tailwind configuration lives in `frontend/src/index.css` via the v4 `@theme` directive.

### Requirement: Design tokens are declared in CSS and consumed via Tailwind v4 `@theme`

The `frontend/src/index.css` file SHALL declare the project's design tokens as CSS custom properties inside a Tailwind v4 `@theme` block, so that token values flow into Tailwind utilities (e.g., `bg-primary`, `text-muted-foreground`) and into shadcn-generated components without duplication.

Token categories that MUST be declared:
- **Color** (light theme): `--color-background`, `--color-foreground`, `--color-primary`, `--color-primary-foreground`, `--color-secondary`, `--color-secondary-foreground`, `--color-muted`, `--color-muted-foreground`, `--color-accent`, `--color-accent-foreground`, `--color-destructive`, `--color-destructive-foreground`, `--color-border`, `--color-input`, `--color-ring`, `--color-card`, `--color-card-foreground`, `--color-popover`, `--color-popover-foreground`.
- **Radius**: a single `--radius` base token.
- **Typography**: at minimum a `--font-sans` token resolved to a defined system font stack.

#### Scenario: @theme block declares the color tokens
- **WHEN** a reader opens `frontend/src/index.css`
- **THEN** the file contains an `@theme` block
- **AND** the block declares the full color token set listed in this requirement.

#### Scenario: Radius token is declared
- **WHEN** a reader opens `frontend/src/index.css`
- **THEN** the `@theme` block (or an adjacent `:root` selector that `@theme` reads from) declares a `--radius` token with a concrete length value.

#### Scenario: Typography token is declared
- **WHEN** a reader opens `frontend/src/index.css`
- **THEN** the `@theme` block declares a `--font-sans` token with a concrete font stack.

#### Scenario: Tokens flow into Tailwind utilities
- **WHEN** a developer uses a token-derived utility class such as `bg-primary` or `text-muted-foreground` in a component
- **THEN** the rendered element receives the color defined by the corresponding CSS custom property
- **AND** changing the token value in `index.css` updates every consumer without further code changes.

### Requirement: Dark mode is supported via the class strategy

The frontend SHALL ship a working dark theme from the first commit, toggled by the presence of a `.dark` class on the `<html>` element. The dark theme SHALL be a complete override of every color token declared by the light theme; no light-theme token may leak through.

A small inline script in `frontend/index.html` SHALL set the initial `.dark` class on `<html>` **before** React hydrates, based on the user's OS-level `prefers-color-scheme` preference, to avoid a flash of incorrect theme on first paint.

This change does NOT require a user-facing theme toggle UI; the toggle is left to a follow-up change.

#### Scenario: Dark-theme overrides are declared
- **WHEN** a reader opens `frontend/src/index.css`
- **THEN** the file declares a `.dark { ... }` block that overrides every color token declared for the light theme
- **AND** the dark block uses the same custom-property names with dark-appropriate values.

#### Scenario: Initial theme respects OS preference
- **WHEN** a user first loads the app and their OS reports `prefers-color-scheme: dark`
- **THEN** the `<html>` element has the `.dark` class set before React's first paint
- **AND** no flash of light theme is visible during initial render.

#### Scenario: Initial theme respects OS light preference
- **WHEN** a user first loads the app and their OS reports `prefers-color-scheme: light`
- **THEN** the `<html>` element does NOT have the `.dark` class on first paint.

### Requirement: shadcn/ui primitives are owned in the repo

The frontend SHALL host its reusable UI primitives (buttons, inputs, cards, labels, form helpers, etc.) as source files committed to `frontend/src/components/ui/`, generated via the shadcn CLI. shadcn SHALL NOT appear as a runtime npm dependency in `frontend/package.json`; only its supporting runtime helpers (`class-variance-authority`, `clsx`, `tailwind-merge`, `lucide-react`, and any `@radix-ui/*` packages required by generated components) appear as dependencies.

The shadcn CLI configuration SHALL live at `frontend/components.json` so subsequent `pnpm dlx shadcn@latest add <component>` invocations emit components into the agreed location with the agreed style.

#### Scenario: components.json exists at the frontend root
- **WHEN** a reader inspects `frontend/`
- **THEN** a `components.json` file is present at the project root
- **AND** its `style`, `tailwind`, and `aliases` fields point at the chosen configuration (style set, the CSS file path, and the `@/components`, `@/lib/utils` aliases).

#### Scenario: ui primitives live under src/components/ui
- **WHEN** a reader inspects `frontend/src/components/ui/`
- **THEN** the directory contains shadcn-generated component files committed to the repo
- **AND** at minimum the components needed to render the proving-ground screens are present (see the "Proving-ground screens" requirement below).

#### Scenario: shadcn is not a runtime dependency
- **WHEN** a reader inspects `frontend/package.json`
- **THEN** no package named `shadcn`, `shadcn-ui`, or `@shadcn/ui` appears in `dependencies` or `devDependencies`.

#### Scenario: Required supporting helpers are dependencies
- **WHEN** a reader inspects `frontend/package.json`
- **THEN** the `dependencies` block includes `class-variance-authority`, `clsx`, `tailwind-merge`, and `lucide-react`.

### Requirement: The `cn()` class-merging helper lives at `src/lib/utils.ts`

The frontend SHALL provide a `cn(...inputs)` helper that combines `clsx` and `tailwind-merge`, located at `frontend/src/lib/utils.ts`. This is the canonical class-name composition utility used by every shadcn-generated component.

#### Scenario: cn() helper file exists
- **WHEN** a reader inspects `frontend/src/lib/utils.ts`
- **THEN** the file exports a function named `cn` that takes a rest-args list of class-name inputs and returns a single merged class string.

#### Scenario: cn() uses clsx and tailwind-merge
- **WHEN** a reader opens `frontend/src/lib/utils.ts`
- **THEN** the implementation composes `clsx(inputs)` with `twMerge(...)` (or equivalent merging) from `tailwind-merge`.

### Requirement: Path alias `@` resolves to `src`

The frontend SHALL configure the `@` path alias to resolve to `frontend/src/`, so that shadcn-generated imports such as `import { cn } from "@/lib/utils"` and `import { Button } from "@/components/ui/button"` work without modification. The alias SHALL be declared in both `tsconfig.json` (for the TypeScript compiler and editor tooling) and `vite.config.ts` (for the bundler).

#### Scenario: TypeScript path alias is declared
- **WHEN** a reader opens `frontend/tsconfig.json` (or the chained `tsconfig.app.json`)
- **THEN** the `compilerOptions.paths` block contains an entry mapping `"@/*"` to `["./src/*"]`
- **AND** `compilerOptions.baseUrl` is set to a value compatible with the alias.

#### Scenario: Vite resolves the alias at build time
- **WHEN** a reader opens `frontend/vite.config.ts`
- **THEN** the `resolve.alias` block contains an entry mapping `@` to the absolute path of `frontend/src`.

### Requirement: Proving-ground screens use the new styling system

The existing **login** and **active-session listing** screens under `frontend/src/features/` SHALL be re-implemented to consume the new styling system: their visual elements MUST be composed from shadcn-generated primitives under `@/components/ui/` and styled via Tailwind utilities. After this change, neither feature SHALL apply colors, spacing, typography, or border radii via inline `style={...}` props or via bespoke CSS classes defined in `App.css`.

The change SHALL NOT alter the behavior of these screens — form validation rules, route paths, success/error flows, network calls, and the existing E2E test expectations remain unchanged.

#### Scenario: Login screen renders from shadcn primitives
- **WHEN** a reader inspects the login feature components under `frontend/src/features/`
- **THEN** the form's input fields are rendered via an `Input` primitive imported from `@/components/ui/`
- **AND** the submit control is rendered via a `Button` primitive imported from `@/components/ui/`
- **AND** field labels are rendered via a `Label` primitive imported from `@/components/ui/`.

#### Scenario: Active-session listing renders from shadcn primitives
- **WHEN** a reader inspects the session-listing feature components under `frontend/src/features/`
- **THEN** the listing layout uses `Card` (or an equivalent shadcn primitive) imports from `@/components/ui/`
- **AND** any action controls (e.g., revoke buttons) use the `Button` primitive.

#### Scenario: No legacy inline color/spacing styles remain on proving-ground screens
- **WHEN** a reader inspects the login and session-listing feature components
- **THEN** no element declares colors, padding, margin, font-size, or border-radius via inline `style` props
- **AND** no element references CSS classes defined in `App.css`.

#### Scenario: Existing tests continue to pass
- **WHEN** a developer runs `pnpm test` inside `frontend/`
- **THEN** all Vitest component tests pass without modification to their assertions (selector updates to use role/text/`data-testid` are permitted; behavioral expectations are not changed).

#### Scenario: Existing E2E flows continue to pass
- **WHEN** the e2e harness runs the existing Playwright login and session flows against the rebuilt frontend
- **THEN** all flows pass
- **AND** any selector updates are limited to selector strategy (role/text/`data-testid`), not to flow steps.

### Requirement: Legacy App.css is removed or reduced to imports

The pre-existing `frontend/src/App.css` file — which contained Vite-default boilerplate — SHALL either be deleted or reduced to a single empty stylesheet. Its prior content SHALL NOT survive in any feature component. The canonical home for global styles is `frontend/src/index.css`.

#### Scenario: App.css is empty or absent
- **WHEN** a reader inspects `frontend/src/`
- **THEN** either `App.css` does not exist, or its content is empty (whitespace-only) or limited to a single comment indicating intentional vacancy.

#### Scenario: App.tsx does not import App.css
- **WHEN** a reader opens `frontend/src/App.tsx`
- **THEN** there is no `import "./App.css"` statement (or the import has been removed alongside the file).
