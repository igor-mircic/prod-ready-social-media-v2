## Why

`openspec/config.yaml` ships with an empty `context:` block. Every future OpenSpec artifact (proposals, specs, designs) is generated without project context, so AI assistants can't reflect our actual stack or conventions when drafting them. Filling this in once pays off on every subsequent change.

## What Changes

- Populate `context:` in `openspec/config.yaml` with: tech stack (Java/Spring on the backend, React on the frontend, Playwright for e2e, Postgres for DB), domain (social media platform built to enterprise/production standards), and a TBD placeholder for conventions.
- Leave the `rules:` block as a commented template — no artifact-specific rules yet, and inventing them now would be premature.

## Capabilities

### New Capabilities
- `project-context`: AI-readable project context surfaced via `openspec/config.yaml` so artifact generation reflects the real stack and domain.

### Modified Capabilities
None.

## Impact

- `openspec/config.yaml`: replace the commented `context:` template with a populated block.
