import { ZoneContextManager } from '@opentelemetry/context-zone'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { registerInstrumentations } from '@opentelemetry/instrumentation'
import { DocumentLoadInstrumentation } from '@opentelemetry/instrumentation-document-load'
import { FetchInstrumentation } from '@opentelemetry/instrumentation-fetch'
import { UserInteractionInstrumentation } from '@opentelemetry/instrumentation-user-interaction'
import { resourceFromAttributes } from '@opentelemetry/resources'
import {
  BatchSpanProcessor,
  WebTracerProvider,
} from '@opentelemetry/sdk-trace-web'
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions'

const DEFAULT_ENDPOINT = 'http://localhost:4318/v1/traces'
const DEFAULT_BATCH_DELAY_MS = 500
const DEV_BACKEND_ORIGIN = /^http:\/\/localhost:8080(\/.*)?$/

type ViteEnv = {
  VITE_OTEL_ENABLED?: string
  VITE_OTEL_TRACES_ENDPOINT?: string
  VITE_OTEL_BATCH_DELAY_MS?: string
  VITE_APP_VERSION?: string
  VITE_API_BASE_URL?: string
}

// Vitest gives each module its own `import.meta.env` object, so a test
// that does `vi.stubEnv` or mutates its own `import.meta.env` does not
// reach this module's view. Resolve once at module load and expose the
// reference via `__envForTest` so the unit test can stub by mutating the
// same object this module reads on every call.
const env: ViteEnv = (import.meta as { env?: ViteEnv }).env ?? {}

export const __envForTest: ViteEnv = env

function resolveBatchDelayMs(raw: string | undefined): number {
  if (!raw) return DEFAULT_BATCH_DELAY_MS
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_BATCH_DELAY_MS
}

function buildPropagateUrls(apiBaseUrl: string | undefined): Array<RegExp | string> {
  const urls: Array<RegExp | string> = [DEV_BACKEND_ORIGIN]
  const trimmed = apiBaseUrl?.trim()
  if (trimmed && /^https?:\/\//.test(trimmed)) {
    try {
      const origin = new URL(trimmed).origin
      const escaped = origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      urls.push(new RegExp(`^${escaped}(/.*)?$`))
    } catch {
      // Ignore unparseable URLs; the dev backend regex still matches.
    }
  }
  return urls
}

export function bootstrapTelemetry(): void {
  if (env.VITE_OTEL_ENABLED !== 'true') return

  const endpoint = env.VITE_OTEL_TRACES_ENDPOINT ?? DEFAULT_ENDPOINT
  const scheduledDelayMillis = resolveBatchDelayMs(env.VITE_OTEL_BATCH_DELAY_MS)
  const version = env.VITE_APP_VERSION ?? 'unknown'

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: 'frontend',
    [ATTR_SERVICE_VERSION]: version,
  })

  const provider = new WebTracerProvider({
    resource,
    spanProcessors: [
      new BatchSpanProcessor(new OTLPTraceExporter({ url: endpoint }), {
        scheduledDelayMillis,
      }),
    ],
  })

  provider.register({
    contextManager: new ZoneContextManager(),
  })

  registerInstrumentations({
    instrumentations: [
      new DocumentLoadInstrumentation(),
      new FetchInstrumentation({
        propagateTraceHeaderCorsUrls: buildPropagateUrls(env.VITE_API_BASE_URL),
      }),
      new UserInteractionInstrumentation({
        eventNames: ['click', 'submit'],
      }),
    ],
  })

  console.info(`OTel telemetry enabled: traces → ${endpoint}`)
}
