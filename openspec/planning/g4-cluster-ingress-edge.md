# G4 — Cluster ingress + edge

**Status:** planning · 2-slice arc
**Promotes to:** `openspec/changes/add-cluster-ingress/` for the first slice; later slice gets its own change directory.

## Why

Every host-reachable surface in the project today is one of:

- A `kubectl port-forward` (grafana, prometheus, alertmanager on the obs cluster — `just obs-grafana` etc.).
- A Lima `portForwards:` entry that exposes a klipper-lb-fronted Service on a host port (`:9090` prom, `:3100` loki, `:3200` tempo, `:9093` alertmanager, `:8081` webhook-sink, `:4318` collector OTLP — all added in slices 17, 18a-c, 22b).

Both are scaffolding. A real cluster reaches its workloads via Ingress: HTTP routed by hostname + path through a single controller, TLS terminated at the edge. The decision the project keeps deferring — Traefik (k3s default) vs ingress-nginx (the more common production choice) — is the centre of this group.

The README has flagged this as a future slice (`add-cluster-ingress`) since slice 14. It's been deferred each round because no workload *needed* it. That changes the moment a slice wants a real hostname + TLS termination instead of a port-forward — including any future Hetzner cutover.

## Slices in this group

```
G4.1  add-cluster-ingress              decision + first Ingress (FE)
G4.2  move-obs-surfaces-to-ingress     grafana/prom/alertmanager off port-forward
```

G4.1 settles the controller. G4.2 is a mechanical retrofit of the obs cluster's surfaces once the controller exists.

## Slice sketches

### G4.1 — `add-cluster-ingress`

**The decision.** Pick one of:

- **(a) Stay on Traefik** (k3s default, already running). One less thing to install; the IngressRoute CRD is the native shape; works fine for HTTP and TLS. *Argument against:* less common in real-world production clusters; ingress-nginx is the lingua franca of k8s tutorials and production guides.
- **(b) Disable Traefik, install ingress-nginx** (`k3s --disable=traefik`, then `helm install ingress-nginx`). More work; more aligned with what production clusters typically run. *Argument against:* re-provisioning k3s is destructive; ingress-nginx pulls in a `controller` Deployment + a Service typed LoadBalancer + ~12 CRDs.

**Recommendation:** **(b) ingress-nginx**. The project's stated north star ("production-grade locally") and the user's recurring preference for primitives-that-mirror-real-clusters argue for it. The destructive re-provision is acceptable once.

**Concrete slice content:**

- Re-provision k3s with `--disable=traefik` (one flag in the lima config's k3s install line).
- Install ingress-nginx via Helm chart, pinned version. ClusterIP Service; klipper-lb fronts it on `:80` and `:443`.
- Lima portForwards: add host `:80` → klipper-lb, host `:443` → klipper-lb. Replaces the per-Service portForwards for FE (`:8080`) and any future FE Ingress hostnames.
- Add a hosts-file convention: `127.0.0.1 social.local api.social.local grafana.local prom.local alertmanager.local` (documented in README; not auto-edited). Pick one canonical subdomain shape.
- **First Ingress: frontend.** Replace the `:8080` Lima portForward with an Ingress resource for `social.local` pointing at the frontend Service. Update e2e specs' `BASE_URL` from `http://localhost:8080` to `http://social.local`.
- TLS posture: not yet. G4.1 lands plaintext HTTP only on `*.local`. Local TLS adds complexity (self-signed cert in the browser trust store) for little local benefit; defer to a future slice that pairs with mkcert or the eventual Hetzner LE setup.
- Justfile recipes: `just fe-host` (a check that `/etc/hosts` has the entries; not an auto-edit).

**Open questions for G4.1:**
- Single Ingress controller across both clusters, or one per cluster? **Per cluster** is the only honest answer (each cluster has its own apiserver and CNI; cross-cluster Ingress would require a service mesh or external L4). Both clusters get their own ingress-nginx install.
- Does the backend get an Ingress, or does it stay reachable only through the frontend's same-origin nginx-proxy? Slice 14 settled on same-origin via the FE nginx, so backend has no host-side surface today. **Keep that.** Backend stays in-cluster only; FE Ingress fronts the public-facing path.

### G4.2 — `move-obs-surfaces-to-ingress`

- Once ingress-nginx exists in the obs cluster (added in G4.1's obs-side companion install), add Ingress resources for:
  - `grafana.local` → grafana Service :80
  - `prom.local` → prometheus Service :9090
  - `alertmanager.local` → alertmanager Service :9093
  - `loki.local` and `tempo.local` (less useful; their UIs are minimal; consider deferring or skipping).
  - `webhook-sink.local` → webhook-sink Service :8080 (replaces the host `:8081` remap from slice 22b).
- Lima portForwards: drop the five per-Service entries (`:9090`, `:3100`, `:3200`, `:9093`, `:8081`); keep only `:80` → klipper-lb. Net: -5 portForwards, +1 Ingress per Service.
- e2e specs: retarget the five observability specs from `http://localhost:9090/3100/3200/9093/8081` to `http://prom.local`, `http://loki.local`, etc. Mechanical edit; no assertion shape change.
- README: rewrite the "Verb surface" + "Forward arc" sections in `Local observability cluster` to describe the Ingress-fronted shape; `just obs-grafana` recipe becomes "open http://grafana.local".

## Non-goals

- No TLS. Local stays plaintext on `*.local`. TLS lands paired with mkcert (its own micro-slice) or alongside the Hetzner cutover.
- No external DNS automation. `/etc/hosts` is the local mechanism; a CoreDNS rewrite or dnsmasq would be cleaner but isn't worth the complexity for 5–6 hostnames.
- No WAF / rate-limiting / auth at the Ingress edge. Future slices if a real attack surface matters.
- No swap of klipper-lb for MetalLB. klipper-lb is the k3s default and works.

## Sequencing

```
G4.1 ─→ G4.2
```

Both depend on whatever multi-node story G2 lands (ingress-nginx Deployment should land on the worker node, not the server; cleaner with G2.4's topology spread).

G4.1 should land *before* any meaningful slice that wants a hostname or TLS — including any Hetzner work, when that re-enters scope. Until then, G4 is "want it" not "need it."

## Risk

- **k3s re-provision is destructive.** Same risk shape as G3.2 (CNI swap). Could be combined with G3.2 into a single "re-provision k3s with these flags" slice to amortise the disruption — but tangles two decisions in one revert unit. Recommendation: keep them separate; land G4.1 first if both are queued.
- **e2e spec churn.** Every spec that reads a hardcoded `http://localhost:<port>` URL gets edited. Manageable but touches ~10 files.
- **Hosts-file dependency** is a manual step a new contributor will hit. Justfile recipe + a clear README block mitigates; an `mkcert`/`dnsmasq`-style spike could eliminate but isn't worth it for the local mirror.

## Size estimate

- G4.1: 2–3 evenings (the decision + the k3s re-provision + the FE retarget).
- G4.2: 1 evening (mechanical).

Total: ~half a week of evenings.
