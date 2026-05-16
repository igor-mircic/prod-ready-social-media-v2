## 1. Trust anchor: openssl config + cert-gen recipe + ignore patterns

- [ ] 1.1 Create `infra/observability/certs/openssl.cnf` with sections for the CA's `req_distinguished_name`, the leaf certs' `req_distinguished_name`, and SAN extensions for the server cert (`DNS:host.lima.internal`, `DNS:localhost`, `DNS:collector.observability.svc.cluster.local`) and the client cert (subject CN `app-collector`, no SAN required for client auth).
- [ ] 1.2 Create `infra/observability/certs/.gitignore` with at minimum `*.key` (excludes the CA private key and any other key that lands here).
- [ ] 1.3 Add a `just obs-certs` recipe to the repo-root `justfile` that drives openssl end-to-end: assert `openssl` is on `$PATH` (bail with a brew/apt hint if missing); generate the CA key + self-signed CA cert into `infra/observability/certs/`; generate + sign the obs server cert/key into `infra/k8s-obs/base/collector/certs/`; generate + sign the app client cert/key into `infra/k8s/base/collector/certs/`; copy `infra/observability/certs/ca.crt` into both per-cluster certs directories. The recipe MUST be idempotent (re-running regenerates everything).
- [ ] 1.4 Add an `assert` block at the head of `just obs-up` that, if `infra/observability/certs/ca.crt` is missing, invokes `just obs-certs` before starting the Lima VM.
- [ ] 1.5 Add a `.gitignore` entry covering `infra/k8s/base/collector/certs/*.key` and `infra/k8s-obs/base/collector/certs/*.key` (per-directory `.gitignore` files in those dirs are an acceptable alternative — pick one place and be consistent).
- [ ] 1.6 Run `just obs-certs` once to produce the initial CA cert + leaf certs. Verify `openssl verify -CAfile infra/observability/certs/ca.crt infra/k8s-obs/base/collector/certs/server.crt` succeeds; same for the app client cert.
- [ ] 1.7 Commit `infra/observability/certs/ca.crt`, `infra/observability/certs/openssl.cnf`, `infra/observability/certs/.gitignore`, the per-cluster `ca.crt` copies, the per-cluster leaf `.crt` files, and the recipe / `.gitignore` changes. Verify `git status` shows NO `*.key` files staged.

## 2. App collector: mount cert Secret, flip exporters to mTLS

- [ ] 2.1 Add a `secretGenerator:` entry to `infra/k8s/base/collector/kustomization.yaml` reading `infra/k8s/base/collector/certs/{client.crt,client.key,ca.crt}` into a Secret. Do NOT set `disableNameSuffixHash: true` (let Kustomize hash contents so cert regeneration auto-rolls the pod).
- [ ] 2.2 Edit `infra/k8s/base/collector/deployment.yaml`: add a `certs` `volumeMounts` entry on the collector container at `/etc/otelcol-contrib/certs/` (readOnly). Add the matching `secret`-typed volume to `spec.template.spec.volumes` referencing the secretGenerator's Secret name.
- [ ] 2.3 Edit `infra/k8s/base/collector/configmap.yaml`: in the `otlp/obs-cluster` exporter (traces, gRPC), replace `tls.insecure: true` with `tls: { cert_file: /etc/otelcol-contrib/certs/client.crt, key_file: /etc/otelcol-contrib/certs/client.key, ca_file: /etc/otelcol-contrib/certs/ca.crt, insecure: false }`. Endpoint stays `host.lima.internal:14317` (scheme-less).
- [ ] 2.4 Edit `infra/k8s/base/collector/configmap.yaml`: in `otlphttp/obs-cluster-logs`, flip the endpoint from `http://host.lima.internal:14318` to `https://host.lima.internal:14318` and replace `tls.insecure: true` with the same four `tls:` keys as task 2.3.
- [ ] 2.5 Edit `infra/k8s/base/collector/configmap.yaml`: in `otlphttp/obs-cluster-metrics`, apply the same edit as task 2.4 (https:// endpoint + four-key `tls:` block).
- [ ] 2.6 Verify (visual diff): the three `*compose-relay*` exporters are UNCHANGED — they keep `tls.insecure: true` and plaintext `http://` endpoints.
- [ ] 2.7 Update the header narrative comment in `infra/k8s/base/collector/configmap.yaml` to name slice 19: the three obs-cluster exporters are now TLS-wrapped against the shared self-signed CA; compose-relay exporters stay plaintext (slice 22 retirement). Keep the pre-existing OTTL-drift / dual-write narrative intact.

## 3. Obs collector: mount cert Secret, require client cert on receivers

- [ ] 3.1 Add a `secretGenerator:` entry to `infra/k8s-obs/base/collector/kustomization.yaml` reading `infra/k8s-obs/base/collector/certs/{server.crt,server.key,ca.crt}` into a Secret. Same hashing posture as the app side (no `disableNameSuffixHash`).
- [ ] 3.2 Edit `infra/k8s-obs/base/collector/deployment.yaml`: add a `certs` volumeMount at `/etc/otelcol-contrib/certs/` (readOnly) and the matching secret-typed volume referencing the secretGenerator's Secret.
- [ ] 3.3 Edit `infra/k8s-obs/base/collector/configmap.yaml`: add `tls:` sub-blocks under `receivers.otlp.protocols.grpc` and `receivers.otlp.protocols.http` with `cert_file: /etc/otelcol-contrib/certs/server.crt`, `key_file: /etc/otelcol-contrib/certs/server.key`, `client_ca_file: /etc/otelcol-contrib/certs/ca.crt`, and `require_client_cert: true`.
- [ ] 3.4 **Verify the YAML key names against the running v0.111.0 contrib binary** (`docker run --rm otel/opentelemetry-collector-contrib:0.111.0 components 2>&1 | grep -A 20 otlp` or read the OTLP receiver source for v0.111.0). If `require_client_cert` is named differently in this version (e.g. `client_cert_required`), correct the key and add a one-line comment naming the upstream rename or the v0.111.0 quirk so future readers don't think the spec is wrong.
- [ ] 3.5 Update the header narrative comment in `infra/k8s-obs/base/collector/configmap.yaml` to name slice 19: the OTLP receivers now require client cert auth against the shared CA; in-cluster exporters (tempo / loki / prometheus) stay plaintext (same cluster, no VM boundary).
- [ ] 3.6 Verify (visual diff): the in-cluster exporters (`otlp/tempo`, `otlphttp/loki`, `prometheusremotewrite/in-cluster`) keep `tls.insecure: true` unchanged.

## 4. Apply, verify cross-cluster handshake, verify dual-write parity

- [ ] 4.1 `just obs-up` and `just up` (or whatever the existing app-up recipes are) — verify both clusters are healthy.
- [ ] 4.2 Apply the obs side: `kubectl --context social-obs apply -k infra/k8s-obs/overlays/local`. Wait for the obs collector Deployment to roll. Tail logs with `just obs-collector-logs` and verify no `failed to start receiver` errors involving the new `tls:` blocks.
- [ ] 4.3 Apply the app side: `kubectl --context lima-social apply -k infra/k8s/overlays/local`. Wait for the app collector Deployment to roll. Tail logs and verify no `tls: handshake error` lines against any `*obs-cluster*` exporter.
- [ ] 4.4 Generate traffic against the app cluster: open the in-k3s frontend, log in, create a post, navigate around. The app collector emits traces / logs / metrics; the obs-cluster exporters fan them out over mTLS.
- [ ] 4.5 Open compose grafana on `:3000` and obs grafana on `:3001` side-by-side. Confirm the same trace IDs appear in both — this is the load-bearing dual-write parity check that slice 22 needs to be working before it can collapse.
- [ ] 4.6 (Negative test) From the macOS host, run `openssl s_client -connect host.lima.internal:14317 < /dev/null` with NO client cert. Confirm the handshake is rejected by the obs collector receiver and a corresponding rejection appears in `just obs-collector-logs`.
- [ ] 4.7 (Negative test) Temporarily edit one byte of `infra/k8s/base/collector/certs/client.crt` to corrupt it, `kubectl apply -k infra/k8s/overlays/local`, confirm the app collector logs TLS handshake errors against all three obs-cluster exporters, the obs collector logs `bad certificate` rejections, and compose grafana keeps showing data (proof the dual-write isolates failures per exporter). Restore the cert with `just obs-certs && kubectl apply -k infra/k8s/overlays/local` and confirm recovery.

## 5. Hetzner overlay stubs

- [ ] 5.1 Edit `infra/k8s-obs/overlays/hetzner/kustomization.yaml`: update the existing TLS-material comment to name slice 23's cert-manager-managed Certificate resources backed by a self-signed `ClusterIssuer` (cross-cluster CA stays the trust anchor; only distribution changes; CA private key NOT on disk in production; SAN list swaps `host.lima.internal` for the obs box's production address). Comments only.
- [ ] 5.2 Edit `infra/k8s/overlays/hetzner/kustomization.yaml`: update the existing TLS / mTLS comment to name the same slice-23 cert-manager picture and explicitly confirm the slice-19 self-signed-CA trust model carries forward. Comments only.

## 6. README

- [ ] 6.1 Add a "Cross-cluster mTLS" subsection under the README's "Local observability" (or equivalent) section. Cover: where the trust anchor lives (`infra/observability/certs/ca.crt`); how to (re)generate (`just obs-certs`); the per-cluster cert directories and what they contain; the loud failure mode if certs are missing (TLS handshake error in app collector logs, obs collector receiver readiness probe fails — pointer to the recipe); and the non-goals (compose-relay leg stays plaintext until slice 22; cert-manager + ACME defer to slice 23).
- [ ] 6.2 Update the "Browser OTLP path" / cross-cluster topology diagrams (if any present in README post-slice-18c) to annotate the obs-cluster leg as TLS-wrapped.

## 7. Validate, branch, commit, push, PR, watch CI, archive

- [ ] 7.1 Run `openspec validate --strict add-cross-cluster-mtls` once more — must be green.
- [ ] 7.2 Run the full local sanity sweep: `just obs-up`, `just up`, the cross-cluster handshake verifications from tasks 4.2–4.5. Tear down with `just down` / `just obs-down` to confirm reversibility.
- [ ] 7.3 Create branch `add-cross-cluster-mtls`, stage and commit the implementation (all the file changes from tasks 1–6).
- [ ] 7.4 Push the branch, open a PR using the project's PR template / convention, watch CI to green.
- [ ] 7.5 Archive the change: `openspec archive add-cross-cluster-mtls --date $(date +%Y-%m-%d) --skip-specs` first to sanity-check the deltas, then `openspec archive add-cross-cluster-mtls --date $(date +%Y-%m-%d)` to fold them into `openspec/specs/`. Commit the archive move + spec updates on the same branch.
- [ ] 7.6 Re-watch CI, get PR approved per the project's autonomous-until-merge convention (memory: `feedback_openspec_apply_autonomous_to_merge`), and pause at merge for explicit user approval.
