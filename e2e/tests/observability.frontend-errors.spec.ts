import { spawn, type ChildProcess } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as wait } from 'node:timers/promises'

import { test, expect } from '../src/fixtures/test.ts'
import { randomSignupInput, signupViaApi } from '../src/helpers/signup.ts'

// This spec proves the slice-7 chain end-to-end: a browser running with
// telemetry + error reporting enabled navigates to the dev-only
// `/__dev/throw` route, the React error boundary catches the thrown
// `Error` (whose message embeds a JWT-shaped substring), and the
// captured error reaches all three sinks via the Collector:
//
//   - Collector `/metrics` (Prometheus exposition) — the
//     `frontend_errors_total{kind="boundary"}` counter increments.
//   - Loki `/loki/api/v1/query_range` — one log line under
//     `{event_dataset="frontend.error"}` with `error.type=Error`.
//   - Tempo `/api/search` — one trace with a `service.name=frontend`
//     span carrying an `exception` event.
//
// PII: the asserted log line and span event MUST contain `[REDACTED]`
// and MUST NOT contain the original JWT substring (defence-in-depth
// scrub: SDK-side regex strip + Collector OTTL replace_pattern).
//
// The spec self-skips when any of Collector / Loki / Tempo APIs are
// unreachable, mirroring the slice-5 and slice-6 patterns.

const __dirname = dirname(fileURLToPath(import.meta.url))
const FRONTEND_DIR = resolve(__dirname, '../../frontend')

// 5173 is the only Vite-dev origin in the Collector's CORS allowlist.
// `--host localhost` matches the allowlist exactly (CORS treats
// localhost and 127.0.0.1 as distinct origins).
const TELEMETRY_PORT = 5173
const TELEMETRY_URL = `http://localhost:${TELEMETRY_PORT}`
const COLLECTOR_PROM_URL = 'http://localhost:8889/metrics'
const LOKI_BASE_URL = 'http://localhost:3100'
const TEMPO_BASE_URL = 'http://localhost:3200'

const PROBE_TIMEOUT_MS = 2_000
const DEV_SERVER_READY_TIMEOUT_MS = 30_000
const POLL_BUDGET_MS = 45_000
const POLL_INTERVAL_MS = 1_000

// Match the JWT substring the dev component throws (see
// frontend/src/App.tsx — `ThrowOnMount`). Keep this string identical
// to the literal in the throw — if they drift, this spec's PII
// assertion no longer proves redaction.
const THROWN_JWT_SUBSTRING =
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJkZXYifQ.signaturesegment'

// Speed up the logs SDK's BatchLogRecordProcessor default schedule
// delay (5 s) so the log record reaches the Collector within the
// spec's poll budget.
const LOGS_SCHEDULE_DELAY_MS = '500'

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
        VITE_OTEL_BATCH_DELAY_MS: '200',
        VITE_OTEL_METRICS_EXPORT_INTERVAL_MS: '2000',
        VITE_OTEL_LOGS_SCHEDULE_DELAY_MS: LOGS_SCHEDULE_DELAY_MS,
      },
    },
  )
}

async function pollUntil<T>(
  fn: () => Promise<T | undefined>,
  diagnosticLabel: string,
): Promise<T> {
  const deadline = Date.now() + POLL_BUDGET_MS
  while (Date.now() < deadline) {
    try {
      const result = await fn()
      if (result !== undefined) return result
    } catch {
      // Swallow and retry; downstream pipelines are asynchronous.
    }
    await wait(POLL_INTERVAL_MS)
  }
  throw new Error(`${diagnosticLabel} did not satisfy within ${POLL_BUDGET_MS}ms.`)
}

async function pollCollectorMetricsBody(
  predicate: (body: string) => boolean,
  label: string,
): Promise<string> {
  return pollUntil(async () => {
    const res = await fetch(COLLECTOR_PROM_URL)
    if (!res.ok) return undefined
    const body = await res.text()
    return predicate(body) ? body : undefined
  }, label)
}

interface LokiQueryRangeResponse {
  data?: {
    result?: Array<{ values?: Array<[string, string]> }>
  }
}

async function pollLokiForFrontendError(): Promise<string> {
  const query = '{event_dataset="frontend.error"}'
  return pollUntil(async () => {
    const params = new URLSearchParams({
      query,
      start: String((Date.now() - 5 * 60_000) * 1_000_000),
      end: String((Date.now() + 60_000) * 1_000_000),
      limit: '50',
      direction: 'BACKWARD',
    })
    const res = await fetch(
      `${LOKI_BASE_URL}/loki/api/v1/query_range?${params.toString()}`,
    )
    if (!res.ok) return undefined
    const body = (await res.json()) as LokiQueryRangeResponse
    for (const stream of body.data?.result ?? []) {
      for (const [, line] of stream.values ?? []) {
        // The Loki line is the JSON-serialised log record. Look for the
        // canonical `error.type` attribute the SDK emits.
        if (line.includes('"error.type"') || line.includes('error_type')) {
          return line
        }
      }
    }
    return undefined
  }, 'Loki frontend.error query')
}

interface TempoSearchResponse {
  traces?: Array<{ traceID?: string }>
}

interface TempoTraceResponse {
  batches?: Array<{
    resource?: {
      attributes?: Array<{ key: string; value: { stringValue?: string } }>
    }
    scopeSpans?: Array<{
      spans?: Array<{
        events?: Array<{
          name?: string
          attributes?: Array<{
            key: string
            value: { stringValue?: string }
          }>
        }>
      }>
    }>
  }>
}

interface ExceptionEvent {
  type: string
  message: string
  stack: string
  raw: string
}

async function pollTempoForFrontendException(): Promise<ExceptionEvent> {
  const searchUrl = `${TEMPO_BASE_URL}/api/search?tags=${encodeURIComponent('service.name=frontend')}&limit=20`
  return pollUntil(async () => {
    const res = await fetch(searchUrl)
    if (!res.ok) return undefined
    const body = (await res.json()) as TempoSearchResponse
    for (const trace of body.traces ?? []) {
      if (!trace.traceID) continue
      const traceRes = await fetch(`${TEMPO_BASE_URL}/api/traces/${trace.traceID}`)
      if (!traceRes.ok) continue
      const traceBody = (await traceRes.json()) as TempoTraceResponse
      for (const batch of traceBody.batches ?? []) {
        for (const scope of batch.scopeSpans ?? []) {
          for (const span of scope.spans ?? []) {
            for (const event of span.events ?? []) {
              if (event.name !== 'exception') continue
              const attrs = Object.fromEntries(
                (event.attributes ?? []).map((a) => [
                  a.key,
                  a.value.stringValue ?? '',
                ]),
              )
              return {
                type: attrs['exception.type'] ?? '',
                message: attrs['exception.message'] ?? '',
                stack: attrs['exception.stacktrace'] ?? '',
                raw: JSON.stringify(event),
              }
            }
          }
        }
      }
    }
    return undefined
  }, 'Tempo frontend exception event')
}

test.describe('observability — frontend errors pipeline', () => {
  test.beforeAll(async () => {
    const [collectorOk, lokiOk, tempoOk] = await Promise.all([
      probeReachable(COLLECTOR_PROM_URL),
      probeReachable(`${LOKI_BASE_URL}/ready`),
      probeReachable(`${TEMPO_BASE_URL}/ready`),
    ])
    observabilityReachable = collectorOk && lokiOk && tempoOk
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

  test('captured FE error reaches counter, Loki, and Tempo with PII redacted', async ({
    page,
    apiClient,
  }) => {
    test.skip(
      !observabilityReachable,
      'Observability profile not up (Collector :8889/metrics, Loki /ready, or Tempo /ready unreachable)',
    )
    test.setTimeout(180_000)

    const input = randomSignupInput()
    await signupViaApi(apiClient, input)

    await page.goto(`${TELEMETRY_URL}/login`)
    await page.getByLabel('Email').fill(input.email)
    await page.getByLabel('Password').fill(input.password)
    await page.getByRole('button', { name: 'Log in' }).click()
    await expect(
      page.getByRole('heading', { name: `Hello, ${input.displayName}` }),
    ).toBeVisible()

    // Navigate to the dev-only throw route. The React boundary
    // catches the thrown TypeError and renders the fallback UI.
    await page.goto(`${TELEMETRY_URL}/__dev/throw`)
    await expect(
      page.getByRole('heading', { name: /Something went wrong/i }),
    ).toBeVisible()

    // Force a visibilitychange so the metrics provider flushes
    // immediately — the boundary path emits a counter increment on
    // capture but the periodic reader still waits for its tick.
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', {
        value: 'hidden',
        configurable: true,
      })
      document.dispatchEvent(new Event('visibilitychange'))
    })

    // Counter sink — Collector Prometheus exposition.
    const collectorBody = await pollCollectorMetricsBody(
      (body) =>
        /^frontend_errors_total\{[^}]*kind="boundary"[^}]*\}\s+[1-9]/m.test(
          body,
        ),
      'frontend_errors_total{kind="boundary"} >= 1',
    )
    expect(collectorBody).toMatch(
      /^frontend_errors_total\{[^}]*kind="boundary"[^}]*\}\s+[1-9]/m,
    )

    // Log sink — Loki query under the FE error dataset.
    const lokiLine = await pollLokiForFrontendError()
    // The line is JSON; assert the canonical class name landed in
    // `error.type` (the SDK uses `err.constructor.name`).
    expect(lokiLine).toContain('"error.type"')
    // PII assertion: the SDK-side scrub already redacted the JWT, so
    // the original substring must NOT appear in the line, and the
    // `[REDACTED]` token MUST appear.
    expect(lokiLine).not.toContain(THROWN_JWT_SUBSTRING)
    expect(lokiLine).toContain('[REDACTED]')

    // Trace sink — Tempo exception event on a frontend span.
    const exceptionEvent = await pollTempoForFrontendException()
    expect(exceptionEvent.type).toBe('Error')
    expect(exceptionEvent.raw).not.toContain(THROWN_JWT_SUBSTRING)
    expect(exceptionEvent.message).toContain('[REDACTED]')
  })
})
