import { spawn, type ChildProcess } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as wait } from 'node:timers/promises'

import { test, expect } from '../src/fixtures/test.ts'
import { randomSignupInput, signupViaApi } from '../src/helpers/signup.ts'

// This spec proves the full slice-5 chain: browser fetch carries a W3C
// `traceparent` header, Tempo returns one trace with spans from both
// `service.name=frontend` and `service.name=backend`, and the Loki log
// line emitted by the backend for the same request carries the same
// `trace.id`. The spec self-skips when the local observability profile
// is not running (no Tempo on :3200), matching the slice-3/4 pattern of
// "fail quietly when the optional stack is down".
//
// Why a separate dev server: the shared e2e harness in `src/setup/`
// runs `vite preview` over a build produced without
// `VITE_OTEL_ENABLED=true`, so the bundle's env gate sees the var as
// undefined and `bootstrapTelemetry` returns early. Vite reads
// `VITE_*` env vars at server-start time, so the cleanest way to opt
// this single spec into telemetry is to start a fresh dev server with
// the env var set. The dev server binds to the canonical Vite dev
// port `5173` (see `TELEMETRY_PORT` below) so the browser's Origin
// is already in the Collector's `cors.allowed_origins` allowlist.

const __dirname = dirname(fileURLToPath(import.meta.url))
const FRONTEND_DIR = resolve(__dirname, '../../frontend')

// `5173` is the canonical Vite dev port — and the only Vite-dev origin
// in the Collector's OTLP/HTTP CORS allowlist (`cors.allowed_origins`
// = [`http://localhost:5173`, `http://localhost:4173`]). Any other
// port would CORS-block the browser's preflight to `:4318/v1/traces`
// and the FE half of the trace would never reach Tempo. The shared
// e2e harness uses `vite preview` on `4173`, so `5173` is free at
// e2e-test time. `--strictPort` (passed below) is the intentional
// fail-fast for the unlikely case where a developer's own `vite dev`
// already binds the port — much louder than silently picking a
// fallback that would land us back in the CORS-blocked state.
//
// The host MUST be `localhost`, not `127.0.0.1`: CORS treats
// `http://localhost:5173` and `http://127.0.0.1:5173` as distinct
// origins, and only the former is in the Collector's allowlist.
// Both the bind (`--host localhost`) and the navigation URL below
// use `localhost` so the browser's Origin header matches the
// allowlist exactly.
const TELEMETRY_PORT = 5173
const TELEMETRY_URL = `http://localhost:${TELEMETRY_PORT}`
const TEMPO_BASE_URL = 'http://localhost:3200'
const LOKI_BASE_URL = 'http://localhost:3100'

const TEMPO_READY_TIMEOUT_MS = 2_000
const DEV_SERVER_READY_TIMEOUT_MS = 30_000
const TEMPO_POLL_BUDGET_MS = 30_000
const TEMPO_POLL_INTERVAL_MS = 1_000
const LOKI_POLL_BUDGET_MS = 30_000
const LOKI_POLL_INTERVAL_MS = 1_000

let tempoReachable = false
let viteProcess: ChildProcess | undefined

async function probeTempoReady(): Promise<boolean> {
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), TEMPO_READY_TIMEOUT_MS)
    const res = await fetch(`${TEMPO_BASE_URL}/ready`, { signal: ctrl.signal })
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
        // Reduce the batch span processor's flush interval so spans
        // reach Tempo within the spec's 30-second poll budget.
        VITE_OTEL_BATCH_DELAY_MS: '200',
      },
    },
  )
}

test.describe('observability — frontend trace continuity', () => {
  test.beforeAll(async () => {
    tempoReachable = await probeTempoReady()
    if (!tempoReachable) return

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

  test('browser-emitted trace reaches Tempo and matches the backend log line', async ({
    page,
    apiClient,
  }) => {
    test.skip(!tempoReachable, 'Tempo /ready not reachable on :3200')
    // The Tempo and Loki polls each carry a 30s budget; the UI flow
    // adds another ~10–20s. Playwright's default 30s per-test timeout
    // is far too tight, so opt this spec into a comfortable 2-minute
    // ceiling — large enough that a real ingest stall surfaces as the
    // poll's diagnostic error, not as a generic test-timeout.
    test.setTimeout(120_000)

    const input = randomSignupInput()
    await signupViaApi(apiClient, input)

    // Capture the outbound `traceparent` from the post-composer submit.
    let capturedTraceparent: string | undefined
    page.on('request', (req) => {
      if (req.method() !== 'POST') return
      if (!req.url().includes('/api/v1/posts')) return
      const tp = req.headers()['traceparent']
      if (tp) capturedTraceparent = tp
    })

    await page.goto(`${TELEMETRY_URL}/login`)
    await page.getByLabel('Email').fill(input.email)
    await page.getByLabel('Password').fill(input.password)
    await page.getByRole('button', { name: 'Log in' }).click()
    await expect(
      page.getByRole('heading', { name: `Hello, ${input.displayName}` }),
    ).toBeVisible()

    const body = `Trace continuity e2e ${Date.now()}`
    await page.getByLabel('Body').fill(body)
    await page.getByRole('button', { name: 'Post', exact: true }).click()
    await expect(page.getByText(body)).toBeVisible()

    expect(capturedTraceparent).toBeDefined()
    expect(capturedTraceparent).toMatch(
      /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/,
    )
    const traceId = capturedTraceparent!.split('-')[1] ?? ''
    expect(traceId).toMatch(/^[0-9a-f]{32}$/)

    // `pollTempoForTrace` exits only when both `service.name=frontend`
    // and `service.name=backend` are visible on the trace, or throws a
    // diagnostic error on budget exhaustion — so no separate
    // `expect(serviceNames).toContain(...)` assertions are needed here.
    await pollTempoForTrace(traceId)

    const lokiTraceId = await pollLokiForTraceId(traceId)
    expect(lokiTraceId).toBe(traceId)
  })
})

interface TempoTraceResponse {
  batches?: Array<{
    resource?: {
      attributes?: Array<{ key: string; value: { stringValue?: string } }>
    }
    scopeSpans?: unknown
  }>
}

async function pollTempoForTrace(traceId: string): Promise<TempoTraceResponse> {
  const deadline = Date.now() + TEMPO_POLL_BUDGET_MS
  const required = ['frontend', 'backend'] as const
  let observed = new Set<string>()
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${TEMPO_BASE_URL}/api/traces/${traceId}`)
      if (res.ok) {
        const body = (await res.json()) as TempoTraceResponse
        observed = new Set(collectResourceServiceNames(body))
        if (required.every((name) => observed.has(name))) return body
      }
    } catch {
      // Swallow and retry — Tempo's ingest path is asynchronous.
    }
    await wait(TEMPO_POLL_INTERVAL_MS)
  }
  const observedList =
    observed.size > 0 ? Array.from(observed).sort().join(', ') : '(none)'
  const missingList = required.filter((name) => !observed.has(name)).join(', ')
  throw new Error(
    `Tempo did not return both required service names for trace ${traceId} within ${TEMPO_POLL_BUDGET_MS}ms. Observed service names: ${observedList}. Missing: ${missingList}.`,
  )
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

interface LokiQueryRangeResponse {
  data?: {
    result?: Array<{ values?: Array<[string, string]> }>
  }
}

async function pollLokiForTraceId(traceId: string): Promise<string | undefined> {
  const deadline = Date.now() + LOKI_POLL_BUDGET_MS
  // The Loki-stored line carries the same trace id in two places (the
  // escaped body JSON and the parsed `attributes` object), with field
  // ordering that the loki exporter does not guarantee. A 32-hex
  // trace id is unique enough that filtering on the literal id —
  // without trying to match surrounding ECS shape — is both reliable
  // and immune to exporter-side field-order changes.
  const query = `{service_name="backend"} |~ \`${traceId}\``
  const params = new URLSearchParams({
    query,
    start: String((Date.now() - 5 * 60_000) * 1_000_000),
    end: String((Date.now() + 60_000) * 1_000_000),
    limit: '5',
    direction: 'BACKWARD',
  })
  while (Date.now() < deadline) {
    try {
      const res = await fetch(
        `${LOKI_BASE_URL}/loki/api/v1/query_range?${params.toString()}`,
      )
      if (res.ok) {
        const body = (await res.json()) as LokiQueryRangeResponse
        for (const stream of body.data?.result ?? []) {
          for (const [, line] of stream.values ?? []) {
            if (line.includes(traceId)) return traceId
          }
        }
      }
    } catch {
      // Swallow and retry — the file appender + filelog receiver are async.
    }
    await wait(LOKI_POLL_INTERVAL_MS)
  }
  return undefined
}
