import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'

import { resolveMatchedTemplate } from './current-route'
import { frontendMetrics } from './meter'

// Module-level so the value persists across remounts (e.g. React's
// StrictMode double-invoke in dev, or transient unmount/remount during
// a logout redirect). Initialised lazily on the first effect to
// performance.now(), which is `timeOrigin`-relative — i.e. the time
// since navigation start.
let lastTransitionAt: number | null = null

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
