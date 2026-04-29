import type { ReactElement } from 'react'
import { FleetScreen } from './screens/fleet/FleetScreen'
import { ComponentsPage } from './dev/ComponentsPage'

/**
 * Minimal pathname-based switch.
 *
 * Real routing (React Router or TanStack Router) lands when the screen
 * graph grows beyond Fleet + dev/components. For PR E, the home route
 * is the live Fleet screen and /dev/components is the engineering
 * reference.
 */
export function Router(): ReactElement {
  if (typeof window === 'undefined') return <FleetScreen />
  if (window.location.pathname.startsWith('/dev/components')) {
    return <ComponentsPage />
  }
  return <FleetScreen />
}
