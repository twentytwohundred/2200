/**
 * Command palette behavior tests. Renders the component inside the
 * minimum providers it needs (TanStack Query + react-router memory
 * router + ThemeProvider) and asserts on the result list once Cmd-K
 * opens it. Mocks the agents endpoint via vi.mock(api).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { CommandPalette } from '../../src/palette/CommandPalette'
import { ThemeProvider } from '../../src/theme/ThemeProvider'
import type { Agent, ListEnvelope } from '../../src/lib/api'
import type * as ApiModule from '../../src/lib/api'

const agentsMock = vi.fn<() => Promise<ListEnvelope<Agent>>>()
const agentStartMock = vi.fn<(name: string) => Promise<Agent>>()
const agentStopMock = vi.fn<(name: string, reason?: string) => Promise<Agent>>()

vi.mock('../../src/lib/api', async () => {
  const actual = await vi.importActual<typeof ApiModule>('../../src/lib/api')
  return {
    ...actual,
    api: {
      ...actual.api,
      agents: () => agentsMock(),
      agentStart: (name: string) => agentStartMock(name),
      agentStop: (name: string, reason?: string) => agentStopMock(name, reason),
    },
  }
})

function fakeAgent(name: string, status: string): Agent {
  return {
    name,
    status,
    pid: status === 'running' || status === 'waiting' ? 1234 : null,
    current_task_id: null,
    identity_path: `/home/agents/${name}/identity.md`,
    spawned_at: '2026-04-24T08:00:00.000Z',
    last_heartbeat: '2026-05-06T15:00:00.000Z',
    errored_at: null,
    errored_reason: null,
    pulse: null,
    model: null,
    avatar: null,
    avatar_image_url: null,
  }
}

function renderWithProviders(node: ReactNode): { client: QueryClient } {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  render(
    <QueryClientProvider client={client}>
      <ThemeProvider>
        <MemoryRouter>{node}</MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  )
  return { client }
}

function openPalette(): void {
  fireEvent.keyDown(window, { key: 'k', metaKey: true })
}

beforeEach(() => {
  agentsMock.mockReset()
  agentStartMock.mockReset()
  agentStopMock.mockReset()
})

afterEach(() => {
  // Unmount via cleanup happens in tests/setup.ts; nothing else.
})

describe('CommandPalette', () => {
  it('opens with Cmd-K and shows the canonical NAVIGATE entries', async () => {
    agentsMock.mockResolvedValue({ items: [], cursor: { next: null, limit: 50 } })
    renderWithProviders(<CommandPalette />)
    openPalette()
    await screen.findByPlaceholderText(/Search agents, navigate/)
    expect(screen.getByText('Fleet')).toBeInTheDocument()
    expect(screen.getByText('Inbox')).toBeInTheDocument()
    expect(screen.getByText('Budget')).toBeInTheDocument()
    expect(screen.getByText('Component library')).toBeInTheDocument()
    expect(screen.getByText('Settings')).toBeInTheDocument()
  })

  it('exposes a Build an Agent command pointing at /onboarding', async () => {
    agentsMock.mockResolvedValue({ items: [], cursor: { next: null, limit: 50 } })
    renderWithProviders(<CommandPalette />)
    openPalette()
    await screen.findByPlaceholderText(/Search agents, navigate/)
    expect(screen.getByText('Build an Agent')).toBeInTheDocument()
    expect(screen.getByText('/onboarding')).toBeInTheDocument()
  })

  it('shows Start <name> only for stopped/errored agents', async () => {
    agentsMock.mockResolvedValue({
      items: [fakeAgent('emma', 'stopped'), fakeAgent('hobby', 'running')],
      cursor: { next: null, limit: 50 },
    })
    renderWithProviders(<CommandPalette />)
    openPalette()
    await screen.findByText('Start emma')
    expect(screen.queryByText('Start hobby')).not.toBeInTheDocument()
    expect(screen.getByText('Stop hobby')).toBeInTheDocument()
    expect(screen.queryByText('Stop emma')).not.toBeInTheDocument()
  })

  it('omits start/stop entries for blocked statuses', async () => {
    agentsMock.mockResolvedValue({
      items: [fakeAgent('alice', 'blocked_on_user'), fakeAgent('bob', 'blocked_on_detector')],
      cursor: { next: null, limit: 50 },
    })
    renderWithProviders(<CommandPalette />)
    openPalette()
    // Wait for the agent navigation row to appear before asserting on
    // the absence of start/stop entries (the agents query is async).
    await screen.findByText('alice')
    expect(screen.getByText('bob')).toBeInTheDocument()
    expect(screen.queryByText('Start alice')).not.toBeInTheDocument()
    expect(screen.queryByText('Stop alice')).not.toBeInTheDocument()
    expect(screen.queryByText('Start bob')).not.toBeInTheDocument()
    expect(screen.queryByText('Stop bob')).not.toBeInTheDocument()
  })

  it('clicking Stop <name> calls api.agentStop and closes the palette', async () => {
    agentsMock.mockResolvedValue({
      items: [fakeAgent('hobby', 'running')],
      cursor: { next: null, limit: 50 },
    })
    agentStopMock.mockResolvedValue(fakeAgent('hobby', 'stopped'))
    renderWithProviders(<CommandPalette />)
    openPalette()
    const label = await screen.findByText('Stop hobby')
    // Click the row <li>, not the inner label span. The onClick lives
    // on the row element; bubbling works in jsdom but going to the
    // listener directly is more deterministic for the test.
    const row = label.closest('li')
    expect(row).not.toBeNull()
    fireEvent.click(row as HTMLElement)
    // useMutation.mutate kicks off the mutation asynchronously; wait
    // for the mock to actually be invoked rather than asserting
    // synchronously after click.
    await waitFor(() => {
      expect(agentStopMock).toHaveBeenCalledWith('hobby', 'palette')
    })
    // Palette closes synchronously inside activate() so by now the
    // dialog is no longer mounted.
    expect(screen.queryByPlaceholderText(/Search agents, navigate/)).not.toBeInTheDocument()
  })

  it('budget search query matches the BUDGET nav entry by alias', async () => {
    agentsMock.mockResolvedValue({ items: [], cursor: { next: null, limit: 50 } })
    renderWithProviders(<CommandPalette />)
    openPalette()
    const input = await screen.findByPlaceholderText(/Search agents, navigate/)
    fireEvent.change(input, { target: { value: 'spend' } })
    expect(screen.getByText('Budget')).toBeInTheDocument()
    // Other entries should NOT match 'spend'.
    expect(screen.queryByText('Fleet')).not.toBeInTheDocument()
    expect(screen.queryByText('Inbox')).not.toBeInTheDocument()
  })
})
