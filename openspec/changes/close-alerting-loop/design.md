## Context

Slice 8 of the observability arc built the alerting machinery — Prometheus burn-rate rules, recording rules, an Alertmanager container, a Grafana Alertmanager datasource, and `promtool` rule tests. It explicitly stopped short of the consumer side: the only Alertmanager receiver is the built-in `null` receiver, no alert carries a `runbook_url`, and no end-to-end test proves a firing reaches anything. The slice-8 design doc names "real webhook receiver, fault injection, runbooks, end-to-end alert-firing tests" as a deferred follow-up. This is that follow-up.

The current routing-contract labels (`severity ∈ {page, ticket}`, `slo ∈ {api_availability, feed_read_latency, post_create_latency, lcp, inp}`) were chosen in slices 8 and 10 specifically so this slice could route on them without renaming anything. The recording-rule names and `for:` clauses are stable and out of scope here. The webhook-sink container is the local stand-in for a real PagerDuty / Opsgenie / Slack integration — production teams use the same `webhook_configs` block, just pointed at a different URL.

This slice changes infra and config only, plus a new e2e spec and a small Node container. There are no Java or React code changes.

## Goals / Non-Goals

**Goals:**
- Replace the `null` receiver with real webhook receivers that record every routed firing in a surface a test can query.
- Establish a severity-based routing tree (`page` vs `ticket`) using Alertmanager's standard config shape.
- Establish the contract that every alert carries a `runbook_url` annotation pointing at a runbook stub committed to the repo.
- Establish one canonical inhibition rule (`BackendDown` → all `slo=*` alerts) as the worked example of Alertmanager-side suppression.
- Prove the wire-shape end-to-end with a Playwright spec that POSTs synthetic alerts and asserts what the sink receives.

**Non-Goals:**
- `/__dev/fault` backend endpoint or any other way to drive a real SLO burn. The synthetic-POST e2e proves the routing surface without the 2m–1h wait imposed by the alert `for:` clauses.
- Real paging integrations (PagerDuty / Opsgenie / Slack). The webhook-sink is the dev stand-in; swapping it for a real receiver is a one-line config change later.
- Adding new SLOs, new alerts, or changing existing `for:` / threshold values. This slice only adds annotations and routing.
- HA Alertmanager (peer mesh), persistent silences, time-based silence UX, or external alert federation.
- Surfacing the webhook sink in Grafana. Alertmanager's own UI plus `docker compose logs webhook-sink` are sufficient for local introspection.

## Decisions

### Decision 1 — Custom webhook-sink container, not `alertmanager-webhook-logger`

The off-the-shelf option is `alertmanager-webhook-logger` (or similar), which logs incoming webhook payloads to stdout. Tests against it would have to parse container stdout — fragile, race-prone, and ordering-sensitive.

A ~30-line Node + Express container under `infra/observability/webhook-sink/` is the same total LOC and gives a deterministic queryable surface: `POST /page` and `POST /ticket` accept Alertmanager's webhook envelope, store it in a bounded in-memory ring, and `GET /received[?path=...]` returns the recorded payloads as JSON. The e2e spec polls this endpoint instead of scraping logs.

Rejected: stdout-scraping (fragile), persistent storage (overkill for dev — a fresh stack starts with an empty ring), and pre-built mock servers like WireMock / MockServer (heavy; their config surface is its own learning curve, and we only need three endpoints).

### Decision 2 — Severity-based routing tree, one sink with two paths

The routing tree matches on the `severity` label only:

```yaml
route:
  receiver: 'default'
  group_by: ['alertname', 'slo']
  group_wait: 10s
  group_interval: 5m
  repeat_interval: 4h
  routes:
    - matchers: [severity="page"]
      receiver: 'page-webhook'
      continue: false
    - matchers: [severity="ticket"]
      receiver: 'ticket-webhook'
      continue: false

receivers:
  - name: 'default'
  - name: 'page-webhook'
    webhook_configs:
      - url: 'http://webhook-sink:8080/page'
        send_resolved: true
  - name: 'ticket-webhook'
    webhook_configs:
      - url: 'http://webhook-sink:8080/ticket'
        send_resolved: true
```

`default` exists so unmatched alerts (none today, but a safety net for future ones added without a `severity` label) do not crash Alertmanager — its rule that *every* alert must hit a leaf route makes the default mandatory. It points back to `page-webhook` via a future change, but for now it's an empty receiver (so noisy unlabelled alerts go nowhere visible — same behaviour as the old `null` stub, but only for the edge case).

Rejected: two separate sink containers (no operational difference, just more YAML); routing on `slo` label (premature — by-team or by-service routing belongs in a real on-call setup, not in local dev); a single endpoint with severity in the path (works, but inverts the responsibility — Alertmanager picking the URL is more idiomatic than the sink dispatching internally).

### Decision 3 — Synthetic alert POST in the e2e spec, not real SLO burn

Driving a real burn would require either (a) firing thousands of failing requests in a 5m window or (b) test-only recording rules with shorter windows. Both are bad: (a) is slow and flaky; (b) couples the test to private rule scaffolding and proves the rule, not the routing.

Alertmanager exposes `POST /api/v2/alerts` (the same endpoint Prometheus uses) accepting a JSON array of alert objects with labels and annotations. The e2e spec POSTs a synthesised alert with the exact labels a real burn would produce, then polls `GET /received` on the sink. This tests the surface that this slice actually changes — routing, receivers, annotation preservation, inhibition — in seconds, deterministically, without coupling to the rule definitions.

Rejected: a `/__dev/fault` endpoint (separate concern; `for:` clauses still impose a 2m+ wait); `promtool` for routing (it tests Prometheus's view of alerts only — what evaluates, what fires — and has no model of Alertmanager's routing tree or inhibition).

### Decision 4 — `runbook_url` is a hard contract for every alert

Every alert gains an `annotations.runbook_url:` field pointing at a Markdown stub under `infra/observability/runbooks/`. The URL is a GitHub blob link (the repo URL is stable for the project's lifetime; raw-blob is a separate UX). For the local-dev case where there is no remote, the e2e spec asserts only that the annotation is present and non-empty — not that it resolves.

Runbook stubs are intentionally tiny (~6 lines, Symptoms / Impact / Triage / Mitigation / Escalation). The point of this slice is the *contract* that every alert has a runbook — content fills in over time as real incidents drive learning. Shipping twelve stubs today and twelve fleshed-out documents later is the same diff cost as shipping nothing and then writing twelve documents from scratch.

Rejected: a single combined runbook with anchors per alert (loses per-file editability and git blame granularity); deferring runbooks entirely (defeats the slice's "make alerts actionable" purpose); generating stubs from a template at provisioning time (clever, but the static files are easier to edit and grep).

### Decision 5 — One inhibition rule, by hand

```yaml
inhibit_rules:
  - source_matchers: [alertname="BackendDown"]
    target_matchers: [slo=~".+"]
    equal: []
```

When the backend is down, the burn-rate rules can't produce meaningful ratios (denominator → 0 or NaN), and even if they could, the operator already knows: the problem is "backend is down", not "feed-read latency is slow". Inhibiting the SLO alerts keeps the page noise-free.

`equal: []` is correct here because there's only one backend target in this slice — we want a BackendDown anywhere to suppress all SLO alerts anywhere. In a multi-service environment `equal: ['service']` would scope inhibition per service; that's a future-slice concern.

This rule is the worked example. `promtool` cannot test it (inhibition is an Alertmanager concept, not a Prometheus one), so the e2e spec owns the proof: POST `BackendDown` and `ApiAvailabilityFastBurn` together, then assert only `BackendDown` appears at the sink.

Rejected: inhibition rules per SLO (more code, no additional teaching value); routing-based suppression (`severity=page` matchers with `continue: false` — works but inverts the model; inhibition is the canonical primitive for "alert X suppresses alert Y").

### Decision 6 — `send_resolved: true` on both webhook receivers

Webhook receivers default to firing-only. Setting `send_resolved: true` means the sink also receives a notification when an alert clears (Alertmanager flips the `status` field to `resolved` in the payload). The pedagogical value: the e2e spec can show the full state machine (firing → resolved) instead of testing half of it. The cost: one line of YAML per receiver and a slightly larger sink payload buffer.

Rejected: `send_resolved: false` (saves nothing, hides half the model); per-alert override of the receiver default (no use case in dev).

## Risks / Trade-offs

- **The `observability` profile now runs seven containers.** Slice 8 noted six; we add one. → README run-loop section is updated; the existing spec scenario "Default `docker-compose up -d postgres` starts only Postgres" remains satisfied because `webhook-sink` is also profile-gated.

- **Webhook-sink is custom code, however small, and lives outside the existing Java/TS lint+format setup.** → `infra/observability/webhook-sink/` carries no project-wide ESLint config; the directory documents its own minimal lint contract in its README (or none, given the file is ~30 lines and pinned by tag).

- **Pinned Node base image will drift.** → Pin to a specific tag in the Dockerfile (e.g. `node:22.11-alpine`, the exact digest is not necessary at this scale). Renewals are tracked the same way the project tracks `prom/alertmanager` and `grafana/grafana` tags.

- **The e2e spec depends on the observability profile being up.** CI does not run that profile (same as the slice-9 exemplar test). → The spec self-skips when Alertmanager's `:9093` or the sink's `:8080` is unreachable, matching the established skip pattern. Local runs cover it; CI does not.

- **`runbook_url` points at a GitHub blob path that is theoretically rewriteable.** A repo rename would break every annotation. → Acceptable risk for a dev/learning project; the URL is centralised in a small set of YAML files and can be sed-replaced in one shot if needed. The runbook *file paths* are the load-bearing artifact; the URL prefix is bookkeeping.

- **In-memory ring on the sink is bounded.** A test that runs in parallel with a noisy interactive session could see a payload it doesn't expect. → The ring is small (e.g. 64 entries) and `GET /received` supports `?after=<timestamp>` so the e2e spec only sees what was POSTed after it began. Local-dev noise is bounded by Alertmanager's `group_interval` regardless.

- **No production paging is wired.** Pretending the webhook sink is "real alerting" would be misleading. → README and the runbook stubs explicitly call out that this is the local-dev surface and a real receiver (Slack / PagerDuty / Opsgenie) is what production swaps in.

## Migration Plan

This is an additive change to a local-dev observability stack; there is no production deploy and no rollback procedure beyond `git revert`.

- **Local apply:** pull the branch, `docker compose --profile observability up -d webhook-sink alertmanager grafana prometheus`. Alertmanager restart is required to pick up the new `alertmanager.yml`; Prometheus restart is required to pick up the new `runbook_url` annotations in the rule files (`/etc/prometheus/rules/*.yml`). Grafana does not need restarting — no datasource changes in this slice.
- **CI gate:** `promtool test rules` continues to run on every PR with the extended fixtures; the new e2e spec self-skips in CI because the observability profile is not present.
- **Rollback:** `git revert` the merge. The observability profile gracefully degrades when the sink is missing — Alertmanager will log webhook delivery failures and retry per its built-in policy, but Prometheus rules continue to evaluate and the rest of the stack is unaffected.

## Open Questions

- **Send-resolved buffer behaviour on the sink.** A firing followed by its resolved counterpart is two payloads. Does the e2e spec assert both, or just the firing? Lean: just the firing for this slice (resolved would require a separate POST flipping `endsAt`, which adds complexity without proving new wire-shape). Decide while writing the spec.
- **Sink port — `8080` or `:8081`?** No backend is bound to host `:8080` in dev, but the docker-compose convention has been to avoid common host port conflicts. Lean: `:8081` on the host, `:8080` inside the container. Confirm against the existing port allocation in `docker-compose.yml`.
- **Should the `default` route actually have a receiver, or is an empty receiver fine?** Alertmanager requires the default route to point at a defined receiver name; the receiver itself can have no `webhook_configs`. Lean: empty receiver (effectively `/dev/null` for unlabelled alerts, with the understanding that any new alert *should* carry a `severity` label). Document this in the alertmanager.yml header comment.
