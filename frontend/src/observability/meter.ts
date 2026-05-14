import { metrics, type Histogram } from '@opentelemetry/api'
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http'
import {
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics'
import { onCLS, onFCP, onINP, onLCP, onTTFB } from 'web-vitals'

import { frontendResource } from './resource'

const DEFAULT_ENDPOINT = 'http://localhost:4318/v1/metrics'
const DEFAULT_EXPORT_INTERVAL_MS = 15_000

type ViteEnv = {
  VITE_OTEL_ENABLED?: string
  VITE_OTEL_METRICS_ENDPOINT?: string
  VITE_OTEL_METRICS_EXPORT_INTERVAL_MS?: string
}

// Resolve once at module load; expose via `__envForTest` so unit tests
// can stub by mutating the same object this module reads (mirrors the
// slice-5 `tracer.ts` pattern).
const env: ViteEnv = (import.meta as { env?: ViteEnv }).env ?? {}

export const __envForTest: ViteEnv = env

// Histograms shared with `route-timing.tsx` (which calls `.record(...)`
// on `frontendMetrics.routeChange` whenever the matched route template
// changes). Both are populated by `bootstrapMetrics()`; the optional
// shape lets the route-timing component no-op cleanly when telemetry
// is disabled or before bootstrap has run. Named `frontendMetrics` —
// not `metrics` — to avoid shadowing the OTel API namespace import.
export const frontendMetrics: {
  routeChange?: Histogram
  longTask?: Histogram
} = {}

function resolveExportIntervalMs(raw: string | undefined): number {
  if (!raw) return DEFAULT_EXPORT_INTERVAL_MS
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_EXPORT_INTERVAL_MS
}

export function bootstrapMetrics(): void {
  if (env.VITE_OTEL_ENABLED !== 'true') return

  const endpoint = env.VITE_OTEL_METRICS_ENDPOINT ?? DEFAULT_ENDPOINT
  const exportIntervalMillis = resolveExportIntervalMs(
    env.VITE_OTEL_METRICS_EXPORT_INTERVAL_MS,
  )

  const reader = new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter({ url: endpoint }),
    exportIntervalMillis,
  })

  const provider = new MeterProvider({
    resource: frontendResource,
    readers: [reader],
  })
  metrics.setGlobalMeterProvider(provider)

  const meter = metrics.getMeter('frontend')

  const lcpHistogram = meter.createHistogram('web_vitals_lcp')
  const clsHistogram = meter.createHistogram('web_vitals_cls')
  const inpHistogram = meter.createHistogram('web_vitals_inp')
  const fcpHistogram = meter.createHistogram('web_vitals_fcp')
  const ttfbHistogram = meter.createHistogram('web_vitals_ttfb')

  frontendMetrics.routeChange = meter.createHistogram(
    'route_change_duration_ms',
  )
  frontendMetrics.longTask = meter.createHistogram('long_task_duration_ms')

  // Web Vitals: record `metric.value` only — no per-event attributes.
  // The library's default (`reportAllChanges: false`) is the intended
  // posture for slice 6: one finalised value per metric per page load.
  onLCP((metric) => lcpHistogram.record(metric.value))
  onCLS((metric) => clsHistogram.record(metric.value))
  onINP((metric) => inpHistogram.record(metric.value))
  onFCP((metric) => fcpHistogram.record(metric.value))
  onTTFB((metric) => ttfbHistogram.record(metric.value))

  // Long-task observer. Feature-detect first: Safari historically did
  // not expose `longtask` via `PerformanceObserver.supportedEntryTypes`;
  // skipping silently keeps the rest of bootstrap intact on older
  // browsers.
  const supportedTypes =
    (typeof PerformanceObserver !== 'undefined' &&
      PerformanceObserver.supportedEntryTypes) ||
    []
  if (supportedTypes.includes('longtask')) {
    const longTaskObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        frontendMetrics.longTask?.record(entry.duration)
      }
    })
    longTaskObserver.observe({ type: 'longtask', buffered: true })
  }

  // Flush on page-hide so INP / CLS values finalised by the
  // `web-vitals` library on `visibilitychange` make it across the wire
  // before the periodic reader's next tick.
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      void provider.forceFlush()
    })
  }

  console.info(`OTel telemetry enabled: metrics → ${endpoint}`)
}
