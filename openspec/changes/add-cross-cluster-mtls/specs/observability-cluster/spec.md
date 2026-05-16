## ADDED Requirements

### Requirement: A self-signed CA + leaf certs back the cross-cluster mTLS

The repository SHALL contain `infra/observability/certs/` as the canonical home for the cross-cluster trust anchor. The directory SHALL contain:

- `ca.crt` — the self-signed CA certificate (PEM). Public material; SHALL be committed.
- `ca.key` — the self-signed CA private key. SHALL NOT be committed; SHALL be excluded by `infra/observability/certs/.gitignore` (or the repo-root `.gitignore`) and SHALL be regeneratable by the `just obs-certs` recipe.
- `openssl.cnf` — the openssl configuration the cert-gen recipe consumes (CA subject, validity, leaf cert SAN extensions). SHALL be committed so cert generation is reproducible.
- `.gitignore` — at minimum excludes `*.key`.

The CA SHALL be the single trust anchor for both the app collector (client) and the obs collector (server). Both per-cluster cert directories (`infra/k8s/base/collector/certs/` and `infra/k8s-obs/base/collector/certs/`) SHALL contain a copy of `ca.crt` so each side can verify the other's leaf certificate.

The CA SHALL have at least 10-year validity. Leaf certs (server cert in the obs cluster, client cert in the app cluster) SHALL have at least 1-year validity. Rotation is manual via the recipe.

The CA private key on disk is acceptable for the local mirror; the Hetzner overlay stubs SHALL name "CA private key not on disk in production" as a slice-23 concern (cert-manager-managed via a self-signed `ClusterIssuer`).

#### Scenario: Trust anchor files live in `infra/observability/certs/`

- **WHEN** a reader lists `infra/observability/certs/`
- **THEN** the directory contains `ca.crt`, `openssl.cnf`, and `.gitignore`
- **AND** `ca.key` is present in a fresh-clone-then-`just obs-certs` flow but is excluded from git via `.gitignore`

#### Scenario: CA cert is the shared trust anchor

- **WHEN** a reader inspects `infra/k8s/base/collector/certs/ca.crt` and `infra/k8s-obs/base/collector/certs/ca.crt`
- **THEN** both files are byte-identical to `infra/observability/certs/ca.crt`

#### Scenario: Validity is suitable for the local mirror

- **WHEN** an operator runs `openssl x509 -in infra/observability/certs/ca.crt -noout -dates`
- **THEN** the `notAfter` date is at least 10 years after the `notBefore` date

### Requirement: `just obs-certs` generates the cross-cluster trust material end-to-end

The repo-root `justfile` SHALL declare a recipe `obs-certs` that drives openssl to produce the CA, the obs collector's server cert + key, and the app collector's client cert + key. The recipe SHALL:

- Assert `openssl` is on `$PATH` and bail with an installation hint if not.
- Generate the CA key + self-signed CA cert into `infra/observability/certs/` using `infra/observability/certs/openssl.cnf` as the openssl config.
- Sign an obs collector server cert + key into `infra/k8s-obs/base/collector/certs/` with SAN entries covering at minimum `host.lima.internal`, `localhost`, and `collector.observability.svc.cluster.local`.
- Sign an app collector client cert + key into `infra/k8s/base/collector/certs/` with subject CN `app-collector` (or equivalent; subject is not enforced by the receiver, only verifiable signature against the CA is).
- Copy `ca.crt` into both per-cluster certs directories so each side can verify the other.
- Be idempotent: re-running the recipe regenerates every artifact (keys are re-keyed; certs are re-signed).

The `obs-up` recipe SHALL invoke `obs-certs` automatically if `infra/observability/certs/ca.crt` is missing, so a fresh-clone bootstrap is one command.

#### Scenario: `just --list` enumerates the cert-gen recipe

- **WHEN** an operator runs `just --list` at the repo root
- **THEN** the output includes `obs-certs`

#### Scenario: Recipe is idempotent and produces all three identities

- **WHEN** an operator runs `just obs-certs` twice on a clean checkout
- **THEN** the second invocation produces fresh `ca.crt`, `ca.key`, `server.crt`, `server.key`, `client.crt`, `client.key` files without errors
- **AND** every leaf certificate verifies against the CA cert via `openssl verify -CAfile infra/observability/certs/ca.crt <leaf.crt>`

#### Scenario: Recipe bails loudly if openssl is missing

- **WHEN** an operator runs `just obs-certs` on a host where `openssl` is not on `$PATH`
- **THEN** the recipe exits with a non-zero status
- **AND** the error message names `openssl` and a hint for installing it (e.g. brew / apt)

#### Scenario: `just obs-up` auto-invokes the cert-gen recipe on a fresh checkout

- **WHEN** an operator runs `just obs-up` with `infra/observability/certs/ca.crt` absent
- **THEN** the recipe invokes `obs-certs` before bringing up the obs Lima VM
- **AND** the subsequent obs-cluster apply succeeds (the secretGenerators have certs to read)

### Requirement: The obs collector pod mounts the cross-cluster server-cert Secret

The collector container in `infra/k8s-obs/base/collector/deployment.yaml` SHALL declare a second `volumeMount` named `certs` mounted read-only at `/etc/otelcol-contrib/certs/`, and the Deployment's `volumes:` block SHALL declare a corresponding `secret`-typed volume named `certs` referencing a Secret produced by a Kustomize `secretGenerator`. The secretGenerator entry in `infra/k8s-obs/base/collector/kustomization.yaml` SHALL read the per-cluster certs directory `./certs/` (containing `server.crt`, `server.key`, and `ca.crt`) and SHALL NOT disable name suffixing (so a regenerated cert produces a new Secret name and the Deployment rolls automatically). The mounted directory SHALL be the same path the obs collector's receiver `tls:` blocks reference in `cert_file`, `key_file`, and `client_ca_file`.

#### Scenario: Deployment declares the certs volume and mount

- **WHEN** a reader inspects the collector container spec in `infra/k8s-obs/base/collector/deployment.yaml`
- **THEN** the container's `volumeMounts:` list contains an entry `name: certs, mountPath: /etc/otelcol-contrib/certs, readOnly: true`
- **AND** the pod's `volumes:` list contains an entry `name: certs` of type `secret` whose `secretName` matches the Secret produced by the kustomization's secretGenerator
- **AND** the existing `config` volume mount at `/etc/otelcol-contrib/` is unchanged

#### Scenario: kustomization.yaml declares the secretGenerator for the obs collector certs

- **WHEN** a reader inspects `infra/k8s-obs/base/collector/kustomization.yaml`
- **THEN** the file declares a `secretGenerator:` block with an entry whose `name` is the Secret name referenced by the Deployment's `certs` volume
- **AND** the entry's `files:` list materializes `server.crt`, `server.key`, and `ca.crt` from `infra/k8s-obs/base/collector/certs/`
- **AND** the generator does NOT set `disableNameSuffixHash: true`

#### Scenario: Per-directory `.gitignore` keeps private key out of git

- **WHEN** a reader inspects `infra/k8s-obs/base/collector/certs/.gitignore` (or the repo-root `.gitignore` patterns)
- **THEN** the pattern excludes `server.key` (or `*.key`)
- **AND** `server.crt` and `ca.crt` are NOT excluded

## MODIFIED Requirements

### Requirement: The obs collector ConfigMap declares the OTLP-receiver → batch → redact → otlp/tempo pipeline

The obs collector's runtime configuration SHALL live in a `ConfigMap` named `collector-config` in the `observability` namespace, mounted read-only at `/etc/otelcol-contrib/`. The pipeline SHALL declare exactly one `otlp` receiver (gRPC `0.0.0.0:4317` and HTTP `0.0.0.0:4318`, no CORS block). Both `otlp.protocols.grpc` and `otlp.protocols.http` SHALL declare a `tls:` block requiring mutual TLS:

- `cert_file: /etc/otelcol-contrib/certs/server.crt`
- `key_file: /etc/otelcol-contrib/certs/server.key`
- `client_ca_file: /etc/otelcol-contrib/certs/ca.crt`
- `require_client_cert: true` (the OTLP receiver's documented YAML key in otelcol-contrib v0.111.0; if the actual key name differs in the running binary, the spec-compatible key SHALL be used and a comment SHALL note the divergence)

The receivers SHALL NOT accept plaintext connections. A client that does not present a certificate signed by the configured CA SHALL be rejected at the TLS handshake.

The pipeline SHALL also declare `batch` and `transform/redact-path-ids` processors (OTTL statements identical to the app cluster collector's, including `url.path` alongside the deprecated `http.url`/`http.target`/`url.full` attributes), a `health_check` extension on `:13133/`, and three exporters: `otlp/tempo` pointing at `tempo.observability.svc.cluster.local:4317` with `tls.insecure: true` (traces, in-cluster), `otlphttp/loki` pointing at `http://loki.observability.svc.cluster.local:3100/otlp` with `tls.insecure: true` (logs, using Loki 3.x's native OTLP ingest path), and `prometheusremotewrite/in-cluster` pointing at `http://prometheus-server.observability.svc.cluster.local/api/v1/write` with `tls.insecure: true` (metrics). These in-cluster exporters remain plaintext because they do not cross a VM boundary.

The declared pipelines SHALL be exactly three:

- `traces`, with `receivers: [otlp]`, `processors: [batch, transform/redact-path-ids]`, `exporters: [otlp/tempo]`.
- `logs`, with `receivers: [otlp]`, `processors: [batch, transform/redact-path-ids]`, `exporters: [otlphttp/loki]`.
- `metrics`, with `receivers: [otlp]`, `processors: [batch]`, `exporters: [prometheusremotewrite/in-cluster]`.

The redact-path-ids processor is defence-in-depth at this hop: every collector in the path applies the same redaction so a future regression at the app collector does not leak high-cardinality path segments into the obs cluster's storage.

#### Scenario: ConfigMap key projects as a file at the expected path

- **WHEN** a reader inspects `infra/k8s-obs/base/collector/configmap.yaml`
- **THEN** the ConfigMap has a single data key named `config.yaml`
- **AND** the deployment mounts this ConfigMap at `/etc/otelcol-contrib/`

#### Scenario: Receivers enable OTLP on both gRPC and HTTP and require client cert

- **WHEN** a reader inspects the `receivers:` block in the obs collector config
- **THEN** an `otlp` receiver is declared with `protocols.grpc.endpoint: 0.0.0.0:4317` and `protocols.http.endpoint: 0.0.0.0:4318`
- **AND** no `cors:` block appears under `protocols.http`
- **AND** each protocol block declares a `tls:` sub-block with `cert_file: /etc/otelcol-contrib/certs/server.crt`, `key_file: /etc/otelcol-contrib/certs/server.key`, `client_ca_file: /etc/otelcol-contrib/certs/ca.crt`
- **AND** each `tls:` block sets `require_client_cert: true` (or the v0.111.0 contrib-binary equivalent key, with a comment naming any divergence)

#### Scenario: A client without a valid cert is rejected at handshake

- **WHEN** an operator runs `openssl s_client -connect host.lima.internal:14317 < /dev/null` from the macOS host
- **THEN** the handshake fails with a TLS alert (e.g. `certificate required` or `bad certificate`)
- **AND** the obs collector logs the rejected connection

#### Scenario: A client presenting a cert NOT signed by the CA is rejected

- **WHEN** the app collector dials the obs collector while configured with a cert signed by a different CA
- **THEN** the obs collector rejects the handshake
- **AND** the app collector logs a TLS handshake error against the obs-cluster exporter

#### Scenario: Redaction policy mirrors the app cluster collector and includes `url.path`

- **WHEN** a reader inspects the `processors:` block in the obs collector config
- **THEN** a `transform/redact-path-ids` processor is declared
- **AND** the OTTL `trace_statements` target the attribute key `url.path` for every redaction pattern (UUID, opaque-hex, numeric)
- **AND** the OTTL statements also target `span.name`, `attributes["http.url"]`, `attributes["http.target"]`, `attributes["url.full"]` (kept as defence-in-depth for legacy instrumentation)
- **AND** the OTTL statements are byte-equivalent to those in `infra/k8s/base/collector/configmap.yaml` for the same set of patterns and attributes

#### Scenario: In-cluster exporters remain plaintext

- **WHEN** a reader inspects the `exporters:` block in the obs collector config
- **THEN** an exporter named `otlp/tempo` is declared with `endpoint: tempo.observability.svc.cluster.local:4317` and `tls.insecure: true`
- **AND** an exporter named `otlphttp/loki` is declared with `endpoint: http://loki.observability.svc.cluster.local:3100/otlp` and `tls.insecure: true`
- **AND** an exporter named `prometheusremotewrite/in-cluster` is declared with `endpoint: http://prometheus-server.observability.svc.cluster.local/api/v1/write` and `tls.insecure: true`

#### Scenario: Three pipelines are declared, each with its single exporter

- **WHEN** a reader inspects the `service.pipelines:` block in the obs collector config
- **THEN** exactly three pipelines are declared: `traces`, `logs`, and `metrics`
- **AND** the `traces` pipeline's `receivers` is `[otlp]`, `processors` is `[batch, transform/redact-path-ids]`, `exporters` is `[otlp/tempo]`
- **AND** the `logs` pipeline's `receivers` is `[otlp]`, `processors` is `[batch, transform/redact-path-ids]`, `exporters` is `[otlphttp/loki]`
- **AND** the `metrics` pipeline's `receivers` is `[otlp]`, `processors` is `[batch]`, `exporters` is `[prometheusremotewrite/in-cluster]`

#### Scenario: health_check extension is enabled and registered

- **WHEN** a reader inspects the obs collector config
- **THEN** the `extensions:` block declares `health_check: {}`
- **AND** the `service.extensions:` list contains `health_check`

#### Scenario: Operator queries logs in obs grafana end-to-end

- **WHEN** the in-cluster backend has served real traffic and a frontend user has triggered an FE error
- **AND** the operator opens obs grafana → Explore → Loki
- **THEN** log entries appear for `event.dataset=frontend.error` (the slice-7 dataset tag)
- **AND** at least one such entry corresponds to the FE error the user triggered

#### Scenario: Operator queries FE web-vitals in obs grafana end-to-end

- **WHEN** the in-cluster frontend has emitted at least one web-vitals export cycle
- **AND** the operator opens obs grafana → Explore → Prometheus
- **AND** the operator queries `web_vitals_lcp_bucket`
- **THEN** the query returns at least one series with non-zero buckets

### Requirement: The obs Hetzner overlay declares a commented stub for the collector

The `infra/k8s-obs/overlays/hetzner/kustomization.yaml` SHALL contain a commented stub naming what the Hetzner-deploy slice will add for the obs collector: production resource caps, TLS material distribution (the cross-cluster self-signed CA from slice 19 stays the trust anchor; slice 23 introduces cert-manager-managed Certificate resources backed by a self-signed `ClusterIssuer` so the CA private key is no longer kept on disk on a developer machine; the production server cert SAN list swaps `host.lima.internal` for the obs box's private-network IP or DNS name; renewals become automated via cert-manager rather than manual recipe re-runs), an Ingress or LoadBalancer that terminates inbound OTLP on the obs box's public/private IP, tighter probe timings, and storage / retention sizing for the obs box. The stub SHALL be comments only — no live resources.

#### Scenario: obs Hetzner overlay names the collector additions a future slice will plug in

- **WHEN** a reader inspects `infra/k8s-obs/overlays/hetzner/kustomization.yaml`
- **THEN** the file contains commented YAML or commented narrative naming the production resource caps, TLS material distribution (cert-manager-managed Certificates backed by a self-signed ClusterIssuer for the cross-cluster CA, separate ACME issuer for any external ingress), ingress strategy, and probe-timing changes the Hetzner slice will add for the obs collector
- **AND** the narrative explicitly names that the slice-19 self-signed CA remains the trust anchor (only its distribution mechanism changes) and that the CA private key is NOT kept on disk in production
- **AND** none of those declarations are uncommented in this slice
