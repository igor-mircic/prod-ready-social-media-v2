import { recordFrontendError } from './error-sink'

// Registers the three non-React error capture surfaces: synchronous
// uncaught `error` events, unhandled promise `rejection` events, and
// `securitypolicyviolation` events. The React-boundary path is wired
// separately by `<FrontendErrorBoundary>` in `ErrorBoundary.tsx`.
//
// Idempotency: the handler set is process-wide; calling this twice
// would double-fire every captured error. The flag below guards
// against accidental re-registration if `bootstrapErrorReporting`
// runs more than once (e.g., StrictMode mounting in dev).

type Listener = { type: string; handler: EventListener }

let installed = false
let registered: Listener[] = []

function add<T extends Event>(
  type: string,
  handler: (ev: T) => void,
): void {
  const wrapped = handler as EventListener
  window.addEventListener(type, wrapped)
  registered.push({ type, handler: wrapped })
}

export function installFrontendErrorHandlers(): void {
  if (installed) return
  if (typeof window === 'undefined') return
  installed = true

  add<ErrorEvent>('error', (ev) => {
    // `ev.error` is populated for genuine JS exceptions; for resource-
    // load failures (e.g. <img> 404s) it is null, in which case we fall
    // back to a synthetic Error carrying the `message` field.
    const raw =
      ev.error instanceof Error
        ? ev.error
        : new Error(ev.message || 'Uncaught error')
    recordFrontendError(raw, 'error', {
      filename: ev.filename,
      lineno: ev.lineno,
    })
  })

  add<PromiseRejectionEvent>('unhandledrejection', (ev) => {
    recordFrontendError(ev.reason, 'rejection')
  })

  add<SecurityPolicyViolationEvent>('securitypolicyviolation', (ev) => {
    // Synthesise an Error so the sink's fingerprint / scrub path
    // applies uniformly. The violated directive is the most diagnostic
    // field on the event; the blocked URI is carried in the context
    // object so it lands on the log record but is not part of the
    // fingerprint (which would explode cardinality on a misconfigured
    // CSP).
    recordFrontendError(new Error(ev.violatedDirective), 'csp', {
      blockedURI: ev.blockedURI,
    })
  })
}

export function __resetInstalledFlagForTest(): void {
  for (const { type, handler } of registered) {
    window.removeEventListener(type, handler)
  }
  registered = []
  installed = false
}
