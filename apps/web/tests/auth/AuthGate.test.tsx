/**
 * Tests for the auth gate (cookie flow).
 *
 * Page JS can't read the HttpOnly session cookie, so the gate probes instead of
 * guessing: a 401 -> paste-your-token screen; success -> the app; a non-auth
 * failure is NOT treated as a session problem. Pasting a token POSTs it to
 * `/auth/login` (mocked) and, on success, the probe re-runs and the app renders.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

vi.mock('../../src/lib/auth', () => ({
  login: vi.fn(),
}))

vi.mock('../../src/lib/api', async () => {
  const actual = await vi.importActual('../../src/lib/api')
  return { ...actual, api: { agents: vi.fn() } }
})

import { AuthGate } from '../../src/auth/AuthGate'
import { login } from '../../src/lib/auth'
import { api, ApiError, NetworkError } from '../../src/lib/api'

function wrap(ui: React.ReactNode): ReturnType<typeof render> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}

const okAgents = () => ({ items: [] }) as unknown as Awaited<ReturnType<typeof api.agents>>
const unauthorized = (): ApiError =>
  new ApiError({ code: 'unauthorized', message: 'no', status: 401, request_id: 'r' })

beforeEach(() => {
  vi.clearAllMocks()
})

describe('AuthGate', () => {
  it('renders the app when the session cookie authenticates', async () => {
    vi.mocked(api.agents).mockResolvedValue(okAgents())
    wrap(
      <AuthGate>
        <div>APP</div>
      </AuthGate>,
    )
    await waitFor(() => {
      expect(screen.getByText('APP')).toBeInTheDocument()
    })
  })

  it('shows the entry screen on a 401 (no valid session)', async () => {
    vi.mocked(api.agents).mockRejectedValue(unauthorized())
    wrap(
      <AuthGate>
        <div>APP</div>
      </AuthGate>,
    )
    await waitFor(() => {
      expect(screen.getByText(/enter your access token/i)).toBeInTheDocument()
    })
    expect(screen.queryByText('APP')).not.toBeInTheDocument()
  })

  it('does NOT treat a non-auth failure as a session problem', async () => {
    vi.mocked(api.agents).mockRejectedValue(new NetworkError(new Error('down')))
    wrap(
      <AuthGate>
        <div>APP</div>
      </AuthGate>,
    )
    await waitFor(() => {
      expect(screen.getByText(/can.?t reach 2200/i)).toBeInTheDocument()
    })
    expect(screen.queryByText(/enter your access token/i)).not.toBeInTheDocument()
  })

  it('logs in with the trimmed token, then renders the app', async () => {
    // First probe 401 → entry screen; after a successful login the probe
    // re-runs and resolves → app.
    vi.mocked(api.agents).mockRejectedValueOnce(unauthorized()).mockResolvedValue(okAgents())
    vi.mocked(login).mockResolvedValue(true)
    wrap(
      <AuthGate>
        <div>APP</div>
      </AuthGate>,
    )
    await waitFor(() => {
      expect(screen.getByLabelText(/access token/i)).toBeInTheDocument()
    })
    fireEvent.change(screen.getByLabelText(/access token/i), { target: { value: '  newtok  ' } })
    fireEvent.click(screen.getByRole('button', { name: /connect/i }))
    await waitFor(() => {
      expect(login).toHaveBeenCalledWith('newtok')
    })
    await waitFor(() => {
      expect(screen.getByText('APP')).toBeInTheDocument()
    })
  })

  it('shows an error when the pasted token is rejected', async () => {
    vi.mocked(api.agents).mockRejectedValue(unauthorized())
    vi.mocked(login).mockResolvedValue(false)
    wrap(
      <AuthGate>
        <div>APP</div>
      </AuthGate>,
    )
    await waitFor(() => {
      expect(screen.getByLabelText(/access token/i)).toBeInTheDocument()
    })
    fireEvent.change(screen.getByLabelText(/access token/i), { target: { value: 'badtok' } })
    fireEvent.click(screen.getByRole('button', { name: /connect/i }))
    await waitFor(() => {
      expect(screen.getByText(/wasn.?t accepted/i)).toBeInTheDocument()
    })
  })
})
