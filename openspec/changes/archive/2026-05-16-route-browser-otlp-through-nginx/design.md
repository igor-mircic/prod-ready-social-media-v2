## Context

After slice 18b, app-side telemetry has the following shape:

```
   browser ──cross-origin OTLP──▶ compose collector ──▶ {tempo, loki, prom (RUM)}
                                                            │
                                                            └─▶ (FE-only, no fan-out)

   backend pod ──in-cluster─▶ app k3s collector ──┬──▶ compose collector (relay)
                                                  └──▶ obs k3s collector ──▶ obs tempo
```

The browser is the last "telemetry source on the app cluster" that does not flow through the in-cluster collector. The shape after this slice:

```
   browser ──▶ frontend pod (nginx)        ──▶ app k3s collector ──┬──▶ compose
              | vite dev server (proxy)        (traces, logs,      │
                                                metrics pipelines) └──▶ obs k3s collector
                                                                       (traces, logs,
                                                                        metrics pipelines)
                                                                              │
                                                                              ▼
                                                                       {tempo, loki, prom}
```

Three downstream payoffs frame the slice:

1. **Single origin.** The compose collector's `cors.allowed_origins` block (`:5173`, `:4173`, `:13000`) becomes dead config and is deleted. No FE-ingress path remains on the compose collector; slice 22's "retire compose" deletes a smaller surface.
2. **Slice-18 trilogy closes.** Every signal on the app cluster reaches the obs cluster via the same in-cluster collector. The dual-write fan-out is symmetric across traces, logs, and metrics; slices 20 and 21 add infrastructure-side data (pod stdout, BE pod metrics scrape) on top of an already-symmetric transport.
3. **Likely FE→BE trace-propagation auto-fix.** `@opentelemetry/instrumentation-fetch` strips `traceparent` from cross-origin fetches by default (the spec calls this "cross-origin URLs in `propagateTraceHeaderCorsUrls`"). Once the browser is served from the same origin as the BE proxy (in-k3s via nginx, or in dev via vite proxy), the strip stops.

Two bundled hardening items piggyback because they touch the same files:

- The **OTTL `redact-path-ids` attribute-name drift**: every collector config (compose, app k3s, obs k3s) redacts `http.url`/`http.target`/`url.full`, but the modern Java agent emits `url.path`. Backend path-ID redaction has been a silent no-op since slice 5. Three sites need the same fix.
- The **compose CORS allowlist** becomes dead config the moment the FE bundle stops dialing it. Removing it kills a drift vector (slice 17's "build the new house before tearing down the old" doctrine cuts both ways — leftover scaffolding rots silently).

## Goals / Non-Goals

**Goals:**

- All three browser OTLP signals (traces, logs, metrics) flow same-origin through nginx (in-k3s) or the vite dev proxy (in dev).
- App k3s collector fans out all three signals to both the compose collector and the obs k3s collector, mirroring slice 18b's dual-write shape for traces.
- Obs k3s collector ingests all three signals and writes them to in-cluster loki (logs) and in-cluster prometheus (metrics), in addition to the slice-18b tempo destination for traces.
- The compose CORS allowlist is removed; the compose collector no longer accepts any cross-origin browser POST.
- The OTTL `redact-path-ids` attribute-name drift is fixed at all three sites.
- The FE→BE trace-propagation gap is either auto-fixed by same-origin, surgically fixed via a `propagateTraceHeaderCorsUrls` config tweak, or has its findings documented and the gap closure deferred to a follow-up slice — never silently dropped.

**Non-Goals:**

- mTLS or any auth on the cross-cluster OTLP hop (slice 19).
- Retirement of the compose collector (slice 22).
- Pod-stdout log shipping via filelog DaemonSet (slice 20).
- Prometheus scraping BE pod `/actuator/prometheus` (slice 21).
- Retention, aggregation, or chart-values tuning on obs loki / prometheus beyond what's needed to accept the new writes (one prometheus feature-gate flip; loki accepts OTLP at chart defaults).
- FE bundle reshape beyond the three endpoint defaults and the vite proxy entries (no SDK upgrade, no resource attribute change, no instrumentation list change).
- New CI smoke job exercising the cross-cluster browser path.
- Touching the slice 16 `/api/` or `/actuator/` proxy blocks beyond adding a `/v1/` sibling.

## Decisions

### Decision 1: Browser OTLP exporters take relative URLs; no `window.location.origin` prefix shim

The three browser OTLP exporters (`OTLPTraceExporter`, `OTLPLogExporter`, `OTLPMetricExporter` from `@opentelemetry/exporter-{trace,logs,metrics}-otlp-http` `^0.218.0`) all forward their `url` constructor option into the browser `fetch()` API. `fetch()` natively resolves relative URLs against `document.baseURI`, so passing `/v1/traces` works without any SDK-side shim.

**Alternatives considered:**

- **Bake an absolute URL with `window.location.origin` prefix at module load.** Works but redundant — `fetch()` does the same resolution one layer down. Adds a line of code that fails opaquely if `window` isn't defined (SSR / test environments — though the current bootstrap is already browser-only, the change would couple two unrelated concerns).
- **Use `OTEL_EXPORTER_OTLP_ENDPOINT` env-var resolution baked into the SDK.** The browser SDK's env-var path is `import.meta.env.VITE_OTEL_*` — same surface we already use.

**Why decided:** Relative URL is the minimum viable change. Verified at design time: the exporters in `frontend/src/observability/{tracer,errors,meter}.ts` pass `{ url: endpoint }` to constructors that internally call `fetch(this.url, { method: 'POST', body, headers })` — no URL normalization step that would reject a path-only string.

### Decision 2: Obs collector logs exporter uses `otlphttp` against Loki's native OTLP endpoint, not the legacy `loki` exporter

Loki 3.6+ (the slice-17 chart pinned loki 3.6.7) ships a native OTLP ingest endpoint at `/otlp/v1/logs` on the standard loki HTTP service (port 3100). The OTel Collector ships two exporters that can target loki:

- `loki` exporter — pushes via Loki's classic push API (`/loki/api/v1/push`), maps OTel attributes to Loki labels per the exporter's mapping rules.
- `otlphttp` exporter — pushes OTLP/HTTP to any endpoint; Loki 3.x's native OTLP ingest accepts this directly and applies its own attribute-to-label mapping (which is now Loki's responsibility, not the exporter's).

**Why `otlphttp`:** Loki's native OTLP path is the forward-compatible direction; the `loki` exporter is in maintenance mode upstream and slated for removal. Putting attribute-to-label mapping on Loki's side (one place) instead of the collector's side (potentially many collectors, all having to agree on the mapping) is also the project's strict-pairing posture from slice 16 transposed to telemetry. The slice 17 loki chart has `auth_enabled: false` and exposes the HTTP API on a stable Service, so the exporter config is `endpoint: http://loki.observability.svc.cluster.local:3100/otlp` with `tls.insecure: true` (no TLS required for in-cluster traffic).

### Decision 3: Enable the prometheus remote-write receiver via `server.extraFlags`

The slice 17 prometheus chart (`prometheus-community/prometheus` 29.6.0) does NOT enable the remote-write receiver by default. The chart exposes a `server.extraFlags` list (Helm renders these as `--<flag>` arguments to the prometheus container). The change is a one-entry append: `extraFlags: [web.enable-remote-write-receiver]` (note: `web.enable-remote-write-receiver` is the modern flag name; `enable-feature=remote-write-receiver` was the pre-v2.33 feature-gate form and is what older docs reference — both work on the slice-17 pinned v3.11.3, but the explicit web flag is clearer).

The receiver lights up at `POST /api/v1/write` on the existing prometheus Service. The obs collector's `prometheusremotewrite` exporter then targets `http://prometheus-server.observability.svc.cluster.local/api/v1/write` (chart-default Service name; `prometheus-server` not `prometheus`).

**Alternatives considered:**

- **Use the OTLP/HTTP metrics path that prometheus 2.47+ also accepts.** Tempting (symmetric with the loki decision). Rejected for now: the chart doesn't enable it by default, the OTLP path's interaction with prometheus's label-set model is less mature than remote-write, and remote-write is the well-trodden path for "collector pushing metrics into prometheus" cases. Worth revisiting in slice 21 alongside the BE scrape work.
- **Run a separate `mimir` or `cortex` in front of prometheus for remote-write.** Overkill at the slice's scope.

### Decision 4: App k3s collector logs pipeline runs the `filter/frontend_only` defence-in-depth filter; metrics pipeline does not

The compose collector's slice-7 logs pipeline includes a `filter/frontend_only` processor that drops any log record whose `resource.service.name != "frontend"`. The reason was defence in depth: if a future BE-via-OTLP migration accidentally routed BE logs through this pipeline, the FE-shaped PII regex passes (slice-7) would scrub them, producing silently wrong data.

That reasoning carries forward: the app k3s collector's new logs pipeline today only sees FE OTLP (BE pod logs land in slice 20 via filelog → a different pipeline). Including `filter/frontend_only` now is cheap and prevents the same accidental-cross-pollination in any future slice that adds a logs receiver.

Metrics has no analogue — there's no PII concern with web-vitals histograms and no FE-specific processing chain to protect, so the metrics pipeline runs `[batch]` only.

### Decision 5: Dual-write applies to logs and metrics symmetrically with traces

Slice 18b dual-writes traces to BOTH the compose collector (`otlp/compose-relay`) AND the obs collector (`otlp/obs-cluster`). The same shape applies to the new logs and metrics pipelines:

- Logs: `[otlphttp/compose-relay-logs, otlphttp/obs-cluster-logs]`
- Metrics: `[otlphttp/compose-relay-metrics, otlphttp/obs-cluster-metrics]`

**Why:** The whole point of dual-write is operator confidence — open compose grafana and obs grafana side-by-side, confirm identical data. If we dual-write traces but not logs/metrics, the parity-check stops working for two of three signals and slice 22 loses its load-bearing safety net.

The compose collector keeps its existing logs and metrics pipelines unchanged. The new app k3s collector exporters target the compose collector's existing OTLP/HTTP receiver on `host.lima.internal:4318` — same hop as slice-18b's `otlp/compose-relay` exporter for traces, just for two new signal types. The compose collector does NOT need any new pipeline configuration to accept these — OTLP receivers ingest all three signal types into whatever pipelines reference them, and the existing compose pipelines for logs and metrics already exist (slices 4 and 6).

### Decision 6: Vite dev proxy added; CORS allowlist removed entirely (not "kept but for dev only")

A dev developer running `pnpm dev` on `:5173` and dialing OTLP relative URLs needs a proxy from `/v1/*` → `http://localhost:4318/v1/*` (compose collector). Without it, the browser's relative URL resolves to `http://localhost:5173/v1/traces` and gets a 404 from the vite dev server.

The proxy lands in `frontend/vite.config.ts` alongside the existing `/api/` and `/actuator/` proxy entries (verify they exist at implementation time; if not, the pattern is established in the slice 16 nginx config and is straightforward to mirror in vite's `server.proxy`).

**Why the CORS allowlist disappears entirely:** With the vite proxy in place, no browser dials the compose collector cross-origin from any path — `:5173`, `:4173`, and `:13000` all go same-origin. The allowlist is dead config. The slice-16 narrative comment that documented the slice 16 entry (`:13000`) is the last living explanation; removing the block alongside the comment is cleanest.

The alternative — "keep the allowlist as dead config but document it as obsolete" — accumulates rot exactly the way slice-17 design.md's "build the new house before tearing down the old one" anti-pattern warns about. Once the receiver no longer needs CORS, removing it is the slice-22 retirement-precondition we'd otherwise have to do later.

### Decision 7: OTTL drift fix applies `url.path` IN ADDITION TO the stale attributes (additive, not replacement)

The stale attribute names (`http.url`, `http.target`, `url.full`) are deprecated in the latest HTTP semantic conventions but are still emitted by SOME instrumentation libraries (older agents, FE fetch instrumentation in certain configurations). Removing them risks regressing a redaction path we don't currently exercise. Adding `url.path` to the same OTTL targets list is purely additive.

The new attribute list per OTTL `transform` statement:

- `span.name`
- `attributes["http.url"]`
- `attributes["http.target"]`
- `attributes["url.full"]`
- `attributes["url.path"]` (NEW)

Apply at all three sites; spec scenarios test the post-fix path-id redaction on `url.path` as the primary verification, since that's the attribute the modern Java agent actually emits.

### Decision 8: FE→BE trace propagation investigation is scoped to "look, fix if surgical, document if not"

The slice-16 memory (`project_fe_be_trace_propagation_gap.md`) observes that browser clicks and backend spans appear as separate traces (no `traceparent` propagation). The leading hypothesis is that `@opentelemetry/instrumentation-fetch`'s `propagateTraceHeaderCorsUrls` defaults to "no cross-origin propagation" and the FE-on-`:13000` dialing BE-on-`:18080` (via `frontend-forward`) crosses an origin even though the proxy hop makes it appear same-origin to the SDK's URL-comparison logic.

The investigation task is bounded:

1. Verify the hypothesis by inspecting the fetch instrumentation config in `frontend/src/observability/tracer.ts` and the actual URLs the browser requests.
2. If same-origin (post-slice-18c) auto-resolves it, document the resolution and add a regression scenario.
3. If a `propagateTraceHeaderCorsUrls` allowlist (or per-environment override) is needed, add it as a surgical fix within this slice.
4. If the root cause turns out to be deeper (e.g. `instrumentation-document-load` not injecting context into subsequent fetches, or the `ZoneContextManager` losing context across rrweb event loop boundaries), document the findings, capture a new memory or follow-up slice proposal, and ship 18c without the fix.

The slice's success criteria do NOT depend on closing the gap; they only depend on (a) the routing change landing cleanly and (b) the investigation being documented.

**Implementation findings (slice 18c):**

The investigation surfaced four observations:

1. **Browser fetches are now same-origin in every flow.** Slice 18c routes every browser→backend fetch through the same origin: in-k3s the browser is on `:13000` and `/api/v1/*` is reverse-proxied by the FE pod's nginx to `backend.social.svc.cluster.local:8080`; in dev the browser is on `:5173` and `/api/v1/*` is reverse-proxied by `vite.config.ts` to `localhost:8080`. From the browser's perspective the fetch URL is relative and resolves to the page origin in both cases. `instrumentation-fetch@0.218.0` automatically propagates W3C `traceparent` on same-origin fetches without needing any `propagateTraceHeaderCorsUrls` allowlist entry.
2. **The existing `propagateTraceHeaderCorsUrls` config is still correct, just no longer load-bearing.** `frontend/src/observability/tracer.ts` builds `[/^http:\/\/localhost:8080(\/.*)?$/]` plus an optional regex derived from `VITE_API_BASE_URL`. After 18c the same-origin path is the primary flow; the allowlist only matters for the edge case of a dev developer dialing `http://localhost:8080/api/v1/...` directly (no proxy), which still works.
3. **The existing e2e test `e2e/tests/observability.frontend-traces.spec.ts` already verifies trace continuity end-to-end.** It captures `traceparent` from the browser's `POST /api/v1/posts`, polls Tempo for the trace under that trace id, asserts both `service.name=frontend` and `service.name=backend` spans appear, and confirms the BE access-log line in Loki carries the same `trace.id`. The test runs `vite dev` on `:5173` with `VITE_OTEL_ENABLED=true`. With slice 18c the same-origin routing means the test's surrounding narrative comment about the compose collector's CORS allowlist is obsolete, but the assertions themselves remain valid and the test still expresses the right invariant.
4. **The slice-16 user-observed gap was NOT independently reproduced inside this slice.** The original gap memory (`project_fe_be_trace_propagation_gap.md`) recorded a manual observation that browser clicks and backend spans appeared as separate traces on the in-k3s :13000 path. The most likely root cause was the cross-origin barrier (the browser was on `:13000` and the click span lived in Zone context that did not survive to the fetch handler, OR the fetch went through a cross-origin hop that stripped `traceparent`). Slice 18c removes the cross-origin barrier; if the underlying gap was the cross-origin strip, it is closed by transport. If the gap was deeper (ZoneContextManager losing context across React event boundaries, e.g.), this slice does NOT fix it.

**Closure path (deferred verification):** The slice ships per Decision 8 path #4 — findings documented, fix not asserted. The verification is a single browser session on the in-k3s :13000 path: log in, trigger a UI action that fires a backend fetch, inspect devtools network tab for the `traceparent` header on the outbound request, then query Tempo for the resulting trace and confirm `service.name=frontend` AND `service.name=backend` spans share one trace id. The follow-up memory captures this open verification and the predicted outcome.

## Risks / Trade-offs

- **[Browser OTLP latency from one extra hop]** Each browser OTLP POST now traverses an additional reverse-proxy hop (nginx in-k3s or vite proxy in dev) before reaching the collector. → On a developer laptop the extra hop is sub-millisecond. The mitigation is "ignore" — this is the cost of the architectural simplification.
- **[Loki OTLP native ingest is younger than the classic push path]** Choosing `otlphttp` against `/otlp/v1/logs` over the `loki` exporter bets on Loki 3.x's native OTLP being stable. → Loki 3.x has shipped OTLP ingest as GA since 3.4 (2024); we're on 3.6.7. If Loki's OTLP-side attribute-to-label mapping turns out to be inconvenient (cardinality blow-up, wrong label set), the fix is a chart-values tweak in the obs cluster (`limits_config.otlp_config` lets you set the structured-attributes-to-label map). Not a slice-blocker; capture findings as a tasks.md item if grafana log queries look wrong.
- **[Prometheus remote-write metric naming conflicts]** The obs collector's `prometheusremotewrite` exporter renames OTel metric names per the OTel→Prom spec (e.g. dots become underscores, units suffixed). If the FE web-vitals histograms were already being scraped by compose prometheus under one name and arrive in obs prometheus under another, dashboard queries break. → Compose prometheus today scrapes the compose collector's `prometheus` exporter, which applies the same mapping rules. The names should match. Verify post-implementation by side-by-siding metric names between the two prometheus instances; if they drift, the obs collector's `prometheusremotewrite` exporter has `resource_to_telemetry_conversion` and naming knobs.
- **[Compose grafana stops showing FE data if the dual-write loses the compose relay]** Slice 22's purpose is exactly this cutover, but during the transition (until slice 22 lands), losing the compose-relay exporter from any of the three pipelines would silently drop compose-side visibility for that signal. → Dual-write fan-out is a single config block per pipeline; the spec scenario asserts both exporters are present and the implementation review verifies the same. The retire-compose slice (22) is the explicit moment we collapse it, with a check that obs has equivalent data.
- **[OTel collector OTLP receiver max payload]** Default OTLP/HTTP receiver `max_recv_msg_size_mib` is 32 MiB; high-volume browser sessions (with rrweb-style logs, not present today) could exceed it. → Web-vitals + click-derived traces + the four error surfaces produce small payloads; nowhere near 32 MiB. Flag if rrweb or session replay lands in a later slice.
- **[Vite proxy doesn't cover preview mode beyond what's added]** `vite preview` on `:4173` uses `preview.proxy`, which is a separate config block from `server.proxy`. → Add the `/v1/*` entries to BOTH `server.proxy` AND `preview.proxy` for symmetry, mirroring the existing `/api/` and `/actuator/` entries' shape.
- **[OTTL drift fix is application-level invisible]** Adding `url.path` to redaction doesn't break anything; it just starts working where it was a silent no-op. → A spec scenario verifies the post-fix redaction on `url.path`; once it lands, regressions are caught.

## Migration Plan

1. Rebuild and roll out the FE pod: `just frontend-rebuild`. The new bundle ships with relative URL defaults baked in.
2. Roll the app k3s collector: `kubectl apply -k infra/k8s/overlays/local && just collector-rollout`. The new logs and metrics pipelines pick up traffic as soon as the FE bundle starts POSTing.
3. Roll the obs k3s collector: `kubectl --context social-obs apply -k infra/k8s-obs/overlays/local && just obs-collector-rollout`. The new pipelines ingest from the app collector's dual-write.
4. Roll prometheus in the obs cluster: `kubectl --context social-obs rollout restart deploy/prometheus-server -n observability` (or chart-equivalent). The remote-write receiver lights up.
5. Recreate the compose collector to pick up the new config (CORS removal, OTTL drift fix): `docker compose --profile observability up -d --force-recreate collector`.
6. Verify in compose grafana and obs grafana side by side: triggering a `POST /api/v1/posts` from the browser should produce identical trace, log, and metric data in both grafanas.

**Rollback**: revert the FE bundle (`just frontend-rebuild` from the previous commit), and re-apply the previous collector ConfigMaps. The compose CORS allowlist would need to be re-added if the FE rollback predates the cors block's removal commit — but during the transition window dual-write keeps both paths alive, so the rollback window is forgiving.

## Open Questions

1. **Verified at design time, but worth re-checking at implementation:** Do the `@opentelemetry/exporter-{trace,logs,metrics}-otlp-http` `^0.218.0` packages truly tolerate relative URLs? The fetch path suggests yes; implementation should grep for any URL-normalisation step in node_modules and confirm.
2. **Loki OTLP attribute-to-label mapping defaults:** the slice-17 chart values don't customize `limits_config.otlp_config`. Whether the chart defaults produce a sensible label set (or a cardinality bomb) for our FE log records is unknown until traffic flows. Capture in a tasks.md sanity-check step.
3. **The FE→BE trace propagation gap's root cause:** see Decision 8. Outcome is captured in tasks.md whichever way it falls.
4. **Whether to add an optional `just frontend-otel-smoke` recipe** that POSTs a synthetic OTLP payload to `http://localhost:13000/v1/traces` and asserts a 200 response. It's the cheapest possible cross-stack verification but adds a recipe of marginal day-to-day value. Decide during implementation.
