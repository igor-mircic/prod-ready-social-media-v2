## MODIFIED Requirements

### Requirement: Frontend bootstraps an OTel `WebTracerProvider` before React renders, gated by `VITE_OTEL_ENABLED`

The `frontend/` project SHALL pin the following packages in `frontend/package.json` as runtime dependencies: `@opentelemetry/sdk-trace-web`, `@opentelemetry/exporter-trace-otlp-http`, `@opentelemetry/context-zone`, `@opentelemetry/resources`, `@opentelemetry/semantic-conventions`, `@opentelemetry/instrumentation`, `@opentelemetry/instrumentation-fetch`, `@opentelemetry/instrumentation-document-load`, and `@opentelemetry/instrumentation-user-interaction`. Each coordinate SHALL be pinned with an explicit, non-`latest`, non-tilde-without-bound version range.

The frontend SHALL declare a module `frontend/src/observability/tracer.ts` exporting one function `bootstrapTelemetry(): void`. The function SHALL:

- return immediately as a no-op when `import.meta.env.VITE_OTEL_ENABLED` is not the string `"true"`;
- when enabled, construct a `Resource` carrying at minimum the attributes `service.name="frontend"` and `service.version=<value of import.meta.env.VITE_APP_VERSION>`;
- register a `WebTracerProvider` with that resource, a `ZoneContextManager`, a `BatchSpanProcessor`, and an `OTLPTraceExporter` whose URL defaults to `/v1/traces` (relative, resolved by the browser against `document.baseURI`) and is overridable via `import.meta.env.VITE_OTEL_TRACES_ENDPOINT`;
- register exactly three auto-instrumentations: `DocumentLoadInstrumentation`, `FetchInstrumentation`, and `UserInteractionInstrumentation`;
- write exactly one console line of the form `OTel telemetry enabled: traces → <endpoint>` when boot succeeds, so a reader can confirm activation from devtools.

The module `frontend/src/main.tsx` SHALL invoke `bootstrapTelemetry()` synchronously before `createRoot(...)` is called.

#### Scenario: SDK packages are pinned with explicit versions

- **WHEN** a reader inspects `frontend/package.json`
- **THEN** the `dependencies` block declares each of the nine listed `@opentelemetry/*` packages
- **AND** each coordinate's version range starts with a digit, a caret, or a tilde-with-bound (NOT `latest`, NOT `*`).

#### Scenario: Bootstrap is a no-op when the env var is unset

- **GIVEN** `import.meta.env.VITE_OTEL_ENABLED` is not the string `"true"`
- **WHEN** the frontend boots and `bootstrapTelemetry()` runs
- **THEN** no OTel `WebTracerProvider` is registered
- **AND** no console line of the form `OTel telemetry enabled:` is written
- **AND** no outbound POST to `/v1/traces` is made for the lifetime of the page.

#### Scenario: Bootstrap activates the provider when the env var is set

- **GIVEN** the frontend is built with `VITE_OTEL_ENABLED=true`
- **WHEN** the page first loads
- **THEN** the console carries exactly one line of the form `OTel telemetry enabled: traces → <endpoint>`
- **AND** a `WebTracerProvider` is registered globally (verifiable via `trace.getTracerProvider()`).

#### Scenario: Default endpoint is a same-origin relative URL

- **WHEN** a reader inspects the `DEFAULT_ENDPOINT` constant in `frontend/src/observability/tracer.ts`
- **THEN** the value is the string `/v1/traces`
- **AND** the value does NOT start with `http://` or `https://`.

#### Scenario: Default endpoint at bake time matches the source default

- **WHEN** a reader inspects the `VITE_OTEL_TRACES_ENDPOINT` `ARG` default in `frontend/Dockerfile`
- **THEN** the default value is `/v1/traces`
- **AND** the value does NOT start with `http://` or `https://`.

#### Scenario: Application source has no compile-time dependency on the OTel SDK outside the observability module

- **WHEN** a reader greps `frontend/src/` for `import .* from ['\"]@opentelemetry/`
- **THEN** every match's file path starts with `frontend/src/observability/`.

### Requirement: Frontend bootstraps an OTel `MeterProvider` before React renders, gated by `VITE_OTEL_ENABLED`

The frontend SHALL declare a module `frontend/src/observability/meter.ts` exporting one function `bootstrapMetrics(): void`. The function SHALL:

- return immediately as a no-op when `import.meta.env.VITE_OTEL_ENABLED` is not the string `"true"`;
- when enabled, register a `MeterProvider` whose `Resource` is the shared `Resource` instance exported by `frontend/src/observability/resource.ts` (carrying at minimum `service.name="frontend"` and `service.version`);
- register a `PeriodicExportingMetricReader` whose exporter is an `OTLPMetricExporter` whose URL defaults to `/v1/metrics` (relative, resolved by the browser against `document.baseURI`) and is overridable via `import.meta.env.VITE_OTEL_METRICS_ENDPOINT`;
- set the reader's export interval from `import.meta.env.VITE_OTEL_METRICS_EXPORT_INTERVAL_MS` if defined as a positive integer, otherwise default to `15000` (15 s, matching Prometheus's `scrape_interval`);
- write exactly one console line of the form `OTel telemetry enabled: metrics → <endpoint>` when boot succeeds.

The module `frontend/src/main.tsx` SHALL invoke `bootstrapMetrics()` synchronously after `bootstrapTelemetry()` and before `createRoot(...)`.

#### Scenario: Bootstrap is a no-op when the env var is unset

- **GIVEN** `import.meta.env.VITE_OTEL_ENABLED` is not the string `"true"`
- **WHEN** the frontend boots and `bootstrapMetrics()` runs
- **THEN** no OTel `MeterProvider` is registered
- **AND** no console line of the form `OTel telemetry enabled: metrics →` is written
- **AND** no outbound POST to `/v1/metrics` is made for the lifetime of the page.

#### Scenario: Bootstrap activates the meter provider when the env var is set

- **GIVEN** the frontend is built with `VITE_OTEL_ENABLED=true`
- **WHEN** the page first loads
- **THEN** the console carries exactly one line of the form `OTel telemetry enabled: metrics → <endpoint>`
- **AND** at least one POST to `<endpoint>` is observed within `2 * exportIntervalMillis` (i.e. within 30 s at the default).

#### Scenario: Default endpoint is a same-origin relative URL

- **WHEN** a reader inspects the `DEFAULT_ENDPOINT` constant in `frontend/src/observability/meter.ts`
- **THEN** the value is the string `/v1/metrics`
- **AND** the value does NOT start with `http://` or `https://`.

#### Scenario: Bootstrap runs after `bootstrapTelemetry()` and before `createRoot(...)`

- **WHEN** a reader inspects `frontend/src/main.tsx`
- **THEN** the call to `bootstrapTelemetry()` precedes the call to `bootstrapMetrics()`
- **AND** both calls precede the call to `createRoot(...)`.

### Requirement: Frontend bootstraps an OTel `LoggerProvider` before React renders, gated by `VITE_OTEL_ENABLED`

The frontend SHALL bootstrap an OTel `LoggerProvider` before `createRoot` is called in `main.tsx`, gated by the `VITE_OTEL_ENABLED` Vite environment variable.

When `VITE_OTEL_ENABLED` is `true`, the bootstrap SHALL construct
a `LoggerProvider` from `@opentelemetry/sdk-logs`, share the same
`Resource` instance as the slice-5 `tracer.ts` and slice-6
`meter.ts` (via the shared
`frontend/src/observability/resource.ts` module), and register
one `BatchLogRecordProcessor` exporting via `OTLPLogExporter`
from `@opentelemetry/exporter-logs-otlp-http` to
`/v1/logs` (relative, resolved by the browser against
`document.baseURI`) by default. When `VITE_OTEL_ENABLED` is unset
or `false`, the bootstrap SHALL be a no-op and SHALL NOT register
any provider, listener, or processor.

The default export endpoint MUST be overridable via
`VITE_OTEL_LOGS_ENDPOINT`. The bootstrap function MUST be named
`bootstrapErrorReporting()` and live in
`frontend/src/observability/errors.ts`.

#### Scenario: Logs provider initialised when telemetry is enabled

- **WHEN** `VITE_OTEL_ENABLED=true` and the app boots
- **THEN** `bootstrapErrorReporting()` constructs a
  `LoggerProvider`, registers a `BatchLogRecordProcessor` with an
  `OTLPLogExporter`, and completes before React mounts the root

#### Scenario: Logs provider remains uninitialised when telemetry is disabled

- **WHEN** `VITE_OTEL_ENABLED` is unset or `false` and the app boots
- **THEN** `bootstrapErrorReporting()` returns immediately without
  side effects and no global logger handler is registered

#### Scenario: Default endpoint is a same-origin relative URL

- **WHEN** a reader inspects the `DEFAULT_ENDPOINT` constant in `frontend/src/observability/errors.ts`
- **THEN** the value is the string `/v1/logs`
- **AND** the value does NOT start with `http://` or `https://`.

### Requirement: Collector redacts high-cardinality path segments from FE and BE spans

The file `infra/observability/collector/collector-config.yaml` SHALL declare a `transform` processor (`transform/redact-path-ids` or equivalent name) that, on every span passing through the `traces/default` pipeline, replaces matches of the following patterns inside span name, `http.url`, `http.target`, `url.full`, and `url.path` (where present) with the literal token `{id}`:

- UUID v4 (lowercase hex with hyphens): `[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`;
- opaque hex segments of length 8 or more (`[0-9a-f]{8,}`) when bounded by `/` or end-of-string;
- numeric segments of length 4 or more (`[0-9]{4,}`) when bounded by `/` or end-of-string.

The processor SHALL be wired into the `traces/default` pipeline before the Tempo exporter, after any receiver-side processors. The processor SHALL apply to spans from any `service.name` value (FE and BE both). The inclusion of `url.path` is REQUIRED — the modern OTel Java agent (slice-3 pin) emits HTTP path information primarily on `attributes["url.path"]`; older deprecated attributes (`http.url`, `http.target`, `url.full`) remain in the target list because some instrumentation libraries still emit them and the OTTL operation is idempotent on absent attributes.

#### Scenario: Collector pipeline lists the redaction processor before the Tempo exporter

- **WHEN** a reader inspects `infra/observability/collector/collector-config.yaml`
- **THEN** the file declares a `transform/redact-path-ids` processor (or equivalent name)
- **AND** the `service.pipelines.traces` (or `service.pipelines.traces/default`) `processors` list includes that processor
- **AND** the processor appears before any Tempo exporter in the same pipeline's `exporters` evaluation order.

#### Scenario: OTTL statements target `url.path` alongside the deprecated attributes

- **WHEN** a reader inspects the `transform/redact-path-ids` processor's `trace_statements` block
- **THEN** the statements target the attribute key `url.path` for every redaction pattern (UUID, opaque hex, numeric)
- **AND** the statements also target the keys `http.url`, `http.target`, and `url.full` (kept as defence-in-depth for legacy instrumentation)
- **AND** the statements also target `span.name`.

#### Scenario: UUID segment is redacted in a browser-emitted span

- **GIVEN** the frontend issues a fetch to `/api/v1/users/00000000-0000-0000-0000-000000000abc/follow`
- **WHEN** the resulting span is queried from Tempo
- **THEN** the span's `http.url` attribute does NOT contain the substring `00000000-0000-0000-0000-000000000abc`
- **AND** the span's `http.url` attribute contains the substring `{id}`.

#### Scenario: Numeric id segment is redacted in a backend-emitted span via `url.path`

- **GIVEN** the backend handles `GET /api/v1/users/123456`
- **AND** the resulting span carries `attributes["url.path"] = "/api/v1/users/123456"` (the attribute the modern Java agent emits)
- **WHEN** the span is queried from Tempo
- **THEN** the span's `url.path` attribute does NOT contain the substring `/123456`
- **AND** the span's `url.path` attribute contains the substring `/{id}`.

## ADDED Requirements

### Requirement: Vite dev server proxies browser OTLP same-origin to the compose collector

The file `frontend/vite.config.ts` SHALL declare proxy entries under both `server.proxy` and `preview.proxy` that map the three browser OTLP path prefixes to the compose collector's OTLP/HTTP receiver:

- `/v1/traces` → `http://localhost:4318` (preserving the path)
- `/v1/logs` → `http://localhost:4318`
- `/v1/metrics` → `http://localhost:4318`

These entries SHALL be declared alongside any existing `/api/` and `/actuator/` proxy entries. The dev loop (`pnpm dev` on `:5173`) and the preview loop (`pnpm preview` on `:4173`) SHALL both treat browser OTLP URLs as same-origin relative paths, matching the in-k3s nginx-served bundle's path layout from the `kubernetes` capability.

#### Scenario: server.proxy declares the three OTLP path entries

- **WHEN** a reader inspects the `server.proxy` block in `frontend/vite.config.ts`
- **THEN** the block declares an entry whose key matches `/v1/traces`
- **AND** the block declares an entry whose key matches `/v1/logs`
- **AND** the block declares an entry whose key matches `/v1/metrics`
- **AND** each entry's `target` is `http://localhost:4318`.

#### Scenario: preview.proxy declares the three OTLP path entries

- **WHEN** a reader inspects the `preview.proxy` block in `frontend/vite.config.ts`
- **THEN** the same three keys (`/v1/traces`, `/v1/logs`, `/v1/metrics`) are declared
- **AND** each entry's `target` is `http://localhost:4318`.

#### Scenario: Browser POSTs reach the compose collector through the dev proxy

- **GIVEN** the observability profile is running (compose collector on `:4318`)
- **AND** `pnpm dev` is running on `:5173` with `VITE_OTEL_ENABLED=true`
- **WHEN** a browser tab on `http://localhost:5173` triggers a UI action that produces telemetry
- **THEN** the resulting `POST /v1/traces` to `http://localhost:5173/v1/traces` succeeds with HTTP 2xx (or 4xx from the collector, NOT a 404 from vite)
- **AND** the request is observable in the compose collector's logs.

## REMOVED Requirements

### Requirement: OTel Collector OTLP/HTTP receiver allows CORS for Vite origins

**Reason:** With slice 18c routing all browser OTLP through same-origin paths (in-k3s via the frontend nginx `/v1/` proxy; in dev via the new vite dev/preview proxy entries), no browser dials the compose collector cross-origin. The CORS allowlist on `infra/observability/collector/collector-config.yaml` becomes dead config and is deleted alongside its narrative comments to prevent drift and to shrink slice 22's retirement surface.

**Migration:** None required by this slice — the change is removal of an unused inbound surface. The slice's frontend rebuild + collector recreate (in either order) makes the change effective. If a developer needs to dial the compose collector cross-origin temporarily (e.g. for an unusual debugging scenario), they can restore the CORS block locally; the project no longer guarantees that origin path.

### Requirement: Browser → Collector traffic goes direct; Vite proxy is NOT extended to `/v1/traces`

**Reason:** Reversed by slice 18c. The same-origin path is now the project's architectural stance: browser OTLP flows through nginx (in-k3s) or the vite dev/preview proxy (in dev) so the compose collector's CORS allowlist can be removed, the FE→BE trace propagation gap likely auto-resolves, and slice 22's compose retirement collapses one less inbound surface. Browser OTLP URLs are now relative `/v1/{traces,logs,metrics}` paths; the vite proxy makes those resolve same-origin in the dev loop.

**Migration:** None required. The new `Vite dev server proxies browser OTLP same-origin to the compose collector` requirement (above) replaces this requirement's stance with its opposite. Existing developer bundles continue to work until they rebuild; after rebuild, relative URLs and the new proxy take over.
