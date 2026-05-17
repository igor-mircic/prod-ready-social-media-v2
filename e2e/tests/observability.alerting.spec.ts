import { setTimeout as wait } from 'node:timers/promises'
import { randomUUID } from 'node:crypto'

import { test, expect } from '../src/fixtures/test.ts'

// This spec proves the slice-11 alerting wire-shape end-to-end: a synthetic
// alert POSTed to Alertmanager's `/api/v2/alerts` endpoint is routed to the
// correct webhook-sink path by `severity` label, its `runbook_url` annotation
// is preserved through routing, and the BackendDown → SLO inhibition rule
// suppresses SLO firings while BackendDown is also firing.
//
// We POST synthetic alerts rather than driving a real SLO burn because the
// burn-rate rules carry 2m+ `for:` clauses — testing the routing surface
// directly is deterministic and seconds-fast.
//
// Targets the obs cluster (slice 22b retired the compose observability stack).
// `:9093` reaches obs alertmanager via the Lima portForward declared in
// `infra/lima/obs.yaml`; `:8081` reaches the in-cluster webhook-sink Service
// (in-cluster port `:8080`) via the slice-22b remap portForward — see
// design.md Decision 2 for why the asymmetry lives in transport, not the spec.
//
// Self-skips when Alertmanager (`:9093`) or the webhook sink (`:8081`) is
// unreachable, matching the slice-9 pattern from
// `observability.metric-exemplars.spec.ts`.

const ALERTMANAGER_BASE_URL = 'http://localhost:9093'
const WEBHOOK_SINK_BASE_URL = 'http://localhost:8081'

const READY_PROBE_TIMEOUT_MS = 2_000
const POLL_BUDGET_MS = 30_000
const POLL_INTERVAL_MS = 500
// Wait at least one Alertmanager `group_wait` (10s) before the inhibition
// assertion can claim the SLO alert "didn't arrive" — otherwise we'd be
// racing the dispatcher, not the inhibition rule.
const GROUP_WAIT_MS = 10_000
const INHIBITION_OBSERVATION_BUDGET_MS = POLL_BUDGET_MS + GROUP_WAIT_MS

let alertmanagerReachable = false
let webhookSinkReachable = false
let alertmanagerSkipReason = ''
let webhookSinkSkipReason = ''

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

interface SyntheticAlertInput {
  alertname: string
  severity: 'page' | 'ticket'
  slo?: string
  runbookUrl: string
  testTag: string
}

interface AlertmanagerAlertEnvelope {
  labels: Record<string, string>
  annotations: Record<string, string>
  startsAt: string
  // endsAt left unset → Alertmanager auto-extends per its resolve_timeout.
  generatorURL: string
}

function syntheticAlert(input: SyntheticAlertInput): AlertmanagerAlertEnvelope {
  const labels: Record<string, string> = {
    alertname: input.alertname,
    severity: input.severity,
    // testTag lets a parallel session distinguish its payloads from any
    // unrelated noise (the webhook sink's ring is shared per process).
    test_tag: input.testTag,
  }
  if (input.slo) labels.slo = input.slo
  return {
    labels,
    annotations: {
      summary: `synthetic ${input.alertname} for e2e routing test`,
      runbook_url: input.runbookUrl,
    },
    startsAt: new Date().toISOString(),
    generatorURL: `e2e://observability.alerting.spec/${input.testTag}`,
  }
}

async function postAlerts(alerts: AlertmanagerAlertEnvelope[]): Promise<void> {
  const res = await fetch(`${ALERTMANAGER_BASE_URL}/api/v2/alerts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(alerts),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(
      `Alertmanager rejected POST /api/v2/alerts: ${res.status} ${body}`,
    )
  }
}

interface SinkEntry {
  path: 'page' | 'ticket'
  receivedAt: number
  payload: {
    alerts?: Array<{
      labels?: Record<string, string>
      annotations?: Record<string, string>
    }>
  }
}

interface SinkReceivedResponse {
  received: SinkEntry[]
}

async function fetchReceived(after: number): Promise<SinkEntry[]> {
  const url = `${WEBHOOK_SINK_BASE_URL}/received?after=${after}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`webhook-sink GET /received: ${res.status}`)
  const body = (await res.json()) as SinkReceivedResponse
  return body.received
}

function matchesTestTag(entry: SinkEntry, testTag: string): boolean {
  return (entry.payload.alerts ?? []).some(
    (a) => a.labels?.test_tag === testTag,
  )
}

async function pollForPayloadOnPath(
  testTag: string,
  expectedPath: 'page' | 'ticket',
  after: number,
): Promise<SinkEntry> {
  const deadline = Date.now() + POLL_BUDGET_MS
  let lastObserved: SinkEntry[] = []
  while (Date.now() < deadline) {
    try {
      const entries = await fetchReceived(after)
      lastObserved = entries
      const hit = entries.find(
        (e) => e.path === expectedPath && matchesTestTag(e, testTag),
      )
      if (hit) return hit
    } catch {
      // Swallow and retry — Alertmanager's dispatcher is async.
    }
    await wait(POLL_INTERVAL_MS)
  }
  throw new Error(
    `webhook-sink never received an alert tagged ${testTag} on ${expectedPath} within ${POLL_BUDGET_MS}ms.` +
      ` Observed: ${JSON.stringify(lastObserved)}`,
  )
}

async function entriesForTag(
  testTag: string,
  after: number,
): Promise<SinkEntry[]> {
  const entries = await fetchReceived(after)
  return entries.filter((e) => matchesTestTag(e, testTag))
}

test.describe('observability — alerting routing and inhibition', () => {
  test.beforeAll(async () => {
    alertmanagerReachable = await probeReady(`${ALERTMANAGER_BASE_URL}/-/ready`)
    if (!alertmanagerReachable) {
      alertmanagerSkipReason = `Alertmanager /-/ready not reachable on ${ALERTMANAGER_BASE_URL}`
    }
    webhookSinkReachable = await probeReady(`${WEBHOOK_SINK_BASE_URL}/healthz`)
    if (!webhookSinkReachable) {
      webhookSinkSkipReason = `webhook-sink /healthz not reachable on ${WEBHOOK_SINK_BASE_URL}`
    }
  })

  test('page-severity alert routes to /page with runbook_url preserved', async () => {
    test.skip(!alertmanagerReachable, alertmanagerSkipReason)
    test.skip(!webhookSinkReachable, webhookSinkSkipReason)
    test.setTimeout(120_000)

    const testTag = `page-${randomUUID()}`
    const runbookUrl =
      'https://github.com/igor-mircic/prod-ready-social-media-v2/blob/main/infra/runbooks/ApiAvailabilityFastBurn.md'
    const testStart = Date.now()
    await postAlerts([
      syntheticAlert({
        alertname: 'ApiAvailabilityFastBurn',
        severity: 'page',
        slo: 'api_availability',
        runbookUrl,
        testTag,
      }),
    ])

    const entry = await pollForPayloadOnPath(testTag, 'page', testStart)
    const matchedAlert = (entry.payload.alerts ?? []).find(
      (a) => a.labels?.test_tag === testTag,
    )
    expect(matchedAlert?.annotations?.runbook_url).toBe(runbookUrl)
  })

  test('ticket-severity alert routes to /ticket and never reaches /page', async () => {
    test.skip(!alertmanagerReachable, alertmanagerSkipReason)
    test.skip(!webhookSinkReachable, webhookSinkSkipReason)
    test.setTimeout(120_000)

    const testTag = `ticket-${randomUUID()}`
    const runbookUrl =
      'https://github.com/igor-mircic/prod-ready-social-media-v2/blob/main/infra/runbooks/ApiAvailabilityBudgetBurn.md'
    const testStart = Date.now()
    await postAlerts([
      syntheticAlert({
        alertname: 'ApiAvailabilityBudgetBurn',
        severity: 'ticket',
        slo: 'api_availability',
        runbookUrl,
        testTag,
      }),
    ])

    const entry = await pollForPayloadOnPath(testTag, 'ticket', testStart)
    const matchedAlert = (entry.payload.alerts ?? []).find(
      (a) => a.labels?.test_tag === testTag,
    )
    expect(matchedAlert?.annotations?.runbook_url).toBe(runbookUrl)

    const allForTag = await entriesForTag(testTag, testStart)
    const pageEntries = allForTag.filter((e) => e.path === 'page')
    expect(pageEntries).toEqual([])
  })

  test('BackendDown inhibits an ApiAvailabilityFastBurn firing in the same group', async () => {
    test.skip(!alertmanagerReachable, alertmanagerSkipReason)
    test.skip(!webhookSinkReachable, webhookSinkSkipReason)
    test.setTimeout(120_000)

    const testTag = `inhibit-${randomUUID()}`
    const backendDownRunbook =
      'https://github.com/igor-mircic/prod-ready-social-media-v2/blob/main/infra/runbooks/BackendDown.md'
    const apiRunbook =
      'https://github.com/igor-mircic/prod-ready-social-media-v2/blob/main/infra/runbooks/ApiAvailabilityFastBurn.md'
    const testStart = Date.now()
    await postAlerts([
      syntheticAlert({
        alertname: 'BackendDown',
        severity: 'page',
        runbookUrl: backendDownRunbook,
        testTag,
      }),
      syntheticAlert({
        alertname: 'ApiAvailabilityFastBurn',
        severity: 'page',
        slo: 'api_availability',
        runbookUrl: apiRunbook,
        testTag,
      }),
    ])

    // Allow at least one full group_wait so the dispatcher has had its
    // chance to deliver both groups (BackendDown + ApiAvailabilityFastBurn
    // are different `alertname`s → different groups under `group_by:
    // [alertname, slo]`).
    const deadline = Date.now() + INHIBITION_OBSERVATION_BUDGET_MS
    let observedBackendDown = false
    let observedApiAlert = false
    while (Date.now() < deadline) {
      const entries = await entriesForTag(testTag, testStart)
      for (const entry of entries) {
        for (const alert of entry.payload.alerts ?? []) {
          if (alert.labels?.alertname === 'BackendDown') observedBackendDown = true
          if (alert.labels?.alertname === 'ApiAvailabilityFastBurn')
            observedApiAlert = true
        }
      }
      if (observedBackendDown && Date.now() - testStart >= GROUP_WAIT_MS) break
      await wait(POLL_INTERVAL_MS)
    }
    expect(observedBackendDown).toBe(true)
    expect(observedApiAlert).toBe(false)
  })
})
