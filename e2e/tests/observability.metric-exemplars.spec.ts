import { setTimeout as wait } from 'node:timers/promises'

import { test, expect } from '../src/fixtures/test.ts'
import { randomSignupInput, signupViaApi } from '../src/helpers/signup.ts'

// This spec proves the slice-9 chain end-to-end on the wire: a single backend
// `POST /api/v1/posts` records an `http_server_requests_seconds_bucket`
// observation under an OTel-agent-managed span, the OpenMetrics scrape carries
// an exemplar with that span's `trace_id`, Prometheus's exemplar storage
// preserves it through ingestion, and Tempo can resolve the trace id back to
// at least one `service.name=backend` span. That's the wire shape the Grafana
// "click an exemplar diamond → open the trace in Tempo" UX depends on.
//
// The spec self-skips when the obs cluster is not running (Prometheus
// on :9090 or Tempo on :3200 unreachable), matching the slice-3/4/5
// pattern of "fail quietly when the optional stack is down". CI today
// does not bring up the obs cluster alongside the e2e container, so
// this spec skips in CI and runs locally — same behaviour as
// `observability.frontend-traces.spec.ts`.
//
// Slice 22b retargets this spec at the obs cluster: `:9090` (Prometheus)
// and `:3200` (Tempo) reach the obs cluster Services via the Lima
// portForwards declared in `infra/lima/obs.yaml`. The host ports match
// the compose-era values 1:1, so URL constants are unchanged — only
// this header comment is updated.

const PROMETHEUS_BASE_URL = 'http://localhost:9090'
const TEMPO_BASE_URL = 'http://localhost:3200'

const READY_PROBE_TIMEOUT_MS = 2_000
const PROM_POLL_BUDGET_MS = 60_000
const PROM_POLL_INTERVAL_MS = 1_000
const TEMPO_POLL_BUDGET_MS = 30_000
const TEMPO_POLL_INTERVAL_MS = 1_000

let prometheusReachable = false
let tempoReachable = false

async function probeReady(url: string): Promise<boolean> {
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), READY_PROBE_TIMEOUT_MS)
    const res = await fetch(url, { signal: ctrl.signal })
    clearTimeout(timer)
    return res.ok
  } catch {
    return false
  }
}

interface PromExemplarsResponse {
  status?: string
  data?: Array<{
    seriesLabels?: Record<string, string>
    exemplars?: Array<{ labels?: Record<string, string>; value?: string; timestamp?: number }>
  }>
}

async function pollPrometheusForExemplarTraceId(): Promise<string> {
  const deadline = Date.now() + PROM_POLL_BUDGET_MS
  // The Prometheus exemplar API window must include the moment the histogram
  // was observed. A 5-minute window comfortably covers the spec's setup +
  // polling budget without false-matching exemplars from prior test runs (the
  // fresh signup user's POST has a unique trace id either way).
  let lastBody: PromExemplarsResponse | null = null
  while (Date.now() < deadline) {
    const now = Math.floor(Date.now() / 1000)
    const start = now - 300
    const params = new URLSearchParams({
      query: 'http_server_requests_seconds_bucket{uri=~".*/api/v1/posts"}',
      start: String(start),
      end: String(now),
    })
    try {
      const res = await fetch(
        `${PROMETHEUS_BASE_URL}/api/v1/query_exemplars?${params.toString()}`,
      )
      if (res.ok) {
        const body = (await res.json()) as PromExemplarsResponse
        lastBody = body
        for (const series of body.data ?? []) {
          for (const ex of series.exemplars ?? []) {
            const traceId = ex.labels?.trace_id
            if (typeof traceId === 'string' && /^[0-9a-f]{32}$/.test(traceId)) {
              return traceId
            }
          }
        }
      }
    } catch {
      // Swallow and retry — Prometheus's scrape interval is async.
    }
    await wait(PROM_POLL_INTERVAL_MS)
  }
  throw new Error(
    `Prometheus did not surface an exemplar for ` +
      `http_server_requests_seconds_bucket{uri=~".*/api/v1/posts"} within ` +
      `${PROM_POLL_BUDGET_MS}ms. Last response body: ${JSON.stringify(lastBody)}`,
  )
}

interface TempoTraceResponse {
  batches?: Array<{
    resource?: {
      attributes?: Array<{ key: string; value: { stringValue?: string } }>
    }
    scopeSpans?: unknown
  }>
}

function collectResourceServiceNames(trace: TempoTraceResponse): string[] {
  const names = new Set<string>()
  for (const batch of trace.batches ?? []) {
    const attrs = batch.resource?.attributes ?? []
    for (const attr of attrs) {
      if (attr.key === 'service.name' && attr.value.stringValue) {
        names.add(attr.value.stringValue)
      }
    }
  }
  return Array.from(names)
}

async function pollTempoForBackendSpan(traceId: string): Promise<void> {
  const deadline = Date.now() + TEMPO_POLL_BUDGET_MS
  let observed = new Set<string>()
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${TEMPO_BASE_URL}/api/traces/${traceId}`)
      if (res.ok) {
        const body = (await res.json()) as TempoTraceResponse
        observed = new Set(collectResourceServiceNames(body))
        if (observed.has('backend')) return
      }
    } catch {
      // Swallow and retry — Tempo's ingest path is async.
    }
    await wait(TEMPO_POLL_INTERVAL_MS)
  }
  const observedList =
    observed.size > 0 ? Array.from(observed).sort().join(', ') : '(none)'
  throw new Error(
    `Tempo did not return a service.name=backend span for trace ${traceId} ` +
      `within ${TEMPO_POLL_BUDGET_MS}ms. Observed service names: ${observedList}.`,
  )
}

test.describe('observability — metric → trace exemplar pivot', () => {
  test.beforeAll(async () => {
    prometheusReachable = await probeReady(`${PROMETHEUS_BASE_URL}/-/ready`)
    tempoReachable = await probeReady(`${TEMPO_BASE_URL}/ready`)
  })

  test('a backend POST emits an exemplar that resolves to a backend span in Tempo', async ({
    apiClient,
  }) => {
    test.skip(
      !prometheusReachable,
      `Prometheus /-/ready not reachable on ${PROMETHEUS_BASE_URL}`,
    )
    test.skip(!tempoReachable, `Tempo /ready not reachable on ${TEMPO_BASE_URL}`)
    // Prometheus's exemplar poll budget is 60s, Tempo's is 30s, plus the
    // signup+login+post round-trips. Playwright's default 30s per-test ceiling
    // is tighter than the polling worst case, so opt this spec into a
    // 2-minute ceiling — large enough that a real ingest stall surfaces as
    // the poll's diagnostic error, not as a generic test-timeout.
    test.setTimeout(120_000)

    const input = randomSignupInput()
    await signupViaApi(apiClient, input)
    const loginResult = await apiClient.login({
      email: input.email,
      password: input.password,
    })
    expect(loginResult.status).toBe(200)
    const accessToken = (loginResult.body as { accessToken: string }).accessToken

    const postBody = `Metric exemplar e2e ${Date.now()}`
    const createResult = await apiClient.createPost(accessToken, { body: postBody })
    expect(createResult.status).toBe(201)

    const traceId = await pollPrometheusForExemplarTraceId()
    expect(traceId).toMatch(/^[0-9a-f]{32}$/)

    await pollTempoForBackendSpan(traceId)
  })
})
