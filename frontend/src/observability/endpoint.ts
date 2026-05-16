// Shim that resolves a relative OTLP endpoint (e.g. `/v1/traces`) to an
// absolute URL by prefixing `globalThis.location.origin`. Required
// because `@opentelemetry/otlp-exporter-base@0.218.0`'s fetch transport
// constructs `new URL(this._parameters.url)` BEFORE handing to
// `fetch()`, and `new URL('/v1/traces')` without a base throws
// "Invalid URL". The slice-18c bake-time + source-default endpoints are
// relative same-origin paths (so the in-k3s nginx and the vite dev
// proxy can route them); this helper makes them survive the exporter's
// URL-normalisation step. Absolute URLs and `globalThis.location`-less
// environments (SSR, some test setups) pass through unchanged.
export function resolveEndpointUrl(endpoint: string): string {
  if (!endpoint.startsWith('/')) return endpoint
  const origin = (globalThis as { location?: { origin?: string } }).location
    ?.origin
  return origin ? `${origin}${endpoint}` : endpoint
}
