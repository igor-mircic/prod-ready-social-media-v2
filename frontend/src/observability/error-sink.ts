import { metrics, trace, type Counter } from '@opentelemetry/api'
import { logs, SeverityNumber, type Logger } from '@opentelemetry/api-logs'

import { getCurrentRoute } from './current-route'
import { getCurrentUserId } from './user-context'

export type FrontendErrorKind = 'boundary' | 'error' | 'rejection' | 'csp'

export interface FrontendErrorContext {
  componentStack?: string
  filename?: string
  lineno?: number
  blockedURI?: string
}

// SDK-side PII regex set. Identical strings live in the Collector's
// `attributes/pii_scrub` processor (design Decision 4 — same patterns
// across both layers so the behaviour is auditable in one place).
// `g` flag is required so `String.prototype.replace` substitutes every
// match, not just the first.
export const PII_REGEXES: readonly RegExp[] = [
  // JWT: three dot-separated base64url segments starting with `eyJ`.
  /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
  // Email.
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  // Bearer-token shape: base64 alphabet (incl. `+/=`), 40+ chars. The
  // `+/=` requirement excludes pure hex (e.g. a 40-char commit SHA),
  // which is the conservative-by-design behaviour from design Risk
  // section.
  /\b[A-Za-z0-9+/=]{40,}\b/g,
] as const

export function scrubMessage(input: string | undefined | null): string {
  if (!input) return ''
  let out = String(input)
  for (const re of PII_REGEXES) {
    out = out.replace(re, '[REDACTED]')
  }
  return out
}

export const scrubStack = scrubMessage

type ViteEnv = {
  VITE_FE_ERROR_DEDUP_WINDOW_MS?: string
  VITE_FE_ERROR_RATE_LIMIT?: string
}

const env: ViteEnv = (import.meta as { env?: ViteEnv }).env ?? {}

export const __envForTest: ViteEnv = env

const DEFAULT_DEDUP_WINDOW_MS = 5_000
const DEFAULT_RATE_LIMIT = 30
const RATE_WINDOW_MS = 60_000

function resolveDedupWindowMs(): number {
  const raw = env.VITE_FE_ERROR_DEDUP_WINDOW_MS
  if (!raw) return DEFAULT_DEDUP_WINDOW_MS
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_DEDUP_WINDOW_MS
}

function resolveRateLimit(): number {
  const raw = env.VITE_FE_ERROR_RATE_LIMIT
  if (!raw) return DEFAULT_RATE_LIMIT
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_RATE_LIMIT
}

const dedupMap = new Map<string, number>()
let rateWindowStart = 0
let rateWindowCount = 0

export function __resetErrorSinkStateForTest(): void {
  dedupMap.clear()
  rateWindowStart = 0
  rateWindowCount = 0
  cachedCounter = undefined
  cachedLogger = undefined
}

function tryAcceptEventEmit(fingerprint: string, now: number): boolean {
  const last = dedupMap.get(fingerprint)
  if (last !== undefined && now - last < resolveDedupWindowMs()) {
    return false
  }
  if (now - rateWindowStart >= RATE_WINDOW_MS) {
    rateWindowStart = now
    rateWindowCount = 0
  }
  if (rateWindowCount >= resolveRateLimit()) {
    return false
  }
  dedupMap.set(fingerprint, now)
  rateWindowCount += 1
  return true
}

// Defensive first-stackframe parse. Browser-vendor stack formats vary;
// the fallback when parsing fails is `<type>` alone (design Risk:
// browser stack format → "less precise grouping, not no grouping").
function extractFirstFrame(stack: string | undefined): {
  path: string
  line: string
} | null {
  if (!stack) return null
  const lines = stack.split('\n')
  for (const line of lines) {
    // V8 / Chrome / Node: `    at <fn> (path:LINE:COL)` or `    at path:LINE:COL`.
    const v8 = line.match(/at\s+(?:.+?\s+\()?(.+?):(\d+):\d+\)?$/)
    if (v8) return { path: v8[1], line: v8[2] }
    // Firefox / Safari: `<fn>@path:LINE:COL` or `@path:LINE:COL`.
    const moz = line.match(/@(.+?):(\d+):\d+$/)
    if (moz) return { path: moz[1], line: moz[2] }
  }
  return null
}

export function computeFingerprint(err: unknown): string {
  const type =
    err instanceof Error && err.constructor?.name
      ? err.constructor.name
      : 'Error'
  try {
    if (err instanceof Error) {
      const frame = extractFirstFrame(err.stack)
      if (frame) return `${type}:${frame.path}:${frame.line}`
    }
  } catch {
    // Fall through to the type-only fingerprint.
  }
  return type
}

function toError(value: unknown): Error {
  if (value instanceof Error) return value
  if (typeof value === 'string') return new Error(value)
  try {
    return new Error(JSON.stringify(value))
  } catch {
    return new Error(String(value))
  }
}

let cachedCounter: Counter | undefined
let cachedLogger: Logger | undefined

function getCounter(): Counter {
  if (cachedCounter) return cachedCounter
  cachedCounter = metrics
    .getMeter('frontend')
    .createCounter('frontend_errors_total')
  return cachedCounter
}

function getLogger(): Logger {
  if (cachedLogger) return cachedLogger
  cachedLogger = logs.getLogger('frontend')
  return cachedLogger
}

export function recordFrontendError(
  raw: unknown,
  kind: FrontendErrorKind,
  ctx?: FrontendErrorContext,
): void {
  const err = toError(raw)
  const route = getCurrentRoute()
  const userId = getCurrentUserId()

  // (g) Counter — ALWAYS increments, even when dedup / rate-cap
  // suppress the event-shaped sinks. The counter is the aggregate-
  // accuracy guarantee (design Decision 3 / Requirement: counter
  // unconditional). Label set kept to {kind, route} — fingerprint
  // intentionally not labelled (design Decision 9).
  try {
    getCounter().add(1, { kind, route })
  } catch {
    // Never let an SDK exception bubble out of error capture.
  }

  const fingerprint = computeFingerprint(err)
  const now = Date.now()
  if (!tryAcceptEventEmit(fingerprint, now)) return

  const errorType = err.constructor?.name ?? 'Error'
  const scrubbedMessage = scrubMessage(err.message)
  const scrubbedStack = scrubStack(err.stack)

  // (e) Span event — best-effort. `recordException` is a no-op when
  // there is no active span (slice-5 spec: "Capture succeeds when no
  // span is active" — the log record and counter still fire).
  try {
    const activeSpan = trace.getActiveSpan()
    if (activeSpan) {
      // Pre-scrub message and stack before they hit Tempo. OTel's
      // `recordException` reads `.name`, `.message`, and `.stack` off
      // the Error-shaped argument; pass a synthetic Error rather than
      // mutating the caller's instance.
      const scrubbed = new Error(scrubbedMessage)
      scrubbed.name = errorType
      scrubbed.stack = scrubbedStack
      activeSpan.recordException(scrubbed)
    }
  } catch {
    // Never let the SDK escape.
  }

  // (f) Structured log record — flows through the slice-5/slice-6
  // Collector OTLP/HTTP receiver via the slice-7 logs pipeline to
  // Loki under `event.dataset=frontend.error`.
  try {
    const attributes: Record<string, string | number | boolean> = {
      'event.dataset': 'frontend.error',
      'error.type': errorType,
      'error.message': scrubbedMessage,
      'error.stack_trace': scrubbedStack,
      'error.fingerprint': fingerprint,
      kind,
      route,
    }
    if (userId) attributes['user.id'] = userId
    if (ctx?.componentStack) {
      attributes['error.component_stack'] = scrubStack(ctx.componentStack)
    }
    if (ctx?.filename) attributes['error.filename'] = ctx.filename
    if (typeof ctx?.lineno === 'number') {
      attributes['error.lineno'] = ctx.lineno
    }
    if (ctx?.blockedURI) attributes['csp.blocked_uri'] = ctx.blockedURI

    getLogger().emit({
      severityNumber: SeverityNumber.ERROR,
      severityText: 'ERROR',
      body: scrubbedMessage,
      attributes,
    })
  } catch {
    // Never let the SDK escape.
  }
}
