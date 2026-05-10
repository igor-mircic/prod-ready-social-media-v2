// Orval custom mutator. Configured in `orval.config.ts`; every generated
// request function calls `apiFetch(url, init)` instead of `fetch` directly.
//
// Behavior:
//   - Reads `import.meta.env.VITE_API_BASE_URL` (defaults to `/api/v1`). When
//     the env var is set, it replaces the leading `/api/v1` of the generated
//     URL — so the same generated code works against the Vite proxy in dev
//     and against an absolute URL in other environments.
//   - Attaches `Authorization: Bearer <token>` when the AuthContext has
//     registered a token getter via `setAccessTokenGetter`.
//   - On a 401 from any URL other than `/api/v1/auth/login` and
//     `/api/v1/auth/refresh`, performs a single-flight refresh and retries
//     the original request once. On refresh failure, fires the registered
//     onRefreshFailure callback (used to clear AuthContext + navigate).
//   - On any non-2xx response that is not a transient 401-then-refresh,
//     parses the body as RFC 7807 ProblemDetail and throws a typed
//     `ApiError`. TanStack Query's onError callbacks receive the typed error.

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
const LOGIN_URL = '/api/v1/auth/login'
const REFRESH_URL = '/api/v1/auth/refresh'

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

let accessTokenGetter: (() => string | null) | null = null
let refreshSuccessHandler: ((newToken: string) => void) | null = null
let refreshFailureHandler: (() => void) | null = null
let inflightRefresh: Promise<string | null> | null = null

export function setAccessTokenGetter(getter: (() => string | null) | null): void {
  accessTokenGetter = getter
}

export function setRefreshHandlers(
  onSuccess: ((token: string) => void) | null,
  onFailure: (() => void) | null,
): void {
  refreshSuccessHandler = onSuccess
  refreshFailureHandler = onFailure
}

// Test seam: cancel any in-flight refresh between Vitest cases so handlers
// from one test do not bleed into another.
export function __resetClientState(): void {
  accessTokenGetter = null
  refreshSuccessHandler = null
  refreshFailureHandler = null
  inflightRefresh = null
}

function isAuthEndpoint(url: string): boolean {
  return url.startsWith(LOGIN_URL) || url.startsWith(REFRESH_URL)
}

async function refreshOnce(): Promise<string | null> {
  if (inflightRefresh) return inflightRefresh
  inflightRefresh = (async () => {
    try {
      const response = await fetch(buildUrl(REFRESH_URL), {
        method: 'POST',
        credentials: 'include',
        headers: { Accept: 'application/json, application/problem+json' },
      })
      if (!response.ok) {
        refreshFailureHandler?.()
        return null
      }
      const body = (await response.json()) as { accessToken?: string }
      if (!body.accessToken) {
        refreshFailureHandler?.()
        return null
      }
      refreshSuccessHandler?.(body.accessToken)
      return body.accessToken
    } catch {
      refreshFailureHandler?.()
      return null
    } finally {
      // Release the in-flight slot on the next tick so queued awaiters all
      // observe the same resolved value before a fresh refresh can begin.
      setTimeout(() => {
        inflightRefresh = null
      }, 0)
    }
  })()
  return inflightRefresh
}

function withAuthorization(headers: Headers, token: string | null): Headers {
  if (token) headers.set('Authorization', `Bearer ${token}`)
  return headers
}

async function performFetch(url: string, init: RequestInit): Promise<Response> {
  const headers = new Headers(init.headers ?? {})
  if (!headers.has('Accept')) {
    headers.set('Accept', 'application/json, application/problem+json')
  }
  if (init.body !== undefined && init.body !== null && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }
  const token = accessTokenGetter ? accessTokenGetter() : null
  withAuthorization(headers, token)
  return fetch(buildUrl(url), { ...init, headers, credentials: 'include' })
}

// Orval's `react-query` client expects the mutator to return an envelope of
// the shape `{ data, status, headers }`. Returning the raw body would
// produce wrong types in the generated hooks.
export async function apiFetch<T = unknown>(
  url: string,
  init: RequestInit = {},
): Promise<T> {
  let response = await performFetch(url, init)

  if (response.status === 401 && !isAuthEndpoint(url)) {
    const newToken = await refreshOnce()
    if (newToken) {
      response = await performFetch(url, init)
    }
  }

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
