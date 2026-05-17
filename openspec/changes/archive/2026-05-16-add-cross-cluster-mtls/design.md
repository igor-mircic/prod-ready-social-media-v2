## Context

After slices 18a/18b/18c, the cross-VM data path is fully shaped: the app k3s collector dual-writes traces/logs/metrics, the obs k3s collector receives via `host.lima.internal:14317` / `:14318` (Lima portForwards → klipper-lb → obs collector pod) and fans out to in-cluster tempo / loki / prometheus. Every cross-cluster exporter on the app side carries `tls.insecure: true`; the obs collector's `otlp` receiver declares no `tls:` block at all. The transport is plaintext OTLP and a local-mirror of "two boxes on a private network" that has never exercised the trust primitives the production deploy needs.

Slice 19's job, repeatedly foreshadowed (README §"Forward arc" line 455, slice 18b/18c design.md non-goals, slice 18c tasks 8.1/8.2 stubbing the hetzner overlays), is to put a self-signed CA + mutual TLS between the app and obs clusters' collectors before slice 23 has to do this against a real Hetzner deploy with real cert distribution constraints.

Stakeholders are the maintainer (single-person learning project) plus the `feedback_prefer_realistic_architectures.md` stance — pick the production-real shape even at toy scale. Cert-manager is the production-real shape *eventually*; for this slice, openssl is the production-real shape *for the trust primitives themselves*. Decision 1 picks them apart.

## Goals / Non-Goals

**Goals:**
- No plaintext OTLP crosses a VM boundary. The app collector dials the obs collector over OTLP-over-TLS with a client certificate; the obs collector requires (`require_client_cert: true`) and verifies (`client_ca_file`) that client cert against the shared self-signed CA.
- Trust primitives are visible in the repo: the CA cert is checked in, the openssl config that produced it is checked in, the recipe that signs leaf certs is in the justfile. A reader can re-derive the entire trust chain without git archeology.
- Local cert-gen is a single recipe call, idempotent, auto-invoked by `obs-up` if the CA cert is missing — fresh-clone bootstrap stays one command.
- Rotation is mechanical: re-run the recipe, Kustomize `secretGenerator` hashes the new contents, pods restart automatically.
- Hetzner overlay stubs grow a one-line note describing the prod-vs-local diff so slice 23 knows exactly what changes.
- Compose grafana on `:3000` and obs grafana on `:3001` continue to render the same trace data side-by-side — this slice does NOT regress the dual-write parity check that slice 22 depends on.

**Non-Goals:**
- TLS on the `*compose-relay*` exporter leg of the dual-write. That path is local-only and retired in slice 22; layering mTLS on it is churn for zero benefit.
- cert-manager adoption. Slice 23, when ACME / Let's Encrypt enters the picture.
- Automated cert rotation. Manual `just obs-certs` re-run is fine for the local mirror; slice 23 wires cert-manager renewals.
- mTLS on intra-cluster traffic. Backend pod → app collector (ClusterIP, same cluster) and browser nginx → app collector (ClusterIP, same cluster) stay plaintext — same-cluster ClusterIP traffic is not a VM-boundary crossing.
- Service-mesh-style mTLS-everywhere (Linkerd, Istio). Separate concern, not load-bearing for the production deploy story.
- Trace-context propagation. mTLS is L4/L5; W3C `traceparent` is L7 and unaffected by transport encryption. The FE→BE propagation work memorialized after slice 16 stays a frontend defect.
- E2E or CI exercise of the cross-cluster path. CI does not bring up the obs Lima VM; the e2e harness uses the compose-relay path.

## Decisions

### Decision 1 — openssl + Kustomize secretGenerator, NOT cert-manager (in this slice)

The CA, server cert, and client cert are produced by a `just obs-certs` recipe that drives openssl end-to-end. The resulting files are materialized into the cluster as Kubernetes Secrets via Kustomize `secretGenerator` directives in the per-cluster collector kustomization files.

**Alternatives considered:**

- *cert-manager with a self-signed `ClusterIssuer`.* Install the cert-manager chart in both clusters, define a `ClusterIssuer` of kind `SelfSigned`, define three `Certificate` CRs (CA, obs-server, app-client). cert-manager renews automatically and owns the lifecycle.
- *openssl + secretGenerator.* Plain openssl invocations write PEM files; Kustomize hashes them into Secrets at apply time.

**Why openssl + secretGenerator:**

- The slice's *intent* is to put the cross-cluster trust primitives in place. openssl makes the chain visible in the repo: a reader sees `openssl.cnf`, the justfile recipe steps, and the resulting `ca.crt` — there is no CRD layer between the operator and the trust material. cert-manager hides the chain behind `Issuer` / `Certificate` CRDs and the chart's controller; for a learning project that values "exercising primitives," openssl is the more honest first pass.
- cert-manager is genuinely load-bearing for slice 23 — ACME / Let's Encrypt against real Hetzner DNS is what it's designed for. Introducing it NOW would conflate two changes ("establish cross-cluster mTLS" + "adopt cert-manager"). Slice 23 still has to do the ACME issuer / DNS-01 challenge work regardless; deferring cert-manager to that slice keeps each change one concern.
- Kustomize `secretGenerator` is the perfect glue: it hashes contents into the Secret name suffix, so editing a cert file changes the Secret name and Kustomize-driven apply rolls the pod automatically. No `kubectl rollout restart` ceremony.
- Cost of openssl: ~30 lines of bash in a justfile recipe; one openssl.cnf config file; one `.gitignore`. cert-manager would be ~3 Helm chart pins + 3 `Certificate` CRs + waiting on the controller to materialize the secrets at first apply.

**Forward path:** slice 23 either (a) replaces the openssl recipe with cert-manager-managed `Certificate` resources backed by a self-signed `ClusterIssuer` for the cross-cluster CA, while using a separate ACME `ClusterIssuer` for the external ingress, or (b) keeps openssl for the cross-cluster CA and uses cert-manager exclusively for the external Let's Encrypt cert. Decision deferred to slice 23; either is unblocked by what this slice ships.

### Decision 2 — Scope: mTLS only on the obs collector's OTLP receivers; everything else stays plaintext

The receiver-side TLS termination point is the obs cluster's collector pod. The exporter-side TLS origin point is the app cluster's collector pod. Specifically scoped:

- **In scope:** `otlp/obs-cluster` (gRPC), `otlphttp/obs-cluster-logs`, `otlphttp/obs-cluster-metrics` on the app collector → `receivers.otlp.protocols.{grpc,http}` on the obs collector. Both directions verify each other against the shared CA.
- **Out of scope:** `otlp/compose-relay` and the two `otlphttp/compose-relay-*` exporters on the app collector. Plaintext, slice-22 retirement.
- **Out of scope:** backend pod → `collector.social.svc.cluster.local:4318`. Same-cluster ClusterIP.
- **Out of scope:** browser → frontend nginx → app collector. Same-cluster, single-pod nginx reverse proxy.
- **Out of scope:** app collector's `otlp/tempo`, `otlphttp/loki`, `prometheusremotewrite/in-cluster` (obs side) — wait, these are on the obs collector; same-cluster, plaintext stays.

**Why this scope:** the load-bearing property the slice asserts is "no plaintext OTLP crosses a VM boundary." Same-cluster traffic does not cross a VM boundary; the compose-relay leg crosses a VM boundary today but is local-mirror-only and dies in slice 22. The slice's footprint is therefore precisely "the three obs-cluster exporters + the obs receiver."

### Decision 3 — Cert layout: one CA, one server cert, one client cert

- **CA** at `infra/observability/certs/ca.crt` (public, checked in) + `infra/observability/certs/ca.key` (private, gitignored). 10-year validity (local mirror; rotation is a re-run of the recipe).
- **Server cert** for the obs collector's OTLP receiver: `infra/k8s-obs/base/collector/certs/server.crt` + `server.key`. SANs cover the three names a client might dial: `host.lima.internal` (the Lima portForward target), `localhost` (defence-in-depth), `collector.observability.svc.cluster.local` (in-cluster Service FQDN — not used by this slice's traffic, but cheap and lets in-cluster clients become a future option without a re-sign). 1-year validity.
- **Client cert** for the app collector's three obs-cluster exporters: `infra/k8s/base/collector/certs/client.crt` + `client.key`. Subject CN `app-collector` (the obs side does not enforce subject; just needs a verifiable signature against the CA). 1-year validity.
- The CA cert is included in **both** per-cluster Secrets so each side can verify the other's leaf.

**Alternatives considered:**

- *One shared cert used as both server and client.* Possible (extKeyUsage `serverAuth, clientAuth`). Rejected: a leak of one cert compromises both directions. Cheap to separate.
- *Per-exporter client cert (one per signal).* Three certs instead of one. Rejected: no operational distinction between traces / logs / metrics that motivates separate identities; one client cert means one rotation point.
- *Wildcard SAN on the server cert.* The cert is local-only, the SAN list is small and explicit, wildcard adds nothing.

### Decision 4 — Recipe-driven cert-gen, idempotent, auto-invoked from `obs-up`

`just obs-certs` is the entry point. The recipe:

1. Asserts `openssl` is on `$PATH`; bails with a hint pointing at brew / apt if not.
2. Generates the CA key + self-signed CA cert into `infra/observability/certs/` (idempotent: re-running overwrites).
3. Signs the obs server cert + key into `infra/k8s-obs/base/collector/certs/` and copies `ca.crt` into the same directory.
4. Signs the app client cert + key into `infra/k8s/base/collector/certs/` and copies `ca.crt` into the same directory.
5. Echoes a confirmation line naming where the certs landed.

`just obs-up` gains a guard at its head: if `infra/observability/certs/ca.crt` is missing, invoke `obs-certs` first. Existing `obs-up` users on a stale checkout therefore get a one-time cert-gen on the next `obs-up`, then the cluster comes up healthy.

**Why idempotent re-run rather than skip-if-exists:** `secretGenerator` hashes contents, so a re-run that produces a new cert with a different (random) key changes the Secret's name suffix and rolls the collector pods automatically. This makes "rotate the cert" a one-command operation. Skip-if-exists would silently keep a stale cert in place if the operator wanted to rotate.

### Decision 5 — Collector config shape: receiver demands client cert; exporter presents one

**Obs collector receiver (server side):**

```yaml
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
        tls:
          cert_file: /etc/otelcol-contrib/certs/server.crt
          key_file: /etc/otelcol-contrib/certs/server.key
          client_ca_file: /etc/otelcol-contrib/certs/ca.crt
          # Verify the otelcol-contrib v0.111.0 OTLP receiver
          # TLS config keys at apply time; `require_client_cert` is
          # the documented key in upstream v0.111.0 but if the YAML
          # key is `client_cert_required` or similar in the contrib
          # build, correct it during implementation.
          require_client_cert: true
      http:
        endpoint: 0.0.0.0:4318
        tls:
          cert_file: /etc/otelcol-contrib/certs/server.crt
          key_file: /etc/otelcol-contrib/certs/server.key
          client_ca_file: /etc/otelcol-contrib/certs/ca.crt
          require_client_cert: true
```

**App collector exporter (client side):**

```yaml
exporters:
  otlp/obs-cluster:
    endpoint: host.lima.internal:14317
    tls:
      cert_file: /etc/otelcol-contrib/certs/client.crt
      key_file: /etc/otelcol-contrib/certs/client.key
      ca_file: /etc/otelcol-contrib/certs/ca.crt
      insecure: false
  otlphttp/obs-cluster-logs:
    endpoint: https://host.lima.internal:14318
    tls:
      cert_file: /etc/otelcol-contrib/certs/client.crt
      key_file: /etc/otelcol-contrib/certs/client.key
      ca_file: /etc/otelcol-contrib/certs/ca.crt
      insecure: false
  otlphttp/obs-cluster-metrics:
    # same shape as the logs exporter, https:// scheme
```

The gRPC exporter's `endpoint:` stays scheme-less (`host:port`) — gRPC clients in the OTel collector use the `tls:` block, not the URL scheme, to switch transports. OTLP/HTTP exporters use URL schemes; `http://` → `https://`. Ports stay `:14317` / `:14318` because the Lima portForward is an L4 socket-forward and is transparent to whatever runs above it.

**Compose-relay exporters keep `tls.insecure: true`.** They are tagged with a header comment naming the slice-22 retirement.

### Decision 6 — Loud failure on missing certs; no silent plaintext fallback

If a developer somehow brings up the obs VM with no cert material on disk (CI, manual edits, deleted files), the obs collector's container fails its readiness probe — the OTLP receiver cannot start without the configured cert files. The app collector's exporters then log TLS-handshake errors on every export attempt. The error surface is loud, the symptoms point at the cert files immediately, and the operator runs `just obs-certs` to recover.

**Why not fall back to plaintext if certs are missing:** because that's exactly the failure mode mTLS exists to prevent — accidentally shipping plaintext to a peer that's "supposed" to be TLS. Loud is correct.

### Decision 7 — Hetzner overlay stubs name the diff, not the implementation

The hetzner-overlay edits are comments only (consistent with slices 15–18). The stub names the four things that change between local mirror and production:

1. Trust model stays self-signed CA (cert-manager `ClusterIssuer` of kind `SelfSigned` in slice 23).
2. CA private key is **not** on disk in production — slice 23 stores it in the cert-manager Secret managed by the issuer, never written to a developer machine.
3. Server cert SANs swap `host.lima.internal` for the production receiver address (obs box's private-network IP / Tailscale hostname / DNS).
4. Rotation is automated (cert-manager renewal cycle) rather than manual recipe re-run.

This stub is the bridge that lets slice 23 do the minimum: install cert-manager, declare two Issuers (self-signed for cross-cluster CA, ACME for the external ingress), declare three `Certificate` CRs.

### Decision 8 — Trace context propagation is unaffected

mTLS terminates at the transport layer. The OTel collector still receives OTLP envelopes containing W3C `traceparent` / `tracestate` headers, processes them identically, exports them identically. The slice-16 FE→BE propagation gap (browser fetch → backend span; cross-origin strip on `instrumentation-fetch`) is independent of cross-cluster transport and is unaffected by this slice. The dual-write parity check (compose grafana `:3000` vs obs grafana `:3001` show identical traces) is unaffected: the compose path is plaintext on a separate exporter, the obs path is now TLS-wrapped on its exporter, both still see the same redacted spans because the redaction processor runs upstream of both.

## Risks / Trade-offs

- **[YAML key drift between otelcol-contrib v0.111.0 docs and current code]** The exact receiver-side YAML key is one of `require_client_cert` / `client_cert_required` / similar. → Implementation task verifies the key against the running v0.111.0 binary (`docker run otel/opentelemetry-collector-contrib:0.111.0 --help` or the OTLP receiver source) before committing the config.
- **[Cert expiry surprises the operator a year from now]** 1-year leaf validity is short enough to motivate the cert-manager migration before slice 23 ships. If the operator pauses the project for a year and returns, `just obs-up` will hit handshake failures; the README and recipe error path name "re-run `just obs-certs`" as the recovery step. → 10-year CA validity means the trust anchor itself survives a year of pausing; only leaves need re-signing.
- **[secretGenerator hash churn causes pod restarts on every `just obs-certs` run]** Intentional: a rotation should roll pods. But if the recipe is invoked accidentally (e.g. the `obs-up` guard misfires), pods restart for no reason. → Recipe is idempotent on the openssl side (same inputs would produce same outputs *if* keys were not random). Keys are random by design (a cert rotation should re-key), so the trade-off is "accidental invoke causes one rolling restart" — acceptable for a single-replica dev cluster.
- **[The `obs-up` guard cannot detect a missing leaf cert, only the CA]** The guard checks `ca.crt` exists. A user who deleted `infra/k8s-obs/base/collector/certs/server.crt` but kept the CA would skip the recipe and hit a TLS handshake failure. → Acceptable: deleting a leaf cert manually is not a fresh-clone scenario; the loud failure mode (Decision 6) is the recovery signal.
- **[CA key on disk in `infra/observability/certs/ca.key`]** Anyone with read access to the developer's checkout can sign new certs against the project's trust root. → Local mirror only; never crosses to production. The slice-7 hetzner-overlay stub explicitly names this as a prod-vs-local diff. `.gitignore` keeps the key out of git history.
- **[Slice-22 retire-compose interacts with this slice]** When slice 22 deletes the compose-relay exporters, the app collector's pipelines collapse to single-exporter (obs-only). The obs-only exporter is the TLS one — no `tls.insecure: true` left in the file. Good shape. → No active risk; called out so the slice-22 author knows the cleanup target is "remove three exporter blocks + three list entries, no cert-related work."
- **[Lima portForward TLS-passthrough]** The Lima portForward is an L4 socket-forward and is L7-transparent — TLS handshake bytes flow through unchanged. If the user's Lima version regressed on socket-forward fidelity (no observed regression, but possible), TLS would break at the forward layer. → Out-of-scope to mitigate; would manifest as universal handshake failure that points clearly at the transport.

## Migration Plan

1. Operator pulls slice 19 onto a working slice-18c checkout.
2. `just obs-up` runs the guard, sees `ca.crt` missing, invokes `just obs-certs`. Certs land in three directories.
3. `kubectl --context lima-social apply -k infra/k8s/overlays/local` rolls the app collector with the new client-cert volume + TLS-wrapped exporters.
4. `kubectl --context social-obs apply -k infra/k8s-obs/overlays/local` rolls the obs collector with the new server-cert volume + TLS receivers.
5. Operator opens compose grafana `:3000` and obs grafana `:3001` side-by-side, generates traffic, confirms identical trace counts (the dual-write parity check that has been the load-bearing safety net since slice 18b).
6. **Backout:** `git revert <slice-19-commit>` + `just obs-up && kubectl apply -k …` on both clusters. Pre-slice-19 state is plaintext, fully restored.

## Open Questions

- **OTLP receiver TLS key names in otelcol-contrib v0.111.0.** The implementor verifies against the running binary or upstream source before committing the config. Documented in Decision 5.
- **Should the obs-up guard also check the server / client leaf certs exist?** Current decision is "only `ca.crt`, leaf-missing is loud-fail-acceptable." Worth a 30-second revisit at implementation time — if the guard easily checks all three, no harm in being thorough. Lean is keep guard simple.
- **Do the `obs-up` recipe's existing `--persistent` / `--start-at-boot` flags interact with the cert-gen step?** Expected: no. The guard is a plain bash conditional at the head of the recipe; Lima flags are downstream. Confirm at implementation time.
