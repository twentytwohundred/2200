/**
 * Grok-First sign-in tile.
 *
 * Pinned to the top of the Settings page. Drives the xAI device-code
 * OAuth flow inline through the daemon's `/api/v1/oauth/xai/*`
 * endpoints. Three visual states:
 *
 *   - Idle (not configured):  Big "Sign in with X / SuperGrok" button.
 *   - In-flight sign-in:       User code + verification URL + a
 *                              prominent "Open Approval Page" link.
 *                              The browser polls the daemon at the
 *                              interval xAI returned (typically 5s).
 *   - Configured:              Status line (expiry + scopes) + actions
 *                              to re-sign or sign out.
 *
 * The Grok consent screen says "Grok Build" because integrators share
 * xAI's CLI OAuth client. We surface that note inline so first-time
 * users don't get spooked.
 */
import { useEffect, useRef, useState, type ReactElement } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  apiOAuthXai,
  ApiError,
  NetworkError,
  type XaiOAuthLoginStatusResponse,
  type XaiOAuthStartResponse,
} from '../../lib/api'
import { Card } from '../../primitives'
import styles from './GrokAuthSection.module.css'

/**
 * Stylized X mark, modeled on xAI's brand wordmark (a clean,
 * geometric "X"). Renders in the tile's logo badge. Pure paths, no
 * external assets, picks up surrounding currentColor.
 */
function XLogo(): ReactElement {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true">
      <path
        d="M3.5 4.5 L13.5 16 L3 27.5 L7.5 27.5 L15.7 18.2 L23 27.5 L28.5 27.5 L18.0 14.5 L27.5 4.5 L23.0 4.5 L15.7 12.7 L9.0 4.5 Z"
        fill="currentColor"
      />
    </svg>
  )
}

function formatError(err: unknown): string {
  if (err instanceof ApiError) return `${err.code}: ${err.message}`
  if (err instanceof NetworkError) return 'Cannot reach the runtime.'
  return err instanceof Error ? err.message : String(err)
}

function formatRelativeExpiry(expiresAt: string): {
  text: string
  className: string | undefined
} {
  const ms = Date.parse(expiresAt) - Date.now()
  if (ms <= 0) return { text: 'EXPIRED', className: styles.expired }
  const min = Math.round(ms / 60_000)
  if (min < 5) return { text: `in ${String(min)}m`, className: styles.expiringSoon }
  if (min < 60) return { text: `in ${String(min)}m`, className: undefined }
  const hr = Math.floor(min / 60)
  const rem = min % 60
  return { text: `in ${String(hr)}h ${String(rem)}m`, className: undefined }
}

export function GrokAuthSection(): ReactElement {
  const queryClient = useQueryClient()
  const statusQuery = useQuery({
    queryKey: ['oauth', 'xai', 'status'],
    queryFn: () => apiOAuthXai.status(),
    staleTime: 10_000,
  })

  // Active sign-in session. Null when no flow is in progress.
  const [session, setSession] = useState<XaiOAuthStartResponse | null>(null)
  const [flowResult, setFlowResult] = useState<XaiOAuthLoginStatusResponse | null>(null)
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const stopPolling = (): void => {
    if (pollTimer.current) {
      clearTimeout(pollTimer.current)
      pollTimer.current = null
    }
  }

  // Cleanup any in-flight polling on unmount.
  useEffect(() => stopPolling, [])

  const pollOnce = async (sessionId: string, intervalSec: number): Promise<void> => {
    let res: XaiOAuthLoginStatusResponse
    try {
      res = await apiOAuthXai.loginStatus(sessionId)
    } catch (err) {
      setFlowResult({
        status: 'failed',
        error: 'transport_error',
        description: formatError(err),
      })
      stopPolling()
      return
    }
    if (res.status === 'pending') {
      const nextSec = res.poll_interval_sec > 0 ? res.poll_interval_sec : intervalSec
      pollTimer.current = setTimeout(() => {
        void pollOnce(sessionId, nextSec)
      }, nextSec * 1000)
      return
    }
    // Terminal state: completed or failed.
    setFlowResult(res)
    stopPolling()
    if (res.status === 'completed') {
      void queryClient.invalidateQueries({ queryKey: ['oauth', 'xai', 'status'] })
    }
  }

  const startSignIn = useMutation({
    mutationFn: () => apiOAuthXai.loginStart(),
    onMutate: () => {
      setFlowResult(null)
      stopPolling()
    },
    onSuccess: (data) => {
      setSession(data)
      // Kick the first poll on the spec-suggested cadence.
      pollTimer.current = setTimeout(() => {
        void pollOnce(data.session_id, data.poll_interval_sec)
      }, data.poll_interval_sec * 1000)
    },
  })

  const logout = useMutation({
    mutationFn: () => apiOAuthXai.logout(),
    onSuccess: () => {
      setSession(null)
      setFlowResult(null)
      stopPolling()
      void queryClient.invalidateQueries({ queryKey: ['oauth', 'xai', 'status'] })
    },
  })

  const cancelInFlight = (): void => {
    setSession(null)
    setFlowResult(null)
    stopPolling()
  }

  const status = statusQuery.data
  const configured = status?.configured === true
  // Show the device-code panel iff we have an active session and no
  // terminal result yet. `activeSession` carries the narrowed type
  // so the JSX can read .user_code, .verification_uri, etc. without
  // re-asserting non-null.
  const activeSession = flowResult === null ? session : null
  const inFlight = activeSession !== null

  return (
    <Card padding={0}>
      <div className={styles.tile}>
        <div className={styles.header}>
          <div className={styles.headerInner}>
            <div className={styles.logoBadge} aria-hidden="true">
              <XLogo />
            </div>
            <div className={styles.headerText}>
              <h2 className={styles.title}>Sign in with X / SuperGrok</h2>
              <p className={styles.subtitle}>
                Use your existing SuperGrok or X Premium+ subscription to power any Agent set to
                <strong> xAI / Grok (SuperGrok subscription)</strong> in the model picker ... no API
                key needed. The legacy <code>XAI_API_KEY</code> path stays available as a separate
                provider.
              </p>
            </div>
          </div>
        </div>

        {/* In-flight device-code panel. Highest priority: render this
            when a sign-in is in progress, even if the user already has
            a configured token (re-signing case). */}
        {activeSession !== null && (
          <div className={styles.flowPanel}>
            <div className={styles.flowSteps}>
              <strong>Two steps:</strong>
              <ol>
                <li>
                  Open this URL in any browser (your phone works fine):{' '}
                  <a
                    className={styles.verificationLink}
                    href={activeSession.verification_uri_complete ?? activeSession.verification_uri}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {activeSession.verification_uri_complete ?? activeSession.verification_uri}
                  </a>
                </li>
                <li>If prompted for a code, enter:</li>
              </ol>
            </div>
            <div className={styles.userCode}>{activeSession.user_code}</div>
            <div className={styles.flowNote}>
              The consent screen will say <strong>&ldquo;Grok Build&rdquo;</strong> ... that is
              xAI&rsquo;s shared CLI OAuth client name, not a separate app. You are not installing
              anything. Code expires{' '}
              <strong>{new Date(activeSession.expires_at).toLocaleTimeString()}</strong>;
              we&rsquo;ll poll automatically.
            </div>
            <div className={styles.buttons}>
              <button type="button" className={styles.secondaryButton} onClick={cancelInFlight}>
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Terminal failure from the most recent flow. */}
        {flowResult?.status === 'failed' && (
          <div className={styles.errorBlock}>
            Sign-in failed: <code>{flowResult.error}</code>
            {flowResult.description && <> &mdash; {flowResult.description}</>}
          </div>
        )}

        {/* Mutation-side error (e.g. discovery endpoint unreachable). */}
        {startSignIn.error && (
          <div className={styles.errorBlock}>
            Could not start sign-in: {formatError(startSignIn.error)}
          </div>
        )}

        {/* Status line (only visible when there's no in-flight flow). */}
        {!inFlight && status?.configured === true && (
          <div className={styles.bodyRow}>
            <div className={styles.statusLine}>
              <span>Status:</span>
              <strong>connected</strong>
            </div>
            <div className={styles.statusLine}>
              <span>Expires:</span>
              <strong>{new Date(status.expires_at).toLocaleString()}</strong>
              <span className={formatRelativeExpiry(status.expires_at).className}>
                ({formatRelativeExpiry(status.expires_at).text})
              </span>
            </div>
            <div className={styles.statusLine}>
              <span>Scopes:</span>
              <strong>{status.granted_scopes.join(' ')}</strong>
            </div>
            {status.refreshed_at && (
              <div className={styles.statusLine}>
                <span>Last refresh:</span>
                <strong>{new Date(status.refreshed_at).toLocaleString()}</strong>
              </div>
            )}
          </div>
        )}

        {!inFlight && !configured && !statusQuery.isLoading && (
          <p className={styles.subtitle} style={{ margin: 0 }}>
            Not signed in yet. One click below opens the device-code flow.
          </p>
        )}

        {/* Action buttons. */}
        {!inFlight && (
          <div className={styles.buttons}>
            <button
              type="button"
              className={styles.primaryButton}
              onClick={() => {
                startSignIn.mutate()
              }}
              disabled={startSignIn.isPending || statusQuery.isLoading}
            >
              {configured ? 'Re-sign in' : 'Sign in with X / SuperGrok'}
            </button>
            {configured && (
              <button
                type="button"
                className={styles.secondaryButton}
                onClick={() => {
                  logout.mutate()
                }}
                disabled={logout.isPending}
              >
                Sign out
              </button>
            )}
          </div>
        )}
      </div>
    </Card>
  )
}
