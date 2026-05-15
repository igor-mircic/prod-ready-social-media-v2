#!/usr/bin/env bash
# Install k3s on a fresh Ubuntu 24.04 host. Invoked by:
#   - infra/lima/lima.yaml's provision: block (local-dev VM today)
#   - eventually, a Hetzner cloud-init userdata invocation (next slice)
#
# This script MUST remain host-agnostic. It does NOT branch on Lima
# vs Hetzner, does NOT read Lima-specific env vars, and does NOT
# touch Lima-specific paths. The single source of truth for "what an
# installed k3s node looks like in this project" lives here; the
# `infra/lima/lima.yaml` `provision:` block (Lima-only) and the
# future Hetzner cloud-init (Hetzner-only) merely invoke it.
#
# Pinning policy: an explicit k3s version is set below in
# INSTALL_K3S_VERSION. We deliberately avoid the `latest` / `stable`
# channels so the local and remote clusters never drift behind our
# backs. Bumping the pin is a deliberate edit to this file.
#
# Idempotency: re-running on a host that already has k3s installed
# at the pinned version is a no-op. Re-running with a different
# pinned version converges the install to the new pin.

set -euo pipefail

# Pinned k3s version. The 1.31.x line is the stable channel as of
# slice authoring. Re-pin against the active release at the time of
# any future provisioning rerun.
INSTALL_K3S_VERSION="v1.31.7+k3s1"

# Bundled k3s components — Traefik (ingress), klipper-lb (ServiceLB),
# local-path-provisioner (default StorageClass), metrics-server — are
# the deliberate choice for this project. We pass NO `--disable …`
# flags below, so all four stay enabled. A future slice may swap
# Traefik for ingress-nginx (captured in design.md); that swap will
# be a deliberate edit to this script, not implicit drift.
INSTALL_K3S_EXEC=""

# Idempotency guard. Treat "k3s already installed AND running the
# pinned version" as a no-op. Anything else (no k3s, different
# version) falls through to the installer, which is itself idempotent
# w.r.t. the running cluster — it converges configuration without
# disrupting workloads when the binary version matches.
if command -v k3s >/dev/null 2>&1; then
  current_version=$(k3s --version 2>/dev/null | awk '/^k3s version/ {print $3}')
  if [ "${current_version:-}" = "${INSTALL_K3S_VERSION}" ]; then
    echo "k3s ${INSTALL_K3S_VERSION} already installed at $(command -v k3s); nothing to do."
    exit 0
  fi
  echo "k3s ${current_version:-unknown} present; running installer to converge on ${INSTALL_K3S_VERSION}."
fi

# Official k3s install one-liner. INSTALL_K3S_VERSION pins the
# release. INSTALL_K3S_EXEC is empty — bundled defaults stay
# enabled (see comment above).
curl -sfL https://get.k3s.io \
  | INSTALL_K3S_VERSION="${INSTALL_K3S_VERSION}" \
    INSTALL_K3S_EXEC="${INSTALL_K3S_EXEC}" \
    sh -

# Make the kubeconfig group-readable. k3s writes /etc/rancher/k3s/
# k3s.yaml as mode 0600 by default; non-root callers (Lima's
# copyToHost agent, future cloud-init post-steps) need read access.
# This chmod is a property of k3s's on-disk layout, not Lima- or
# Hetzner-specific.
if [ -f /etc/rancher/k3s/k3s.yaml ]; then
  chmod 0644 /etc/rancher/k3s/k3s.yaml
fi

echo "k3s ${INSTALL_K3S_VERSION} installed."
