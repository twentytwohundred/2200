import type { ReactElement } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { FleetScreen } from './screens/fleet/FleetScreen'
import { AgentDetailScreen } from './screens/agent/AgentDetailScreen'
import { InboxScreen } from './screens/inbox/InboxScreen'
import { BudgetScreen } from './screens/budget/BudgetScreen'
import { OnboardingScreen } from './screens/onboarding/OnboardingScreen'
import { BrainScreen } from './screens/brain/BrainScreen'
import { ChatScreen } from './screens/chat/ChatScreen'
import { SchedulesScreen } from './screens/schedules/SchedulesScreen'
import { SettingsScreen } from './screens/settings/SettingsScreen'
import { ToolsScreen } from './screens/tools/ToolsScreen'
import { StudioScreen } from './screens/studio/StudioScreen'
import { RoomsScreen } from './screens/rooms/RoomsScreen'
import { FleetDocScreen } from './screens/fleet-doc/FleetDocScreen'
import { ExtensionsScreen } from './screens/extensions/ExtensionsScreen'
import { ComponentsPage } from './dev/ComponentsPage'
import { CommandPalette } from './palette/CommandPalette'

/**
 * App-wide route map.
 *
 * Phase A + B surface:
 *   /                    Fleet (mission control)
 *   /agent/:name         Agent detail (identity card variant)
 *   /inbox               Inbox (keyboard triage)
 *   /budget              Budget (Phase B v0.1: data substrate, ledger
 *                        receipt polish later)
 *   /onboarding          Card Stack onboarding (Phase B v0.1)
 *   /dev/components      Component library reference
 *
 * Future routes: /inbox/:id, /pub/:id. The command palette (⌘K)
 * overlays on whatever route is active, so it does not get its own
 * URL.
 */
export function Router(): ReactElement {
  return (
    <BrowserRouter>
      <CommandPalette />
      <Routes>
        <Route path="/" element={<FleetScreen />} />
        <Route path="/agent/:name" element={<AgentDetailScreen />} />
        <Route path="/agent/:name/chat/:chatId" element={<AgentDetailScreen />} />
        <Route path="/inbox" element={<InboxScreen />} />
        <Route path="/budget" element={<BudgetScreen />} />
        <Route path="/onboarding" element={<OnboardingScreen />} />
        <Route path="/agent/:name/chat" element={<ChatScreen />} />
        <Route path="/agent/:name/brain" element={<BrainScreen />} />
        <Route path="/agent/:name/schedules" element={<SchedulesScreen />} />
        <Route path="/agent/:name/tools" element={<ToolsScreen />} />
        <Route path="/settings" element={<SettingsScreen />} />
        <Route path="/studio" element={<StudioScreen />} />
        <Route path="/studio/:pub" element={<StudioScreen />} />
        <Route path="/rooms" element={<RoomsScreen />} />
        <Route path="/fleet" element={<FleetDocScreen />} />
        <Route path="/extensions" element={<ExtensionsScreen />} />
        <Route path="/dev/components" element={<ComponentsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
