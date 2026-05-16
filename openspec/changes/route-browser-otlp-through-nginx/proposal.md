## Why

Slice 18b (`bridge-collectors-to-obs-cluster`) finished the cross-cluster bridge for **backend** telemetry: the in-cluster backend's spans flow through the app-cluster collector and fan out to BOTH the compose collector and the obs-cluster collector. **Browser** telemetry was deliberately left out of that slice — the FE bundle still ships its three OTLP signals (traces, logs, metrics) cross-origin direct to the compose collector via `http://localhost:4318/v1/{traces,logs,metrics}`, gated by an `allowed_origins` CORS allowlist on the compose collector that names every browser-facing port (`:5173`, `:4173`, `:13000`). This is the third sub-slice of the original "slice 18" carve-up that 18a and 18b foreshadowed, and it's the slice that brings the browser onto the same transport as the backend so all telemetry from the app cluster flows through one path.

Routing browser OTLP through nginx (in-k3s) and a vite dev proxy (in dev) gives the project three converging wins: (1) **single origin** — no more cross-origin OTLP from anywhere, the CORS allowlist disappears entirely, slice 22 inherits one path to retire instead of two; (2) **closes the slice-18 trilogy** — every telemetry source on the app cluster reaches the obs cluster via the same in-cluster collector, the dual-write fan-out is symmetric across traces/logs/metrics; (3) **likely auto-fixes the FE→BE trace-propagation gap** memorialized after slice 16 (browser clicks and backend spans currently appear as separate traces) because `@opentelemetry/instrumentation-fetch` strips `traceparent` from cross-origin fetches by default — same-origin removes that strip.

Two bundled hardening items ride along because they touch the same files:
- The OTTL `redact-path-ids` processor in all three collector configs (compose, app k3s, obs k3s) targets stale HTTP semantic-conv attribute names (`http.url`, `http.target`, `url.full`); the modern Java agent only emits `url.path`, so backend path-ID redaction has been a silent no-op since slice 5. Three sites need the same fix; this slice touches all three already.
- The compose collector's `cors:` block becomes dead config once no browser dials it directly. Removing it kills a drift vector and makes the slice-22 retirement strictly additive (nothing left to clean up on the FE-ingress side).

## What Changes

- **Frontend bake-time defaults flipped to relative URLs** in `frontend/Dockerfile`:
  - `VITE_OTEL_TRACES_ENDPOINT` defaults from `http://localhost:4318/v1/traces` to `/v1/traces`.
  - `VITE_OTEL_LOGS_ENDPOINT` defaults from `http://localhost:4318/v1/logs` to `/v1/logs`.
  - `VITE_OTEL_METRICS_ENDPOINT` defaults from `http://localhost:4318/v1/metrics` to `/v1/metrics`.
  - Module-level `DEFAULT_ENDPOINT` constants in `frontend/src/observability/{tracer,errors,meter}.ts` updated to the same relative values, so an unset env var still resolves to a same-origin URL.
- **Vite dev-server proxy** added in `frontend/vite.config.ts` mapping `/v1/{traces,logs,metrics}` → `http://localhost:4318/v1/{traces,logs,metrics}` (compose collector) for the dev loop, so `pnpm dev` on `:5173` sees same-origin OTLP just like the in-k3s bundle on `:13000`. The existing `/api/` and `/actuator/` proxy entries (if present) gain a `/v1/` sibling.
- **Frontend nginx config** (`frontend/docker/nginx.conf`) grows a `location /v1/` block that `proxy_pass`es to `http://collector.social.svc.cluster.local:4318` (the app k3s collector's ClusterIP Service from slice 18a). Same shape as the existing `/api/` and `/actuator/` blocks.
- **App k3s collector** (`infra/k8s/base/collector/configmap.yaml`) grows two new pipelines, with the receivers/processors/exporters shape mirroring the slice-18b traces dual-write:
  - **Logs pipeline**: `receivers: [otlp]` (shared with traces), `processors: [batch, transform/redact-path-ids, filter/frontend_only]` (mirror the compose collector's slice-7 stance — drop log records whose `resource.service.name != "frontend"` as defence in depth), `exporters: [otlphttp/compose-relay-logs, otlphttp/obs-cluster-logs]` fanning out to BOTH the compose collector and the obs k3s collector (parallel to the traces dual-write).
  - **Metrics pipeline**: `receivers: [otlp]` (shared), `processors: [batch]` (no path redaction — FE metric attributes are web-vitals shaped, no high-cardinality path data), `exporters: [otlphttp/compose-relay-metrics, otlphttp/obs-cluster-metrics]`.
  - The traces pipeline is **structurally unchanged** from slice 18b — same dual-write, same processors.
- **Obs k3s collector** (`infra/k8s-obs/base/collector/configmap.yaml`) grows two new pipelines:
  - **Logs pipeline**: `receivers: [otlp]`, `processors: [batch, transform/redact-path-ids]` (defence-in-depth redaction at the destination hop), `exporters: [otlphttp/loki]` pointing at the in-cluster loki Service's OTLP ingest endpoint (`http://loki.observability.svc.cluster.local:3100/otlp` — Loki 3.6+ natively accepts OTLP/HTTP, see design.md Decision 2).
  - **Metrics pipeline**: `receivers: [otlp]`, `processors: [batch]`, `exporters: [prometheusremotewrite/in-cluster]` pointing at the in-cluster prometheus Service's remote-write endpoint (`http://prometheus-server.observability.svc.cluster.local/api/v1/write`).
  - The traces pipeline is structurally unchanged from slice 18b.
- **Obs cluster prometheus chart values** (`infra/k8s-obs/base/prometheus/values.yaml`) gain `server.extraFlags: [enable-feature=remote-write-receiver]` (or the chart-equivalent values path) so the in-cluster prometheus accepts the obs collector's remote-write pushes. (Verified at implementation time; design.md Decision 3 captures the chart-version-specific values path.)
- **OTTL `redact-path-ids` attribute drift fixed at three sites** — `infra/observability/collector/collector-config.yaml`, `infra/k8s/base/collector/configmap.yaml`, `infra/k8s-obs/base/collector/configmap.yaml`. Each file's OTTL `where` clauses and target attribute lists are updated to include `url.path` (the modern Java agent's actual attribute) alongside the stale `http.url`/`http.target`/`url.full` (kept for safety since the FE may still emit one of them). A header comment in each file names the sibling configs to keep drift visible.
- **Compose collector CORS allowlist removed** — `infra/observability/collector/collector-config.yaml`'s `cors:` block under `otlp.protocols.http` is deleted (along with the slice-7 / slice-16 narrative comments above it that explained the entries). A header comment is added: "The compose collector no longer receives browser OTLP directly; routes are slice-18c (browser → nginx → app k3s collector → compose-relay)." The compose collector keeps running for slice-22 dual-write parity.
- **Hetzner overlay stubs** — `infra/k8s/overlays/hetzner/kustomization.yaml` and `infra/k8s-obs/overlays/hetzner/kustomization.yaml` each gain a one-line commented note: "slice 18c added logs+metrics pipelines local-loopback; in production the OTel SDK's relative URL still works (browser served from same origin as SPA); receivers gain mTLS in slice 19." Comments only, no live resources.
- **README** — the "Local observability" section gains a "Browser OTLP path" subsection describing the new shape: `browser → frontend pod (nginx) | vite dev server (proxy) → app collector → {compose, obs-cluster}`. The non-goals subsection is updated to reflect that the compose CORS allowlist is now gone (was a slice-16 / slice-7 artifact).
- **FE→BE trace-propagation gap investigation**: an explicit task documents what the root cause turns out to be. If same-origin alone fixes it (because `instrumentation-fetch`'s default `propagateTraceHeaderCorsUrls` excludes cross-origin URLs), the slice records "fixed by transport". If a `propagateTraceHeaderCorsUrls` allowlist is still needed (e.g., for the BE on a different port in dev), a surgical fix lands. If the root cause is deeper, findings are documented and a follow-up captured rather than expanding scope.

## Capabilities

### New Capabilities

(none — every change lands in an existing capability.)

### Modified Capabilities

- `observability` — modifies the slice 5/7/16 stance that the compose collector accepts cross-origin browser OTLP via a `cors.allowed_origins` allowlist: the allowlist is removed, and the slice 5 `redact-path-ids` OTTL block gains `url.path` to fix the silent no-op on the modern Java agent. The bake-time defaults for the three `VITE_OTEL_*_ENDPOINT` env vars (slice 5 / slice 6 / slice 7 inheritance) flip from absolute compose-collector URLs to relative `/v1/{traces,logs,metrics}` paths.
- `kubernetes` — modifies the slice 18a/18b app k3s collector ConfigMap requirement (the collector pipeline grows logs and metrics pipelines in addition to the dual-write traces pipeline). Modifies the slice 16 frontend nginx config requirement (adds a `/v1/` reverse-proxy location block alongside the existing `/api/` and `/actuator/` blocks). Updates the `redact-path-ids` OTTL block to target `url.path` (parallel to the `observability` capability fix).
- `observability-cluster` — modifies the slice 17/18b obs k3s collector ConfigMap requirement (the collector pipeline grows logs and metrics pipelines with exporters to the in-cluster loki and prometheus Services). Modifies the slice 17 prometheus chart values requirement to enable the `remote-write-receiver` feature gate so the obs collector's metrics pipeline has a destination. Updates the `redact-path-ids` OTTL block in this collector to target `url.path`.

## Impact

- **Affected files / directories:**
  - `frontend/Dockerfile` — three `ARG VITE_OTEL_*_ENDPOINT` default-value edits.
  - `frontend/src/observability/tracer.ts`, `errors.ts`, `meter.ts` — three `DEFAULT_ENDPOINT` constant edits.
  - `frontend/src/observability/{tracer,errors,meter}.test.ts` — test fixtures updated to assert the new relative-URL defaults.
  - `frontend/vite.config.ts` — new proxy entries `/v1/traces`, `/v1/logs`, `/v1/metrics` → `http://localhost:4318` for the dev loop.
  - `frontend/docker/nginx.conf` — new `location /v1/` block.
  - `infra/k8s/base/collector/configmap.yaml` — logs and metrics pipelines added; OTTL `redact-path-ids` block updated.
  - `infra/k8s-obs/base/collector/configmap.yaml` — logs and metrics pipelines added; OTTL `redact-path-ids` block updated.
  - `infra/observability/collector/collector-config.yaml` — CORS allowlist removed; OTTL `redact-path-ids` block updated.
  - `infra/k8s-obs/base/prometheus/values.yaml` — `enable-feature=remote-write-receiver` flag added.
  - `infra/k8s/overlays/hetzner/kustomization.yaml`, `infra/k8s-obs/overlays/hetzner/kustomization.yaml` — one-line comment each.
  - `README.md` — "Browser OTLP path" subsection.
  - Optionally `justfile` — a `frontend-otel-smoke` recipe that curls `/v1/traces` against the `frontend-forward`ed port to verify the proxy hop end-to-end.
- **New tool dependencies:** none.
- **Backwards-compatibility impact:** A developer with a pre-slice frontend dev loop pointed at the old absolute URLs will keep working until they `pnpm install` and rebuild — at which point relative URLs take over and the dev proxy handles routing. The frontend Docker image's defaults flip on the next `frontend-image` build; any in-flight pod with the old defaults stays functional only as long as the compose collector's CORS allowlist still accepts its origin (it won't, after this slice). The migration is "rebuild FE bundle + roll FE pod + recreate compose collector" — a single `just frontend-rebuild && docker compose --profile observability up -d --force-recreate collector` does it.
- **CI impact:** None. The e2e harness already uses the in-k3s-built bundle via `:13000` in the relevant matrices; the dev proxy covers the local dev case. No new CI job is added.
