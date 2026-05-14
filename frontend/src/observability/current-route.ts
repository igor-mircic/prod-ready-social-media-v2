import { matchPath } from 'react-router-dom'

// Mirror of the route templates declared in `App.tsx`. Kept in this
// module because React Router 7's `useMatches()` only returns
// path-template ids when the routes are defined via the data-router
// API (`createBrowserRouter`); the app uses descendant `<Route>`
// declarations under `<BrowserRouter>`, which yield synthetic numeric
// match ids. Listing the templates here is the cardinality-bounded
// source of truth — anything not matching falls through to the literal
// `unknown`. Update both lists together if `App.tsx` gains or removes
// a route.
// Note: the dev-only `/__dev/throw` route is intentionally NOT in this
// list. Including the literal would defeat the slice-7 CI lint check
// that asserts the path is absent from production bundles. Errors
// captured on the dev throw route resolve to `unknown` — acceptable
// because the e2e spec asserts on `kind="boundary"`, not on `route`.
const KNOWN_ROUTE_TEMPLATES = [
  '/login',
  '/signup',
  '/home',
  '/users/:userId',
  '/',
] as const

export const UNKNOWN_ROUTE = 'unknown'

export function resolveMatchedTemplate(pathname: string): string {
  for (const template of KNOWN_ROUTE_TEMPLATES) {
    if (matchPath({ path: template, end: true }, pathname)) {
      return template
    }
  }
  return UNKNOWN_ROUTE
}

// Read at capture time, not at route-change time, so a render-time
// error inside a routed component still reports the route the user is
// looking at (the useEffect-based route observer hasn't run yet on the
// frame the error fires).
export function getCurrentRoute(): string {
  if (typeof window === 'undefined') return UNKNOWN_ROUTE
  return resolveMatchedTemplate(window.location.pathname)
}
