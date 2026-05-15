# Slice 15 (add-local-k3s-backend): post-build agent-bake layer.
#
# This Dockerfile is consumed by Gradle's `bakeBackendImage` task,
# which copies it into `build/docker-bake/agent/` alongside a freshly
# resolved `opentelemetry-javaagent.jar` and runs `docker build`
# against that context. The base image is whatever
# `./gradlew bootBuildImage` produced — the Paketo-buildpacks output
# tagged `<imageName>-base`. This layer adds two things:
#
#   1. The OpenTelemetry Java agent JAR at a stable, documented path
#      (`/workspace/agent/opentelemetry-javaagent.jar`) so the
#      kubernetes Deployment manifest can reference the path without
#      consulting the buildpack's internal layout.
#   2. A `JAVA_TOOL_OPTIONS=-javaagent:<path>` environment entry so
#      the agent attaches at JVM startup. The Paketo buildpacks
#      already append their own JVM tunings to JAVA_TOOL_OPTIONS at
#      launch via a profile.d script; the JVM treats multiple
#      `-javaagent:` arguments independently, so this attach
#      coexists with whatever Paketo appends — same mechanic as the
#      host `./gradlew bootRun` loop and the e2e harness, which is
#      the whole point of slice 15 (preserve the agent attach
#      pattern across host / e2e / in-cluster).
#
# This bake is deliberately a separate Docker layer rather than a
# buildpack binding because (a) the buildpack-binding path involves
# learning Paketo's `BPL_*` / `BPE_*` metadata surface which is
# poorly documented compared to a 2-line Dockerfile, and (b) the
# slice's design.md captured this lean explicitly.
#
# BuildKit feature requirements: `COPY --chmod=` requires BuildKit
# (Docker 23+ on Apple Silicon ships with BuildKit-by-default; the
# Gradle task does not pass `DOCKER_BUILDKIT=` explicitly, so a
# pre-Docker-23 daemon would need it set in its environment).

ARG BASE_IMAGE
FROM ${BASE_IMAGE}

# COPY without `--chmod`: BuildKit's `--chmod=` also applies to intermediate
# directories it creates, which would leave `/workspace/agent/` at mode 0644
# and block the JVM (running as the Paketo `cnb` user) from traversing into
# it. Plain COPY leaves intermediate dirs at 0755 and the file at its source
# mode (0644 from Gradle's Sync) — both correct. The Paketo base image is
# distroless (no `/bin/sh`), so we cannot RUN chmod / mkdir steps either;
# this COPY-only approach is the only viable mechanism here.
COPY opentelemetry-javaagent.jar /workspace/agent/opentelemetry-javaagent.jar

ENV JAVA_TOOL_OPTIONS="-javaagent:/workspace/agent/opentelemetry-javaagent.jar"
