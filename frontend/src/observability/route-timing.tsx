import { useEffect } from 'react'
import { matchPath, useLocation } from 'react-router-dom'

import { frontendMetrics } from './meter'

// Mirror of the route templates declared in `App.tsx`. Kept in this
// component because React Router 7's `useMatches()` only returns
// path-template ids when the routes are defined via the data-router
// API (`createBrowserRouter`); the app uses descendant `<Route>`
// declarations under `<BrowserRouter>`, which yield synthetic
// numeric match ids. Listing the templates here is the cardinality-
// bounded source of truth — anything not matching falls through to
// the literal `unknown`. Update both lists together if `App.tsx`
// gains or removes a route.
const KNOWN_ROUTE_TEMPLATES = [
  '/login',
  '/signup',
  '/home',
  '/users/:userId',
  '/',
] as const

const UNKNOWN_ROUTE = 'unknown'

// Module-level so the value persists across remounts (e.g. React's
// StrictMode double-invoke in dev, or transient unmount/remount
// during a logout redirect). Initialised lazily on the first effect
// to performance.now(), which is `timeOrigin`-relative — i.e. the
// time since navigation start.
let lastTransitionAt: number | null = null

function resolveMatchedTemplate(pathname: string): string {
  for (const template of KNOWN_ROUTE_TEMPLATES) {
    if (matchPath({ path: template, end: true }, pathname)) {
      return template
    }
  }
  return UNKNOWN_ROUTE
}

function RouteTimingObserver() {
  const location = useLocation()

  useEffect(() => {
    const now = performance.now()
    if (lastTransitionAt === null) {
      // First render: anchor the timer; no transition has happened yet.
      lastTransitionAt = now
      return
    }
    const matchedTemplate = resolveMatchedTemplate(location.pathname)
    frontendMetrics.routeChange?.record(now - lastTransitionAt, {
      route: matchedTemplate,
    })
    lastTransitionAt = now
  }, [location.pathname])

  return null
}

export default RouteTimingObserver
