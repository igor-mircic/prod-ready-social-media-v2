## Context

The frontend has a working Vite + React 19 + TypeScript scaffold (`frontend/`), with `react-hook-form`, `zod`, `@tanstack/react-query`, `react-router-dom`, and an Orval-generated API client already in place. Two real features ship today — login and active-session listing — under `frontend/src/features/`, styled with a small amount of ad-hoc CSS in `App.css` / `index.css`. There is no shared visual vocabulary, no theme, no dark mode, and no accessible component primitives. The product is a social media platform aiming at enterprise-realistic standards, so the visual surface area will grow quickly (feed, profile, composer, navigation, modals, menus). Picking the wrong abstraction now compounds.

The team has a stated preference (memory) for tooling that supports fast AI-assisted iteration — utility classes inline in JSX score well here because the styling and the markup live in the same file the model edits.

## Goals / Non-Goals

**Goals:**
- Establish a single styling primitive (utility classes) and a single component primitive (owned in-repo, Radix-based) before any further feature work.
- Make design tokens (color, spacing, typography, radius, dark-mode flag) the canonical contract — feature code references tokens, not raw hex/px.
- Prove the system end-to-end by re-skinning the existing login/session screens.
- Keep accessibility wins (focus rings, keyboard navigation, ARIA) from leaking out of the framework into per-feature code.
- Preserve all existing integrations (`react-hook-form`, `zod`, `@tanstack/react-query`, Orval client, `react-router-dom`).

**Non-Goals:**
- Building a full design language (brand identity, illustration system, motion system) — only the token primitives.
- Migrating the entire app — only login and active-session screens are reskinned in this change.
- Adding new product features (feed, posts, profile UI).
- Choosing an icon set beyond `lucide-react` (the shadcn default).
- Backend or API changes.
- Performance/bundle-size optimization beyond Tailwind's default JIT output.
- Adding Storybook or visual regression testing (separate change if we decide we want them).

## Decisions

### Decision 1: Tailwind CSS v4 as the styling primitive

**Choice:** Tailwind CSS v4 via the `@tailwindcss/vite` plugin, configured in CSS (`@import "tailwindcss"; @theme { ... }`) rather than the v3-style `tailwind.config.js`.

**Why:**
- Utility classes live next to the markup — Claude (and humans) refactor in a single file, no cross-cutting class-name vs. styles search.
- Tailwind v4 collapses config into CSS (`@theme` block) and ships its Vite plugin first-class — fewer moving parts.
- JIT output keeps the runtime CSS small without manual purging.

**Alternatives considered:**
- **CSS Modules** — scoped and stable, but the styling lives in a separate `.module.css` file, doubling the surface to read when iterating on a component. Also no token system out of the box.
- **CSS-in-JS (emotion, styled-components)** — runtime cost, SSR friction, and discourages utility-style composition. React 19's compiler story makes this even less attractive.
- **Vanilla CSS + custom properties only** — possible, but reinvents Tailwind's spacing/typography scales and forfeits the shadcn ecosystem.
- **Tailwind v3** — older config style, no Vite-first plugin. v4 is the current generation, and we have no legacy v3 config to migrate from.

### Decision 2: shadcn/ui as the component layer, vendored into the repo

**Choice:** Use the shadcn CLI (`pnpm dlx shadcn@latest add <component>`) to generate components into `frontend/src/components/ui/`. These files are committed; shadcn is *not* an npm dependency.

**Why:**
- Components are owned source code, not a black-box dependency. We can edit them when product needs diverge from defaults.
- Built on Radix primitives → a11y (keyboard nav, focus management, ARIA) is handled inside the component.
- The component-on-disk model is unusually AI-friendly: when behavior needs to change, the model edits a real file in the repo.
- No version lock-in or breaking-change treadmill from a UI library upgrade.

**Alternatives considered:**
- **Mantine** — batteries-included and fast to onboard, but every component is a black-box import. Customization paths are prop-based and quickly hit limits for a social UI that wants a distinct look.
- **MUI** — Material Design's visual language reads "admin tool," not "social app." Heavy bundle. Theming is real work to override.
- **Chakra UI** — pleasant DX but same lock-in shape as Mantine, and less momentum than shadcn in 2025–2026.
- **Hand-roll on Radix** — strictly more work than shadcn for the same result. shadcn *is* curated Radix wrappers.
- **Headless UI** — narrower component set, no styling story, no CLI scaffolding.

### Decision 3: Design tokens as CSS custom properties, consumed via Tailwind v4 `@theme`

**Choice:** Define tokens as CSS custom properties inside `@theme` in `index.css`. Tailwind v4 automatically generates utilities for any token declared there (e.g., `--color-primary` → `bg-primary`, `text-primary`). Dark mode swaps the same token variables under a `.dark` class.

Token categories in scope for this change:
- **Color**: `background`, `foreground`, `primary`, `primary-foreground`, `secondary`, `secondary-foreground`, `muted`, `muted-foreground`, `accent`, `accent-foreground`, `destructive`, `destructive-foreground`, `border`, `input`, `ring`, `card`, `card-foreground`, `popover`, `popover-foreground` (the shadcn baseline set).
- **Radius**: a single `--radius` token; shadcn derives `sm`/`md`/`lg`/`xl` from it.
- **Typography**: Tailwind's default font scale, with `--font-sans` overridable to a chosen system stack.
- **Spacing**: Tailwind's default 4px scale (no override in this change).

**Why:**
- Single source of truth — Tailwind utilities, shadcn components, and any escape-hatch raw CSS all read from the same variables.
- Dark mode is a one-line theme swap, not a recolor of every component.
- Matches the shadcn project default exactly, so generated components work without rewrites.

**Alternatives considered:**
- **JS object tokens passed to a theme provider** — adds a runtime dependency and breaks compatibility with shadcn's CSS-variable model.
- **No tokens, raw Tailwind colors (`bg-blue-500` etc.)** — fast to start, painful to retheme or dark-mode later.

### Decision 4: Dark mode on from day one, via `class` strategy

**Choice:** Support light + dark from the first commit. Use Tailwind's `class` strategy — a `.dark` class on `<html>` toggles the theme. No user-facing theme switcher in *this* change; the toggle ships in a follow-up. The default theme respects the OS preference via a small inline script in `index.html` that sets the class before React hydrates.

**Why:**
- Cheap to bake in now (it's just an extra set of CSS-variable overrides). Retrofitting dark mode later means re-auditing every component.
- Avoids FOUC: the inline script runs before React, so the initial paint is correct.

**Alternatives considered:**
- **Light-only for now, add dark later** — every component would need an a11y/contrast audit a second time. Net more work.
- **`media` strategy (CSS-only)** — respects OS preference but can't be user-overridden later without restructuring; the `class` strategy is a strict superset.

### Decision 5: Proving ground = login + signup + home screens, no new feature work

**Choice:** Restyle only the existing login form, signup form, and the post-login `HomePage` as part of this change. No new screens.

**Note on prior intent:** Earlier drafts of this change referenced an "active-session listing" screen. That screen does not exist in the repo today — the prior `add-login-and-sessions` change delivered sessions as a backend (Postgres) concern only, with no frontend listing UI. Building one now would require new backend endpoints and would violate the "no new feature work" guardrail. We instead use `HomePage` (the only authenticated surface) plus `SignupForm` (a near-clone of the login form) to exercise the same axes the original plan intended: form integration with `react-hook-form` + `zod`, button loading state, error states, and a non-form layout that consumes auth state.

**Why:**
- Small, well-bounded surface to exercise: two forms (with `react-hook-form` + `zod`), error states, buttons (loading state), and a logged-in layout.
- Surfaces real integration friction (form library, validation messages, async state from `@tanstack/react-query`) without scope creep.
- Anything broader risks the change ballooning and slipping past review.

**Alternatives considered:**
- **Build a sample page just to demo the system** — throwaway code, doesn't prove integration with the real stack we use.
- **Restyle everything in the codebase** — there isn't much "everything" yet, but it still doubles the diff and review burden.
- **Add a session-listing screen now** — contradicts "no new feature work" and pulls in backend changes; out of scope.

### Decision 6: Directory layout

**Choice:**
```
frontend/
  components.json                  # shadcn config (project root)
  src/
    components/
      ui/                          # shadcn-generated primitives (Button, Input, Card, …)
    lib/
      utils.ts                     # cn() helper (clsx + tailwind-merge)
    features/                      # existing feature folders, unchanged location
    index.css                      # Tailwind import + @theme tokens + dark-mode overrides
    App.css                        # removed (contents folded into index.css or deleted)
```

**Why:**
- Matches the shadcn CLI's default expectations — no aliases to wire up.
- Keeps the existing `features/` convention untouched.
- `lib/` is the conventional home for the `cn()` helper; shadcn's generated imports assume it.

**Alternatives considered:**
- **Put primitives under `features/ui/`** — fights the shadcn CLI defaults for no benefit.
- **Skip the `lib/` folder, inline `cn()`** — every shadcn component imports `@/lib/utils`. Fighting the default just to save a file is a bad trade.

## Risks / Trade-offs

- **Tailwind class-name visual noise** → Keep classes terse; extract long, repeated class strings into component variants via `class-variance-authority` (which shadcn already uses). Don't preemptively extract — only when a string is reused.
- **shadcn drift from upstream** → shadcn doesn't push updates to your repo. Mitigation: accept this as a feature. We pin to whatever the generator emits at install time; we re-generate intentionally when we want changes.
- **E2E test breakage from class-name changes** → Audit Playwright selectors; prefer role/text/`data-testid` over class-based selectors. Update any class-coupled selectors as part of the screen-by-screen restyle.
- **Bundle size grows** → Tailwind JIT keeps utility CSS small; Radix primitives add ~10–20KB per component used. Acceptable for the a11y baseline they provide; monitor if it becomes a problem.
- **Two ways to style (Tailwind utilities vs. raw CSS)** → Mitigation: a short README/convention note in `frontend/` saying utilities first, raw CSS only inside `index.css` for tokens. Don't formalize a lint rule yet.
- **Tailwind v4 is recent** → Mitigation: it's stable and the official Vite plugin is GA. If a blocker emerges, downgrading to v3 is a config-only change.
- **Dark mode quality bar** → The first pass uses shadcn's default dark palette. We accept that it may not be brand-final; a future "design language" change can replace the palette without touching component code.

## Migration Plan

This is a frontend-only, no-backend change. There is no data migration. The deploy story:

1. Land the change behind no feature flag — the existing screens render with the new system from the first commit that ships.
2. The diff is reviewable in two halves: (a) infrastructure (Tailwind setup, tokens, shadcn primitives), (b) screen restyles.
3. Rollback = revert the PR. No persisted state changes.

## Open Questions

None blocking. Items deferred to follow-up changes:

- **Theme toggle UI** — when do we expose dark mode to users? (Probably a tiny follow-up change once a settings or nav surface exists.)
- **Brand palette** — current change uses shadcn's neutral defaults. A real palette is a design decision we don't have inputs for yet.
- **Storybook / visual regression** — useful once we have ~10+ primitives. Premature now.
- **Icon strategy beyond `lucide-react`** — accept `lucide` for now; revisit if we need custom illustrations.
