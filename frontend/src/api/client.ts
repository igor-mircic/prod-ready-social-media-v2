// Orval custom mutator. Configured in `orval.config.ts`; every generated
// request function calls `apiFetch(url, init)` instead of `fetch` directly.
//
// Behavior:
//   - Reads `import.meta.env.VITE_API_BASE_URL` (defaults to `/api/v1`). When
//     the env var is set, it replaces the leading `/api/v1` of the generated
//     URL — so the same generated code works against the Vite proxy in dev
//     and against an absolute URL in other environments.
//   - On any non-2xx response, parses the body as RFC 7807 ProblemDetail and
//     throws a typed `ApiError`. TanStack Query's onError callbacks receive
//     the typed error.

const PROBLEM_DETAIL_KNOWN_FIELDS = new Set([
  'type',
  'title',
  'status',
  'detail',
  'instance',
])

export interface ProblemDetail {
  type?: string
  title?: string
  status?: number
  detail?: string
  instance?: string
  [extension: string]: unknown
}

export class ApiError extends Error {
  readonly status: number
  readonly title?: string
  readonly detail?: string
  readonly type?: string
  readonly instance?: string
  readonly extensions: Record<string, unknown>

  constructor(status: number, problem: ProblemDetail) {
    super(problem.detail ?? problem.title ?? `HTTP ${status}`)
    this.name = 'ApiError'
    this.status = status
    this.title = problem.title
    this.detail = problem.detail
    this.type = problem.type
    this.instance = problem.instance
    const extensions: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(problem)) {
      if (!PROBLEM_DETAIL_KNOWN_FIELDS.has(k)) extensions[k] = v
    }
    this.extensions = extensions
  }
}

const DEFAULT_BASE_URL = '/api/v1'
const SPEC_PREFIX = '/api/v1'

function resolveBaseUrl(): string {
  const fromEnv = (import.meta as { env?: { VITE_API_BASE_URL?: string } }).env
    ?.VITE_API_BASE_URL
  return fromEnv && fromEnv.length > 0 ? fromEnv : DEFAULT_BASE_URL
}

function buildUrl(url: string): string {
  const base = resolveBaseUrl().replace(/\/$/, '')
  // Generated URLs always start with the spec's `/api/v1` prefix. If the
  // configured base already ends with that prefix (the dev default), use the
  // URL unchanged; otherwise replace the prefix with the configured base.
  if (base === DEFAULT_BASE_URL) return url
  if (url.startsWith(SPEC_PREFIX)) {
    return `${base}${url.slice(SPEC_PREFIX.length)}`
  }
  return `${base}${url.startsWith('/') ? url : `/${url}`}`
}

// Orval's `react-query` client expects the mutator to return an envelope of
// the shape `{ data, status, headers }`. Returning the raw body would
// produce wrong types in the generated hooks.
export async function apiFetch<T = unknown>(
  url: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers ?? {})
  if (!headers.has('Accept')) {
    headers.set('Accept', 'application/json, application/problem+json')
  }
  if (init.body !== undefined && init.body !== null && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }

  const response = await fetch(buildUrl(url), { ...init, headers })

  if (!response.ok) {
    let problem: ProblemDetail = {}
    const text = await response.text()
    if (text) {
      try {
        problem = JSON.parse(text) as ProblemDetail
      } catch {
        problem = { detail: text }
      }
    }
    throw new ApiError(response.status, problem)
  }

  let data: unknown = undefined
  if (response.status !== 204) {
    const contentType = response.headers.get('Content-Type') ?? ''
    if (contentType.includes('application/json')) {
      data = await response.json()
    } else {
      const text = await response.text()
      data = text.length > 0 ? text : undefined
    }
  }
  return {
    data,
    status: response.status,
    headers: response.headers,
  } as T
}

export default apiFetch
