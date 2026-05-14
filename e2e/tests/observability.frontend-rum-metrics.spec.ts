import { spawn, type ChildProcess } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as wait } from 'node:timers/promises'

import { test, expect } from '../src/fixtures/test.ts'
import { randomSignupInput, signupViaApi } from '../src/helpers/signup.ts'

// This spec proves the slice-6 chain: a browser running with metrics
// enabled emits Web Vitals + route-timing OTLP metrics to the
// Collector at `:4318/v1/metrics`; the Collector exposes them as
// Prometheus text-exposition on `:8889/metrics`; Prometheus's
// `collector` scrape job reads them; a Prometheus query returns
// non-empty data for the FE-emitted series.
//
// The spec self-skips when either the Collector exporter or the
// Prometheus API is unreachable, mirroring the slice-5 pattern of
// "fail quietly when the optional observability stack is down". This
// keeps the e2e suite green on a developer machine that has the
// backend up but the observability profile down.
//
// Telemetry-enabled dev server: same shape as the slice-5 traces
// spec — the shared e2e harness's `vite preview` was built without
// `VITE_OTEL_ENABLED=true`, so the metrics SDK gate stays off there.
// We start a dedicated `vite dev` on port 5173 (the only Vite-dev
// origin in the Collector's CORS allowlist) with the env var set, so
// the browser session in this spec produces real OTLP metric exports.

const __dirname = dirname(fileURLToPath(import.meta.url))
const FRONTEND_DIR = resolve(__dirname, '../../frontend')

const TELEMETRY_PORT = 5173
const TELEMETRY_URL = `http://localhost:${TELEMETRY_PORT}`
const COLLECTOR_PROM_URL = 'http://localhost:8889/metrics'
const PROMETHEUS_BASE_URL = 'http://localhost:9090'

const PROBE_TIMEOUT_MS = 2_000
const DEV_SERVER_READY_TIMEOUT_MS = 30_000
// One full export interval (15 s) + one full scrape interval (15 s)
// gives Prometheus a guaranteed window to ingest at least one
// FE-emitted sample. We bound the assertion polls at this budget so
// flake on a slow CI host surfaces as a diagnostic timeout, not a
// silent skip.
const COLLECTOR_POLL_BUDGET_MS = 45_000
const COLLECTOR_POLL_INTERVAL_MS = 1_000
const PROM_POLL_BUDGET_MS = 45_000
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

async function pollCollectorMetricsBody(
  predicate: (body: string) => boolean,
): Promise<string> {
  const deadline = Date.now() + COLLECTOR_POLL_BUDGET_MS
  let lastBody = ''
  while (Date.now() < deadline) {
    try {
      const res = await fetch(COLLECTOR_PROM_URL)
      if (res.ok) {
        lastBody = await res.text()
        if (predicate(lastBody)) return lastBody
      }
    } catch {
      // Swallow and retry; the Collector's batch is asynchronous.
    }
    await wait(COLLECTOR_POLL_INTERVAL_MS)
  }
  throw new Error(
    `Collector /metrics never matched the required predicate within ${COLLECTOR_POLL_BUDGET_MS}ms. Last body length: ${lastBody.length}`,
  )
}

interface PromQueryResponse {
  data?: { result?: unknown[] }
}

async function pollPrometheusForNonEmpty(query: string): Promise<void> {
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
          if (result.length > 0) return
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
    const [collectorOk, promOk] = await Promise.all([
      probeReachable(COLLECTOR_PROM_URL),
      probeReachable(`${PROMETHEUS_BASE_URL}/-/healthy`),
    ])
    observabilityReachable = collectorOk && promOk
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
      'Observability profile not up (Collector :8889/metrics or Prometheus /-/healthy unreachable)',
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

    // Poll the Collector's Prometheus exporter for the first FE
    // Web Vital line. LCP is reported once per page load by `web-
    // vitals`, after the largest contentful paint candidate is final.
    const collectorBody = await pollCollectorMetricsBody((body) => {
      return /^web_vitals_lcp_bucket\{[^}]*service_name="frontend"/m.test(body)
    })

    expect(collectorBody).toMatch(
      /^web_vitals_lcp_bucket\{[^}]*service_name="frontend"/m,
    )

    // The route-timing histogram must carry both `service_name=
    // "frontend"` AND a route label whose value is a route template
    // — never a resolved user id. The match accepts `/home` or
    // `/users/:userId` (the only two route templates the spec walks
    // through after the initial /login → /home redirect).
    const routeLineRegex =
      /^route_change_duration_ms_bucket\{[^}]*service_name="frontend"[^}]*route="(\/home|\/users\/:userId)"/m
    expect(collectorBody).toMatch(routeLineRegex)
    // Defence-in-depth: assert no line carries the seeded user id
    // verbatim — the template-only label is the cardinality guarantee
    // we are paying for.
    expect(collectorBody).not.toContain(`route="/users/${user.id}"`)

    // The full chain: same series should reach Prometheus after one
    // scrape cycle. The `web_vitals_lcp_bucket` query proves the
    // Web Vitals path; the `route_change_duration_ms_bucket{route=
    // "/users/:userId"}` query proves the route-timing path AND the
    // template-label cardinality control.
    await pollPrometheusForNonEmpty(
      'web_vitals_lcp_bucket{service_name="frontend"}',
    )
    await pollPrometheusForNonEmpty(
      'route_change_duration_ms_bucket{service_name="frontend",route="/users/:userId"}',
    )
  })
})
