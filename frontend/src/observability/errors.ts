import { logs } from '@opentelemetry/api-logs'
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http'
import {
  BatchLogRecordProcessor,
  LoggerProvider,
} from '@opentelemetry/sdk-logs'

import { installFrontendErrorHandlers } from './error-handlers'
import { frontendResource } from './resource'

const DEFAULT_ENDPOINT = 'http://localhost:4318/v1/logs'

type ViteEnv = {
  VITE_OTEL_ENABLED?: string
  VITE_OTEL_LOGS_ENDPOINT?: string
  VITE_OTEL_LOGS_SCHEDULE_DELAY_MS?: string
}

function resolveScheduleDelayMs(raw: string | undefined): number | undefined {
  if (!raw) return undefined
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

// Resolve once at module load so a unit test can mutate the same
// `import.meta.env` object this module reads. Mirrors the slice-5
// `tracer.ts` and slice-6 `meter.ts` pattern.
const env: ViteEnv = (import.meta as { env?: ViteEnv }).env ?? {}

export const __envForTest: ViteEnv = env

export function bootstrapErrorReporting(): void {
  if (env.VITE_OTEL_ENABLED !== 'true') return

  const endpoint = env.VITE_OTEL_LOGS_ENDPOINT ?? DEFAULT_ENDPOINT

  // Logs SDK requires the LoggerProvider be constructed with its
  // processors via the `processors` option (no `addLogRecordProcessor`
  // setter on the public API in `@opentelemetry/sdk-logs` 0.218.x).
  // Share the slice-5/slice-6 `frontendResource` so traces, metrics,
  // and logs all carry the same `service.name=frontend` and
  // `service.version` attributes — single source of truth.
  const scheduledDelayMillis = resolveScheduleDelayMs(
    env.VITE_OTEL_LOGS_SCHEDULE_DELAY_MS,
  )

  const provider = new LoggerProvider({
    resource: frontendResource,
    processors: [
      new BatchLogRecordProcessor(
        new OTLPLogExporter({ url: endpoint }),
        scheduledDelayMillis !== undefined ? { scheduledDelayMillis } : undefined,
      ),
    ],
  })

  logs.setGlobalLoggerProvider(provider)

  // The non-React error capture surfaces. The React boundary path is
  // wired separately by `<FrontendErrorBoundary>` in `main.tsx`.
  installFrontendErrorHandlers()

  console.info(`OTel telemetry enabled: logs → ${endpoint}`)
}
