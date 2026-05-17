import { spawn, type ChildProcess } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as wait } from 'node:timers/promises'

import { test, expect } from '../src/fixtures/test.ts'
import { randomSignupInput, signupViaApi } from '../src/helpers/signup.ts'

// This spec proves the slice-6 chain end-to-end: a browser running
// with metrics enabled emits Web Vitals + route-timing OTLP metrics
// to the in-cluster collector via the FE pod's same-origin nginx
// proxy (slice 18c), the app collector forwards them to the obs
// cluster's prometheus via OTLP/HTTP (slice 22b dropped the compose-
// relay leg), and a Prometheus query against the obs prom returns
// non-empty data for the FE-emitted series.
//
// Slice 22b retired the compose collector's host-side `:8889`
// Prometheus-format exposition (design.md Decision 3). The obs
// collector does NOT expose a host-reachable `/metrics` endpoint —
// adding one would invert the push-only data plane this arc commits
// to. So this spec asserts only against obs prometheus on `:9090`
// (Lima portForward) and accepts the ~15 s scrape-interval cost.
//
// The spec self-skips when obs prometheus is unreachable, mirroring
// the slice-5 pattern of "fail quietly when the optional
// observability stack is down". This keeps the e2e suite green on
// a developer machine that has the backend up but the obs cluster
// not running.
//
// Telemetry-enabled dev server: same shape as the slice-5 traces
// spec — the shared e2e harness's `vite preview` was built without
// `VITE_OTEL_ENABLED=true`, so the metrics SDK gate stays off there.
// We start a dedicated `vite dev` on port 5173 with the env var
// set so the browser session in this spec produces real OTLP
// metric exports.

const __dirname = dirname(fileURLToPath(import.meta.url))
const FRONTEND_DIR = resolve(__dirname, '../../frontend')

const TELEMETRY_PORT = 5173
const TELEMETRY_URL = `http://localhost:${TELEMETRY_PORT}`
const PROMETHEUS_BASE_URL = 'http://localhost:9090'

const PROBE_TIMEOUT_MS = 2_000
const DEV_SERVER_READY_TIMEOUT_MS = 30_000
// One full SDK export interval (15 s default; we override to 2 s
// below) plus one full prom scrape interval (15 s) plus headroom
// for the remote-write round-trip. 60 s is enough that a slow CI
// host surfaces as a diagnostic timeout, not a silent skip.
const PROM_POLL_BUDGET_MS = 60_000
const PROM_POLL_INTERVAL_MS = 1_000
// Force a faster export cadence than the SDK default (15 s) so the
// spec's polling budget is not dominated by waiting for the very
// first export tick. 2 s mirrors the slice-5 trace-spec's batch-delay
// override.
const EXPORT_INTERVAL_MS_OVERRIDE = '2000'

let observabilityReachable = false
let viteProcess: ChildProcess | undefined

async function probeReachable(url: string): Promise<boolean> {
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS)
    const res = await fetch(url, { signal: ctrl.signal })
    clearTimeout(timer)
    return res.ok
  } catch {
    return false
  }
}

async function waitForDevServerReady(url: string): Promise<void> {
  const deadline = Date.now() + DEV_SERVER_READY_TIMEOUT_MS
  let lastError: unknown = null
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      if (res.ok || res.status === 304) return
    } catch (err) {
      lastError = err
    }
    await wait(250)
  }
  throw new Error(
    `Telemetry-enabled vite dev server did not respond at ${url} within ${DEV_SERVER_READY_TIMEOUT_MS}ms. Last error: ${String(lastError)}`,
  )
}

function startTelemetryEnabledDevServer(): ChildProcess {
  return spawn(
    'pnpm',
    [
      '--dir',
      FRONTEND_DIR,
      'exec',
      'vite',
      '--port',
      String(TELEMETRY_PORT),
      '--host',
      'localhost',
      '--strictPort',
    ],
    {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: {
        ...process.env,
        VITE_OTEL_ENABLED: 'true',
        VITE_OTEL_METRICS_EXPORT_INTERVAL_MS: EXPORT_INTERVAL_MS_OVERRIDE,
        // Reduce trace batch delay too — the slice-5 trace path runs
        // alongside this spec on the same dev server.
        VITE_OTEL_BATCH_DELAY_MS: '200',
      },
    },
  )
}

interface PromQueryResponse {
  data?: { result?: unknown[] }
}

interface PromQuerySample {
  metric?: Record<string, string>
}

async function pollPrometheusForNonEmpty(
  query: string,
): Promise<PromQuerySample[]> {
  const deadline = Date.now() + PROM_POLL_BUDGET_MS
  const url = `${PROMETHEUS_BASE_URL}/api/v1/query?query=${encodeURIComponent(query)}`
  let lastResultCount: number | undefined
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      if (res.ok) {
        const body = (await res.json()) as PromQueryResponse
        const result = body.data?.result
        if (Array.isArray(result)) {
          lastResultCount = result.length
          if (result.length > 0) return result as PromQuerySample[]
        }
      }
    } catch {
      // Swallow and retry.
    }
    await wait(PROM_POLL_INTERVAL_MS)
  }
  throw new Error(
    `Prometheus query \`${query}\` returned no samples within ${PROM_POLL_BUDGET_MS}ms (last result.length: ${String(lastResultCount)}).`,
  )
}

test.describe('observability — frontend RUM metrics pipeline', () => {
  test.beforeAll(async () => {
    observabilityReachable = await probeReachable(
      `${PROMETHEUS_BASE_URL}/-/healthy`,
    )
    if (!observabilityReachable) return

    viteProcess = startTelemetryEnabledDevServer()
    viteProcess.on('error', (err) => {
      throw err
    })
    await waitForDevServerReady(TELEMETRY_URL)
  })

  test.afterAll(async () => {
    if (!viteProcess || viteProcess.exitCode !== null) return
    viteProcess.kill('SIGTERM')
    await new Promise<void>((resolveExit) => {
      const killTimer = setTimeout(() => {
        viteProcess?.kill('SIGKILL')
      }, 5_000)
      viteProcess?.once('exit', () => {
        clearTimeout(killTimer)
        resolveExit()
      })
    })
  })

  test('FE Web Vitals and route timing reach the Collector and Prometheus', async ({
    page,
    apiClient,
  }) => {
    test.skip(
      !observabilityReachable,
      'Obs cluster not up (Prometheus /-/healthy unreachable on :9090)',
    )
    // Polls + UI flow + 30 s ingest window — the default 30 s
    // per-test timeout is far too tight. 3 minutes leaves headroom
    // for a slow CI host without masking real ingest stalls.
    test.setTimeout(180_000)

    const input = randomSignupInput()
    const user = await signupViaApi(apiClient, input)

    await page.goto(`${TELEMETRY_URL}/login`)
    await page.getByLabel('Email').fill(input.email)
    await page.getByLabel('Password').fill(input.password)
    await page.getByRole('button', { name: 'Log in' }).click()
    await expect(
      page.getByRole('heading', { name: `Hello, ${input.displayName}` }),
    ).toBeVisible()

    // /home → /users/{seededId} → /home gives the route-timing
    // observer two pathname-change events to record. The userId is the
    // freshly seeded user's id, so the resolved pathname carries a
    // UUID-shaped segment that MUST NOT leak into the `route` label
    // (the assertion below checks for the template form).
    await page.goto(`${TELEMETRY_URL}/users/${user.id}`)
    await expect(page).toHaveURL(new RegExp(`/users/${user.id}$`))

    await page.goto(`${TELEMETRY_URL}/home`)
    await expect(
      page.getByRole('heading', { name: `Hello, ${input.displayName}` }),
    ).toBeVisible()

    // Trigger a visibilitychange to force-flush the metric exporter.
    // The bootstrapMetrics() listener calls provider.forceFlush() on
    // visibility hide; this short-circuits the wait for the periodic
    // reader's next 2 s tick.
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', {
        value: 'hidden',
        configurable: true,
      })
      document.dispatchEvent(new Event('visibilitychange'))
    })

    // The full chain: FE Web Vitals + route timing emitted by the
    // browser must reach obs prometheus via the FE-pod nginx →
    // app-cluster collector → obs collector → obs prom path. The
    // `web_vitals_lcp_bucket` query proves the Web Vitals path; the
    // `route_change_duration_ms_bucket{route="/users/:userId"}` query
    // proves the route-timing path AND the template-label cardinality
    // control (the seeded user id MUST NOT leak into the `route`
    // label).
    await pollPrometheusForNonEmpty(
      'web_vitals_lcp_bucket{service_name="frontend"}',
    )
    const routeSamples = await pollPrometheusForNonEmpty(
      'route_change_duration_ms_bucket{service_name="frontend",route="/users/:userId"}',
    )

    // Defence-in-depth: no sample's `route` label may carry the seeded
    // user id verbatim. The template-only label is the cardinality
    // guarantee we are paying for; if it ever leaks we want a loud
    // signal here rather than a slow-growing cardinality regression
    // in prom.
    for (const sample of routeSamples) {
      expect(sample.metric?.route ?? '').not.toBe(`/users/${user.id}`)
    }
  })
})
