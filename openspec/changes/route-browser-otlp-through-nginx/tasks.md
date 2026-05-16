## 1. Preflight verifications (do these first so design assumptions hold)

- [ ] 1.1 Verify `@opentelemetry/exporter-{trace,logs,metrics}-otlp-http` `^0.218.0` accept a relative URL: grep the installed packages for the URL-handling path; confirm the `url` constructor option passes through to `fetch()` unchanged. If not, document the `window.location.origin` shim approach in `frontend/src/observability/{tracer,errors,meter}.ts` and adjust the spec scenarios accordingly.
- [ ] 1.2 Verify the obs-cluster loki Service exposes `/otlp/v1/logs` on port 3100 against the current chart values (`infra/k8s-obs/base/loki/values.yaml`): `kubectl --context social-obs -n observability port-forward svc/loki 3100:3100` then `curl -i -X POST http://localhost:3100/otlp/v1/logs -H 'Content-Type: application/json' --data '{}'` — expect 4xx (malformed body), NOT 404 (path unknown).
- [ ] 1.3 Verify the obs-cluster prometheus Service name and remote-write feature-gate flag for chart `prometheus-community/prometheus` 29.6.0: `helm show values prometheus-community/prometheus --version 29.6.0 | grep -A3 extraFlags` to confirm the values path and the flag name (`web.enable-remote-write-receiver` preferred).
- [ ] 1.4 Confirm the slice 16 `frontend/vite.config.ts` already declares `/api/` and `/actuator/` proxy entries under both `server.proxy` and `preview.proxy`; capture their shape so the new `/v1/*` entries match (target host:port, `changeOrigin`, `secure`, path rewriting if any).

## 2. Frontend bundle: relative URLs + vite dev/preview proxy

- [ ] 2.1 Update `frontend/src/observability/tracer.ts`: change `DEFAULT_ENDPOINT` from `'http://localhost:4318/v1/traces'` to `'/v1/traces'`.
- [ ] 2.2 Update `frontend/src/observability/errors.ts`: change `DEFAULT_ENDPOINT` from `'http://localhost:4318/v1/logs'` to `'/v1/logs'`.
- [ ] 2.3 Update `frontend/src/observability/meter.ts`: change `DEFAULT_ENDPOINT` from `'http://localhost:4318/v1/metrics'` to `'/v1/metrics'`.
- [ ] 2.4 Update `frontend/Dockerfile`: flip the three `ARG VITE_OTEL_*_ENDPOINT` default values from absolute compose-collector URLs to the matching relative paths from §§2.1–2.3.
- [ ] 2.5 Update `frontend/src/observability/tracer.test.ts` and the two sibling test files (`errors.test.ts`, `meter.test.ts`) so any fixture that asserts on the default endpoint asserts the new relative-URL values.
- [ ] 2.6 Add `/v1/traces`, `/v1/logs`, `/v1/metrics` proxy entries under both `server.proxy` and `preview.proxy` in `frontend/vite.config.ts`, each with `target: 'http://localhost:4318'` and `changeOrigin: true`. Mirror the shape of the existing `/api/` and `/actuator/` entries from §1.4.
- [ ] 2.7 Run `pnpm --filter frontend test` and confirm green; smoke-test `pnpm dev`: open `http://localhost:5173`, trigger a UI action, check devtools network tab — the `POST /v1/traces` should target `:5173` (same-origin) and proxy through to `:4318`, returning 2xx.

## 3. Compose collector: drop CORS, fix OTTL drift

- [ ] 3.1 Edit `infra/observability/collector/collector-config.yaml`: delete the entire `cors:` block under `receivers.otlp.protocols.http`. Delete the slice-7 / slice-16 narrative comments above the block that documented the allowlist entries. Add a one-line header comment: "The compose collector no longer receives browser OTLP directly — slice 18c moved browser OTLP same-origin through the in-k3s frontend nginx (`/v1/`) and vite dev proxy."
- [ ] 3.2 Edit the `transform/redact-path-ids` processor in the same file: add `attributes["url.path"]` as a target attribute to every OTTL `set(...)` or `replace_pattern(...)` statement that currently targets `attributes["http.url"]`, `attributes["http.target"]`, or `attributes["url.full"]`. Keep the existing attributes in the target list (additive change).
- [ ] 3.3 Recreate the compose collector: `docker compose --profile observability up -d --force-recreate collector`. Confirm `docker compose logs collector --tail 30` shows clean startup with no OTTL parse errors.

## 4. App k3s collector: logs + metrics pipelines, OTTL drift fix

- [ ] 4.1 Edit `infra/k8s/base/collector/configmap.yaml`: add the `filter/frontend_only` processor under `processors:` (drops log records whose `resource.attributes["service.name"] != "frontend"`).
- [ ] 4.2 Edit the `transform/redact-path-ids` processor: add `attributes["url.path"]` as a target attribute to every OTTL statement (same additive change as §3.2).
- [ ] 4.3 Add the four new exporters under `exporters:` — `otlphttp/compose-relay-logs` and `otlphttp/obs-cluster-logs` targeting `http://host.lima.internal:4318` and `http://host.lima.internal:14318` respectively; `otlphttp/compose-relay-metrics` and `otlphttp/obs-cluster-metrics` targeting the same hosts on the same ports. Set `tls.insecure: true` on each.
- [ ] 4.4 Add the `logs` pipeline under `service.pipelines:` — `receivers: [otlp]`, `processors: [batch, transform/redact-path-ids, filter/frontend_only]`, `exporters: [otlphttp/compose-relay-logs, otlphttp/obs-cluster-logs]`.
- [ ] 4.5 Add the `metrics` pipeline under `service.pipelines:` — `receivers: [otlp]`, `processors: [batch]`, `exporters: [otlphttp/compose-relay-metrics, otlphttp/obs-cluster-metrics]`.
- [ ] 4.6 Roll the app k3s collector: `kubectl apply -k infra/k8s/overlays/local && just collector-rollout`. Confirm `just collector-logs` shows clean startup with three pipelines registered.

## 5. Obs k3s collector: logs + metrics pipelines, OTTL drift fix

- [ ] 5.1 Edit `infra/k8s-obs/base/collector/configmap.yaml`: update the `transform/redact-path-ids` processor's OTTL statements to add `attributes["url.path"]` (same additive change as §3.2 / §4.2).
- [ ] 5.2 Add the two new exporters under `exporters:` — `otlphttp/loki` targeting `http://loki.observability.svc.cluster.local:3100/otlp` with `tls.insecure: true`; `prometheusremotewrite/in-cluster` targeting `http://prometheus-server.observability.svc.cluster.local/api/v1/write` with `tls.insecure: true`.
- [ ] 5.3 Add the `logs` pipeline under `service.pipelines:` — `receivers: [otlp]`, `processors: [batch, transform/redact-path-ids]`, `exporters: [otlphttp/loki]`.
- [ ] 5.4 Add the `metrics` pipeline under `service.pipelines:` — `receivers: [otlp]`, `processors: [batch]`, `exporters: [prometheusremotewrite/in-cluster]`.
- [ ] 5.5 Roll the obs k3s collector: `kubectl --context social-obs apply -k infra/k8s-obs/overlays/local && just obs-collector-rollout`. Confirm `just obs-collector-logs` shows clean startup with three pipelines registered.

## 6. Obs prometheus: enable remote-write receiver

- [ ] 6.1 Edit `infra/k8s-obs/base/prometheus/values.yaml`: add `server.extraFlags: [web.enable-remote-write-receiver]` (or append to an existing list if one is present from §1.3 inspection).
- [ ] 6.2 Re-render and apply: `kubectl --context social-obs apply -k infra/k8s-obs/overlays/local`. Restart the prometheus deployment: `kubectl --context social-obs rollout restart deploy/prometheus-server -n observability` (chart-default Service name; verify against §1.3 output).
- [ ] 6.3 Smoke-test the remote-write endpoint: port-forward `prometheus-server` and issue a `POST /api/v1/write` with a minimal snappy-framed sample; expect HTTP 204.

## 7. Frontend nginx: in-cluster `/v1/` proxy

- [ ] 7.1 Edit `frontend/docker/nginx.conf`: add a `location /v1/` block that `proxy_pass`es to `http://collector.social.svc.cluster.local:4318`, mirroring the shape of the existing `/api/` and `/actuator/` blocks (Host header forwarding, no CORS headers).
- [ ] 7.2 Rebuild and roll the frontend pod: `just frontend-rebuild`. Confirm rollout completes via `kubectl rollout status deploy/frontend -n social`.

## 8. Hetzner overlay stubs

- [ ] 8.1 Append a one-line comment to `infra/k8s/overlays/hetzner/kustomization.yaml`: "slice 18c added logs+metrics dual-write to the app collector — production-side targets are the obs box's private-network IP, terminated with mTLS in slice 19."
- [ ] 8.2 Append a one-line comment to `infra/k8s-obs/overlays/hetzner/kustomization.yaml`: "slice 18c added logs and metrics pipelines targeting in-cluster loki and prometheus — production-side adds mTLS termination on the OTLP receiver in slice 19; storage / retention tuning lands in the Hetzner deploy slice."

## 9. README

- [ ] 9.1 Add a "Browser OTLP path" subsection under "Local observability" in `README.md` describing the new shape — browser → frontend pod (nginx) | vite dev server (proxy) → app collector → {compose, obs-cluster}; note that no CORS allowlist exists anywhere; capture the implication that local dev with `pnpm dev` requires the compose collector profile up so the vite proxy has a target.

## 10. FE→BE trace propagation gap investigation (bounded; document outcome regardless)

- [ ] 10.1 Reproduce the gap pre-slice: with the current main branch, open the bundled SPA, trigger a UI action that fires a backend fetch, inspect Tempo for the resulting trace, confirm browser-emitted and backend-emitted spans appear under separate `trace.id` values.
- [ ] 10.2 With this slice's changes applied (same-origin via nginx + vite proxy), re-run the same UI action. Check whether the `traceparent` header now appears on the outgoing fetch (Playwright `request.headers()` or devtools network tab).
- [ ] 10.3 If propagation now works: add a regression scenario to `openspec/changes/route-browser-otlp-through-nginx/specs/observability/spec.md` under the existing slice-5 "Outbound browser fetch requests to the backend carry a W3C `traceparent` header" requirement, asserting that browser→backend trace continuity holds. Re-run `openspec validate route-browser-otlp-through-nginx --strict`.
- [ ] 10.4 If propagation still fails: inspect the `FetchInstrumentation` registration in `frontend/src/observability/tracer.ts`; check `propagateTraceHeaderCorsUrls` config; if the fix is a single allowlist entry, apply it within this slice and document the change in design.md's Decision 8. If the fix sprawls beyond a single allowlist entry, document findings in design.md, capture a new memory (`project_fe_be_trace_propagation_findings.md`) or follow-up slice proposal, and ship 18c without the fix.

## 11. End-to-end verification (side-by-side compose grafana + obs grafana)

- [ ] 11.1 Bring up everything: `docker compose --profile observability up -d && just vm-up && just obs-up && just backend-apply && just frontend-rebuild`.
- [ ] 11.2 Trigger a representative UI action that produces all three signal types (a logged-in `POST /api/v1/posts` covers traces; an FE error via `/__dev/throw` covers logs; a page load with web-vitals covers metrics).
- [ ] 11.3 Open compose grafana (`http://localhost:3000`) and obs grafana (`just obs-grafana`) side by side. Confirm:
  - Same trace appears in both Tempo datasources.
  - Same FE error log appears in both Loki instances under `event.dataset=frontend.error`.
  - Same `web_vitals_*_bucket` metric appears in both Prometheus instances within `30s + scrape_interval` of the page load.
- [ ] 11.4 Verify the compose collector no longer accepts cross-origin POSTs from any FE-port (preflight to `http://localhost:4318/v1/traces` with `Origin: http://localhost:5173` should fail or carry no `Access-Control-Allow-Origin` header).

## 12. Optional polish

- [ ] 12.1 (Optional) Add a `just frontend-otel-smoke` recipe that curls a minimal valid OTLP/HTTP traces POST against the `frontend-forward`ed port `:13000/v1/traces` and asserts HTTP 2xx. Decide during implementation whether the recipe's marginal day-to-day value justifies the line in `just --list`.

## 13. Validation, branch, commit, PR (per project workflow)

- [ ] 13.1 `openspec validate route-browser-otlp-through-nginx --strict` — confirm pass.
- [ ] 13.2 Run frontend lint + typecheck + tests; run any backend tests touched by indirect collector-config changes (none expected).
- [ ] 13.3 Open a PR titled `Implement route-browser-otlp-through-nginx (slice 18c)` against `main`; description summarises the three signal types' new same-origin path, the bundled OTTL fix, and the FE→BE propagation findings from §10.
- [ ] 13.4 After CI passes and reviewer approves, archive the change: `openspec archive route-browser-otlp-through-nginx`. Update memories that reference the now-fixed items (`project_redact_path_ids_attr_drift.md` → close out; `project_browser_otlp_cross_origin.md` → close out; `project_fe_be_trace_propagation_gap.md` → close out or update with findings from §10.4).
