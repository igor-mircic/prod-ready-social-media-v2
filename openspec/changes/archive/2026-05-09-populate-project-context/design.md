## Context

The repo is fresh — only OpenSpec scaffolding exists, no source code yet. `openspec/config.yaml` ships with a commented-out template for `context:` and `rules:`. The stack has been chosen by the project owner (Java/Spring, React, Playwright, Postgres) but not codified anywhere AI tooling can read.

## Goals / Non-Goals

**Goals:**
- Codify the chosen stack and domain in `context:` so future artifact generation is grounded.
- Keep the file readable as YAML and faithful to the OpenSpec schema (`schema: spec-driven`).
- Make the convention placeholder visibly TBD so it isn't mistaken for an agreed rule.

**Non-Goals:**
- Defining concrete coding conventions (formatters, commit style, test frameworks beyond Playwright). Those are decisions for later changes once code starts landing.
- Populating the `rules:` block. We'd be inventing artifact-specific rules in a vacuum.
- Adding a `README.md` or other docs — separate change if the user wants one.

## Decisions

### Decision 1: Use a YAML block scalar (`context: |`) for the context value

A multi-line block scalar keeps the content readable and lets us use plain prose for the stack and domain. Alternative: a structured map (e.g. `context: {backend: ..., frontend: ...}`). The OpenSpec config.yaml example in the file itself uses the block-scalar form, so we follow suit for consistency with the schema's intended usage.

### Decision 2: Mark conventions explicitly as `TBD`

A literal `Conventions: TBD ...` line is more honest than omitting the topic entirely. It signals to a future reader (human or AI) that conventions are an open question, not an oversight.

### Decision 3: Leave `rules:` commented

Same reasoning as the conventions placeholder, taken further: `rules:` constrains how OpenSpec artifacts are generated. Constraining generation before we've generated anything substantial is premature optimization. Revisit once we have artifact patterns to react to.
