import type { ReactElement } from 'react'
import { App } from './App'
import { ComponentsPage } from './dev/ComponentsPage'

/**
 * Minimal pathname-based switch.
 *
 * Real routing (React Router or TanStack Router) lands when Fleet
 * ships and the screen graph grows beyond two entries. For PR C, the
 * library page is reachable at /dev/components and the smoke page at
 * everything else.
 */
export function Router(): ReactElement {
  if (typeof window === 'undefined') return <App />
  if (window.location.pathname.startsWith('/dev/components')) {
    return <ComponentsPage />
  }
  return <App />
}
