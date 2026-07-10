/**
 * Subscription sign-in cards.
 *
 * The subscription providers (SuperGrok, ChatGPT) are presented as
 * PEER cards at the top of the Settings page ... "bring a
 * subscription you already pay for", no pinned leader. Each card
 * drives its provider's browser sign-in inline through the daemon's
 * `/api/v1/oauth/:provider/*` endpoints. Visual states:
 *
 *   - Idle (not configured):   Big sign-in button.
 *   - In-flight device flow:   User code + verification URL; the
 *                              browser polls the daemon at the
 *                              provider-suggested interval.
 *   - In-flight loopback flow: (ChatGPT fallback for accounts without
 *                              device sign-in enabled) a link that
 *                              opens the provider consent page; the
 *                              daemon holds the localhost callback.
 *   - Configured:              Status line (expiry + scopes) + actions
 *                              to re-sign or sign out.
 */
import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  apiOAuthSubscription,
  ApiError,
  NetworkError,
  type SubscriptionOAuthLoginStatusResponse,
  type SubscriptionOAuthRoute,
  type SubscriptionOAuthStartResponse,
} from '../../lib/api'
import { Card } from '../../primitives'
import styles from './SubscriptionAuthSection.module.css'

/**
 * Official Grok mark (the 2025 rebrand silhouette, sourced from xAI
 * brand assets). Inlined as a React component so it picks up
 * surrounding currentColor without needing a wrapper element.
 */
function GrokLogo(): ReactElement {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor" fillRule="evenodd">
      <path d="M9.27 15.29l7.978-5.897c.391-.29.95-.177 1.137.272.98 2.369.542 5.215-1.41 7.169-1.951 1.954-4.667 2.382-7.149 1.406l-2.711 1.257c3.889 2.661 8.611 2.003 11.562-.953 2.341-2.344 3.066-5.539 2.388-8.42l.006.007c-.983-4.232.242-5.924 2.75-9.383.06-.082.12-.164.179-.248l-3.301 3.305v-.01L9.267 15.292M7.623 16.723c-2.792-2.67-2.31-6.801.071-9.184 1.761-1.763 4.647-2.483 7.166-1.425l2.705-1.25a7.808 7.808 0 00-1.829-1A8.975 8.975 0 005.984 5.83c-2.533 2.536-3.33 6.436-1.962 9.764 1.022 2.487-.653 4.246-2.34 6.022-.599.63-1.199 1.259-1.682 1.925l7.62-6.815" />
    </svg>
  )
}

/**
 * OpenAI blossom mark, from @lobehub/icons-static-svg (MIT). Nominative
 * use: identifies the user's own OpenAI/ChatGPT account sign-in.
 */
function OpenAiLogo(): ReactElement {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor" fillRule="evenodd">
      <path d="M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z" />
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

interface SubscriptionCardConfig {
  /** Route segment in `/api/v1/oauth/<route>/*` (and the CLI subcommand). */
  route: SubscriptionOAuthRoute
  title: string
  subtitle: ReactNode
  logo: ReactElement
  signInLabel: string
  /** Note rendered under the user code during a device flow. */
  deviceNote: ReactNode
  /** Extra guidance rendered when the loopback fallback engages. */
  loopbackNote?: ReactNode
  /** Fine-print posture note pinned to the card (interim flags etc.). */
  interimNote?: ReactNode
}

function SubscriptionAuthCard({ config }: { config: SubscriptionCardConfig }): ReactElement {
  const api = apiOAuthSubscription(config.route)
  const queryClient = useQueryClient()
  const statusQuery = useQuery({
    queryKey: ['oauth', config.route, 'status'],
    queryFn: () => api.status(),
    staleTime: 10_000,
  })

  // Active sign-in session. Null when no flow is in progress.
  const [session, setSession] = useState<SubscriptionOAuthStartResponse | null>(null)
  const [flowResult, setFlowResult] = useState<SubscriptionOAuthLoginStatusResponse | null>(null)
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
    let res: SubscriptionOAuthLoginStatusResponse
    try {
      res = await api.loginStatus(sessionId)
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
      void queryClient.invalidateQueries({ queryKey: ['oauth', config.route, 'status'] })
    }
  }

  const startSignIn = useMutation({
    mutationFn: () => api.loginStart(),
    onMutate: () => {
      setFlowResult(null)
      stopPolling()
    },
    onSuccess: (data) => {
      setSession(data)
      // Kick the first poll on the daemon-suggested cadence.
      pollTimer.current = setTimeout(() => {
        void pollOnce(data.session_id, data.poll_interval_sec)
      }, data.poll_interval_sec * 1000)
    },
  })

  const logout = useMutation({
    mutationFn: () => api.logout(),
    onSuccess: () => {
      setSession(null)
      setFlowResult(null)
      stopPolling()
      void queryClient.invalidateQueries({ queryKey: ['oauth', config.route, 'status'] })
    },
  })

  const cancelInFlight = (): void => {
    setSession(null)
    setFlowResult(null)
    stopPolling()
  }

  const status = statusQuery.data
  const configured = status?.configured === true
  // Show the in-flight panel iff we have an active session and no
  // terminal result yet. `activeSession` carries the narrowed type so
  // the JSX can read .user_code etc. without re-asserting non-null.
  const activeSession = flowResult === null ? session : null
  const inFlight = activeSession !== null

  return (
    <Card padding={0}>
      <div className={styles.tile}>
        <div className={styles.header}>
          <div className={styles.headerInner}>
            <div className={styles.logoBadge} aria-hidden="true">
              {config.logo}
            </div>
            <div className={styles.headerText}>
              <h2 className={styles.title}>{config.title}</h2>
              <p className={styles.subtitle}>{config.subtitle}</p>
            </div>
          </div>
        </div>

        {/* In-flight device-code panel. Highest priority: render this
            when a sign-in is in progress, even if the user already has
            a configured token (re-signing case). */}
        {activeSession !== null && activeSession.flow === 'device' && (
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
              {config.deviceNote} Code expires{' '}
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

        {/* In-flight loopback panel (fallback when the account has
            device sign-in disabled). The daemon holds the localhost
            callback; the consent page must be opened from a browser on
            the same machine as the runtime. */}
        {activeSession !== null && activeSession.flow === 'loopback' && (
          <div className={styles.flowPanel}>
            <div className={styles.flowSteps}>
              <strong>Continue in the browser:</strong>
            </div>
            <div className={styles.buttons}>
              <a
                className={styles.primaryButton}
                style={{ textDecoration: 'none' }}
                href={activeSession.authorization_url ?? '#'}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open the sign-in page
              </a>
            </div>
            <div className={styles.flowNote}>
              {config.loopbackNote ??
                'The sign-in completes on this machine; keep this page open while you approve.'}{' '}
              Link expires{' '}
              <strong>{new Date(activeSession.expires_at).toLocaleTimeString()}</strong>.
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

        {/* Mutation-side error (e.g. provider endpoint unreachable). */}
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
            Not signed in yet. One click below starts the sign-in.
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
              {configured ? 'Re-sign in' : config.signInLabel}
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

        {config.interimNote && <p className={styles.interimNote}>{config.interimNote}</p>}
      </div>
    </Card>
  )
}

/** SuperGrok / X Premium+ subscription sign-in card. */
export function GrokAuthSection(): ReactElement {
  return (
    <SubscriptionAuthCard
      config={{
        route: 'xai',
        title: 'Sign in with X / SuperGrok',
        subtitle: (
          <>
            Use your existing SuperGrok or X Premium+ subscription to power any Agent set to
            <strong> xAI / Grok (SuperGrok subscription)</strong> in the model picker ... no API key
            needed. The <code>XAI_API_KEY</code> path stays available as a separate provider.
          </>
        ),
        logo: <GrokLogo />,
        signInLabel: 'Sign in with X / SuperGrok',
        deviceNote: (
          <>
            The consent screen will say <strong>&ldquo;Grok Build&rdquo;</strong> ... that is
            xAI&rsquo;s shared CLI OAuth client name, not a separate app. You are not installing
            anything.
          </>
        ),
      }}
    />
  )
}

/** ChatGPT (OpenAI Plus/Pro) subscription sign-in card. */
export function ChatGptAuthSection(): ReactElement {
  return (
    <SubscriptionAuthCard
      config={{
        route: 'openai',
        title: 'Sign in with ChatGPT',
        subtitle: (
          <>
            Use your existing ChatGPT Plus or Pro subscription to power any Agent set to
            <strong> OpenAI / ChatGPT (Plus/Pro subscription)</strong> in the model picker ... no
            API key needed. Serves the Codex model family (coding-tuned, general-capable); the
            <code> OPENAI_API_KEY</code> path stays available as a separate provider.
          </>
        ),
        logo: <OpenAiLogo />,
        signInLabel: 'Sign in with ChatGPT',
        deviceNote: (
          <>
            If the code page rejects the code, enable <strong>Device code authentication</strong> in
            ChatGPT Settings → Security, or cancel and retry ... the card falls back to a browser
            sign-in on the machine running 2200.
          </>
        ),
        loopbackNote: (
          <>
            Your account doesn&rsquo;t have device sign-in enabled, so this link must be opened in a
            browser <strong>on the machine running 2200</strong>. On a remote or headless install,
            enable <strong>Device code authentication</strong> in ChatGPT Settings → Security and
            start over.
          </>
        ),
        interimNote: (
          <>
            ChatGPT subscription access rides OpenAI&rsquo;s sanctioned shared integration client
            (the same one the Codex CLI uses). OpenAI can change this surface; if that happens,
            signing in again or updating 2200 restores it.
          </>
        ),
      }}
    />
  )
}
