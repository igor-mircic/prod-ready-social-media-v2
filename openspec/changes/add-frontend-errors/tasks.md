## 1. Frontend SDK dependencies

- [ ] 1.1 Add `@opentelemetry/api-logs`, `@opentelemetry/sdk-logs`, and `@opentelemetry/exporter-logs-otlp-http` to `frontend/package.json` and run `pnpm install` to refresh the lockfile
- [ ] 1.2 Verify the new packages are reachable via `pnpm why <pkg>` and no peer-dep warnings appear

## 2. Frontend error sink core

- [ ] 2.1 Create `frontend/src/observability/error-sink.ts` exporting `recordFrontendError(err, kind, ctx?)` with the fingerprint, dedup, rate-limit, PII-scrub, and three-sink (span event + log record + counter) responsibilities described in design.md Decisions 1, 3, 4
- [ ] 2.2 Implement the fingerprint extractor as a defensive `try/catch` around the first stackframe parse; fall back to `error.constructor.name` alone on parse failure (design Risk: browser stack format)
- [ ] 2.3 Implement the 5-second sliding-window dedup map keyed by fingerprint; expose the window via `VITE_FE_ERROR_DEDUP_WINDOW_MS`
- [ ] 2.4 Implement the 30-events-per-60-second hard rate cap; expose the cap via `VITE_FE_ERROR_RATE_LIMIT`
- [ ] 2.5 Implement SDK-side PII scrub helpers (`scrubMessage`, `scrubStack`) with the three regex patterns (JWT, email, bearer-token) from design Decision 4; export the regex set so tests can assert against the canonical list
- [ ] 2.6 Wire the three sinks: `trace.getActiveSpan()?.recordException`, OTel logger `emit` with ECS attributes, and counter `add` (unconditional)
- [ ] 2.7 Read `user.id` from the existing auth context shim when present; never read email or handle (design Decision 5)
- [ ] 2.8 Resolve `route` from React Router's matched template; fall back to `"unknown"` if no match
- [ ] 2.9 Add `frontend/src/observability/error-sink.test.ts` covering: fingerprint stability, dedup, rate cap, PII regex hits and misses (including the 40-char hex commit-SHA non-match), span-event skip when no active span

## 3. Frontend error handlers

- [ ] 3.1 Create `frontend/src/observability/error-handlers.ts` exporting `installFrontendErrorHandlers()` that registers `window.error`, `window.unhandledrejection`, and `window.securitypolicyviolation` listeners, each calling `recordFrontendError` with the correct `kind`
- [ ] 3.2 Add `error-handlers.test.ts` asserting each listener invokes the sink with the expected `kind` (jsdom + spy)

## 4. React error boundary

- [ ] 4.1 Create `frontend/src/observability/ErrorBoundary.tsx` exporting `<FrontendErrorBoundary>` class component implementing `componentDidCatch(err, info)` → `recordFrontendError(err, 'boundary', {componentStack: info.componentStack})`
- [ ] 4.2 Render a minimal fallback UI ("Something went wrong. Refresh to retry.") inside the boundary's error state; keep accessibility-friendly markup (heading + button)
- [ ] 4.3 Add `ErrorBoundary.test.tsx` proving the boundary catches a thrown child and calls the sink with `kind="boundary"`

## 5. Bootstrap wiring

- [ ] 5.1 Create `frontend/src/observability/errors.ts` exporting `bootstrapErrorReporting()` per spec — gated by `VITE_OTEL_ENABLED`, constructs `LoggerProvider` sharing the slice-6 `Resource`, registers `BatchLogRecordProcessor` with `OTLPLogExporter` to `${VITE_OTEL_LOGS_ENDPOINT || "http://localhost:4318/v1/logs"}`, then calls `installFrontendErrorHandlers()`
- [ ] 5.2 Call `bootstrapErrorReporting()` from `main.tsx` after `bootstrapTelemetry()` and `bootstrapMetrics()`, before `createRoot`
- [ ] 5.3 Wrap `<App />` in `<FrontendErrorBoundary>` inside `main.tsx`, below `<BrowserRouter>` so the boundary sees route context

## 6. Dev-only test trigger route

- [ ] 6.1 Add a `<ThrowOnMount />` component that throws an error whose message contains a JWT-shaped substring (for PII assertion coverage); register at `/__dev/throw` inside `App.tsx` ONLY when `import.meta.env.DEV` is truthy
- [ ] 6.2 Add a CI lint check (grep `frontend/dist/assets/*.js` for `__dev/throw` after `pnpm build` and fail if found); wire it into the existing FE build job

## 7. Collector logs pipeline

- [ ] 7.1 Extend `infra/observability/collector/collector-config.yaml`: add a `logs` pipeline using the existing `otlp` receiver, then processors `batch`, `filter/frontend_only`, `attributes/pii_scrub`, exporting via the existing `loki` exporter
- [ ] 7.2 Define `filter/frontend_only` to drop records where `resource.service.name != "frontend"`
- [ ] 7.3 Define `attributes/pii_scrub` to regex-redact JWT, email, and bearer-token patterns over `error.message`, `error.stack_trace`, and `body` with `[REDACTED]` replacement; keep the regex strings identical to the SDK-side patterns
- [ ] 7.4 Add a Collector config validation step to the local run loop (`docker compose --profile observability config -q`) and confirm the rendered config has the new pipeline

## 8. Loki + Grafana surface

- [ ] 8.1 Confirm Loki accepts the `event.dataset=frontend.error` stream as-is (no Loki config change expected); verify via `curl 'http://localhost:3100/loki/api/v1/labels'` after the first FE error fires
- [ ] 8.2 Edit `infra/observability/grafana/dashboards/frontend-overview.json` to add the Errors row with three panels (Error rate, Top fingerprints, CSP violations) per spec
- [ ] 8.3 Restart Grafana to pick up the dashboard JSON change (memory: `project_grafana_provisioning_restart.md`)
- [ ] 8.4 Visually verify all three panels render data after triggering a manual error via `/__dev/throw`

## 9. E2E spec

- [ ] 9.1 Create `e2e/tests/observability.frontend-errors.spec.ts` driving an authenticated session to `/__dev/throw`
- [ ] 9.2 Assert the Collector `/metrics` endpoint shows `frontend_errors_total{kind="boundary"} >= 1`
- [ ] 9.3 Assert the Loki API returns at least one log line under `{event_dataset="frontend.error"}` whose `error.type` matches the thrown class
- [ ] 9.4 Assert Tempo returns at least one trace with a `service.name=frontend` span carrying an `exception` event whose `exception.type` matches the thrown class
- [ ] 9.5 Assert PII redaction: the asserted log line and span event MUST contain `[REDACTED]` and MUST NOT contain the original JWT substring from the thrown error message
- [ ] 9.6 Add `test.skip(...)` guards on Collector, Loki, and Tempo endpoint reachability, mirroring slices 5 and 6
- [ ] 9.7 Confirm the spec passes locally under `pnpm e2e` with the observability profile up

## 10. Documentation

- [ ] 10.1 Add `### Frontend errors` subsection to the README under `## Local observability`, covering: four capture surfaces, `VITE_OTEL_ENABLED=true pnpm dev` run loop, dashboard URL, default dedup window + rate cap with override env-var names, explicit source-map deferral note
- [ ] 10.2 Cross-link the source-map deferral note to a tracking issue or follow-up reference so the reader knows where to look next

## 11. Validation

- [ ] 11.1 Run `openspec validate add-frontend-errors --strict` and resolve any reported issues
- [ ] 11.2 Run `pnpm typecheck` and `pnpm lint` in `frontend/` with no new errors
- [ ] 11.3 Run `pnpm test` in `frontend/` with all new unit tests passing
- [ ] 11.4 Trigger the e2e spec locally and confirm it passes against a running observability stack
- [ ] 11.5 Visually confirm the Errors row on the Grafana Frontend overview dashboard
