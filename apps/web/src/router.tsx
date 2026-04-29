import type { ReactElement } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { FleetScreen } from './screens/fleet/FleetScreen'
import { AgentDetailScreen } from './screens/agent/AgentDetailScreen'
import { ComponentsPage } from './dev/ComponentsPage'

/**
 * App-wide route map.
 *
 * Phase A surface:
 *   /                    Fleet (mission control)
 *   /agent/:name         Agent detail (identity card variant)
 *   /dev/components      Component library reference
 *
 * Future routes (PR G/H): /inbox, /inbox/:id, /pub/:id, /budget,
 * /onboarding. The command palette (⌘K) overlays on whatever route is
 * active, so it does not get its own URL.
 */
export function Router(): ReactElement {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<FleetScreen />} />
        <Route path="/agent/:name" element={<AgentDetailScreen />} />
        <Route path="/dev/components" element={<ComponentsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
