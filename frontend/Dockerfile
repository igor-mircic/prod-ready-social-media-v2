# syntax=docker/dockerfile:1.7
#
# Frontend production-shape image — multistage build.
#
# Build context is the REPO ROOT (not `frontend/`) so the build can
# reach `openapi/openapi.json` — the orval generator in
# `frontend/orval.config.ts` references it via `../openapi/openapi.json`
# and emits TypeScript clients that `tsc -b && vite build` consumes.
# The cross-directory dep is why `pnpm install --ignore-scripts` is
# used (postinstall would otherwise run orval before openapi/ is in
# the context) and why orval is invoked explicitly after the full
# source is copied.
#
# Stage 1 (`builder`, node:22-alpine) installs deps with pnpm, runs
# orval against the openapi spec, then `pnpm build`. The three `ARG`s
# are exported as `ENV` so Vite resolves them at build time and freezes
# them into the emitted JS. Their defaults are the in-cluster-local-
# overlay topology values; the Hetzner overlay rebuilds with
# `--build-arg` overrides.
#
# Stage 2 (`runtime`, nginx-unprivileged:1.27-alpine) serves the static
# bundle and performs the same-origin reverse-proxy. The unprivileged
# variant runs as uid 101 and listens on :8080 by default, so the pod
# does not need elevated capabilities to bind. The runtime image is
# Node-free.
#
# The BuildKit `--mount=type=cache` for the pnpm store keeps warm
# rebuilds fast without bloating the image layers.

FROM node:22-alpine AS builder

ARG VITE_API_BASE_URL=""
ARG VITE_OTEL_ENABLED="true"
# Trace endpoint must include the `/v1/traces` path suffix — the OTLP
# HTTP exporter uses the URL verbatim and does not append the OTLP
# path. The frontend's `tracer.ts` default is the same shape; this
# bake matches it. Metrics and logs are intentionally NOT baked so
# their `tracer.ts` / `meter.ts` / `errors.ts` defaults
# (`/v1/metrics`, `/v1/logs`) apply — the Hetzner overlay rebuild
# will need to override all three for production URLs.
ARG VITE_OTEL_TRACES_ENDPOINT="http://localhost:4318/v1/traces"

ENV VITE_API_BASE_URL=$VITE_API_BASE_URL \
    VITE_OTEL_ENABLED=$VITE_OTEL_ENABLED \
    VITE_OTEL_TRACES_ENDPOINT=$VITE_OTEL_TRACES_ENDPOINT

WORKDIR /app

RUN corepack enable

# Copy only the lockfile + manifest first so dep install caches on
# changes to those files alone. `--ignore-scripts` skips the
# `postinstall` hook (orval), which would otherwise fail here because
# `../openapi/openapi.json` is not yet copied.
COPY frontend/package.json frontend/pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts

# Copy the openapi spec alongside the frontend source so `orval`'s
# `../openapi/openapi.json` reference resolves from inside /app.
COPY frontend/ ./
COPY openapi/ ../openapi/

# Now that openapi/openapi.json is in place, run orval explicitly to
# emit `src/api/generated/`. `tsc -b && vite build` depends on it.
RUN pnpm exec orval

RUN pnpm build


FROM nginxinc/nginx-unprivileged:1.27-alpine AS runtime

COPY --from=builder /app/dist /usr/share/nginx/html
COPY frontend/docker/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 8080
