/**
 * Tests for the auth gate.
 *
 * Why this matters: a bare token must be enough to get back in. The install
 * hands out a URL with `?token=`, but after a rotate (or an instance reset)
 * the stored token stops working ... and the only recovery used to be
 * hand-editing the address bar. The gate pins: no token OR a 401 -> show the
 * paste-your-token screen (never the broken app); a non-auth failure is NOT
 * treated as a token problem; pasting a token saves the trimmed value.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

vi.mock('../../src/lib/auth', () => ({
  getToken: vi.fn(),
  setToken: vi.fn(),
}))

vi.mock('../../src/lib/api', async () => {
  const actual = await vi.importActual('../../src/lib/api')
  return { ...actual, api: { agents: vi.fn() } }
})

import { AuthGate } from '../../src/auth/AuthGate'
import { getToken, setToken } from '../../src/lib/auth'
import { api, ApiError, NetworkError } from '../../src/lib/api'

function wrap(ui: React.ReactNode): ReturnType<typeof render> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}

const unauthorized = (): ApiError =>
  new ApiError({ code: 'unauthorized', message: 'no', status: 401, request_id: 'r' })

beforeEach(() => {
  vi.clearAllMocks()
})

describe('AuthGate', () => {
  it('shows the entry screen (not the app) when there is no token', () => {
    vi.mocked(getToken).mockReturnValue(null)
    wrap(
      <AuthGate>
        <div>APP</div>
      </AuthGate>,
    )
    expect(screen.getByText(/enter your access token/i)).toBeInTheDocument()
    expect(screen.queryByText('APP')).not.toBeInTheDocument()
  })

  it('renders the app when the token authenticates', async () => {
    vi.mocked(getToken).mockReturnValue('good')
    vi.mocked(api.agents).mockResolvedValue({ items: [] } as unknown as Awaited<
      ReturnType<typeof api.agents>
    >)
    wrap(
      <AuthGate>
        <div>APP</div>
      </AuthGate>,
    )
    await waitFor(() => {
      expect(screen.getByText('APP')).toBeInTheDocument()
    })
  })

  it('shows the entry screen on a 401 (expired/rotated token)', async () => {
    vi.mocked(getToken).mockReturnValue('stale')
    vi.mocked(api.agents).mockRejectedValue(unauthorized())
    wrap(
      <AuthGate>
        <div>APP</div>
      </AuthGate>,
    )
    await waitFor(() => {
      expect(screen.getByText(/access token expired/i)).toBeInTheDocument()
    })
    expect(screen.queryByText('APP')).not.toBeInTheDocument()
  })

  it('does NOT treat a non-auth failure as a token problem', async () => {
    vi.mocked(getToken).mockReturnValue('good')
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

  it('saves the trimmed token on submit', () => {
    vi.mocked(getToken).mockReturnValue(null)
    const reload = vi.fn()
    // The gate only calls window.location.reload(); replace location with a
    // minimal stub (spreading the real Location instance loses its prototype).
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { reload },
    })
    wrap(
      <AuthGate>
        <div>APP</div>
      </AuthGate>,
    )
    fireEvent.change(screen.getByLabelText(/access token/i), { target: { value: '  newtok  ' } })
    fireEvent.click(screen.getByRole('button', { name: /connect/i }))
    expect(setToken).toHaveBeenCalledWith('newtok')
    expect(reload).toHaveBeenCalled()
  })
})
