/**
 * Inline operator-paste credential prompt card.
 *
 * The runtime appends a system-role message with `kind: 'credential_request'`
 * and a JSON envelope body whenever an Agent dispatches the
 * `credential_request` tool from a 1:1 chat. ChatMessage dispatches to
 * this component on those rows so the operator sees the prompt + paste
 * field inline.
 *
 * Load-bearing privacy property: the pasted value is POSTed directly
 * to the runtime which seals it to vault. It never enters the Agent's
 * loop context or transits the LLM provider.
 *
 * Live state: the card subscribes to credential_request.* WS events
 * for this request_id so the operator sees fulfill / decline / expire
 * updates from any other operator session.
 *
 * Fail-safe: if the envelope can't be parsed, render the raw body in
 * a muted code block rather than throwing.
 */
import { useEffect, useMemo, useState, type ReactElement } from 'react'
import type {
  CredentialExpiredReason,
  CredentialRequestEnvelopeV1,
  CredentialRequestState,
} from '../lib/api'
import { api } from '../lib/api'
import styles from './CredentialRequestCard.module.css'

export interface CredentialRequestCardProps {
  /** The raw chat-message body; JSON-parsed inside. */
  body: string
  /** ISO ts of the chat message itself; used for the time label. */
  ts: string
  /** Agent the request belongs to. Required for the fulfill / decline RPCs. */
  agent: string
  /** WS event router; null in test contexts that don't wire a router. */
  liveEnvelope?: ResolvedState
}

interface ResolvedState {
  state: CredentialRequestState
  fulfilledAt?: string | undefined
  declinedAt?: string | undefined
  expiredAt?: string | undefined
  declineReason?: string | null | undefined
  expiredReason?: CredentialExpiredReason | null | undefined
}

export function CredentialRequestCard({
  body,
  ts,
  agent,
  liveEnvelope,
}: CredentialRequestCardProps): ReactElement {
  const parsed = useMemo(() => parseEnvelope(body), [body])

  // Local resolution state. Starts from the embedded envelope, gets
  // overridden if the live WS surface reports a newer state, then
  // updates again when the operator hits PROVIDE / DECLINE here.
  const [resolved, setResolved] = useState<ResolvedState>(() => ({
    state: parsed?.state ?? 'pending',
  }))
  const [value, setValue] = useState('')
  const [reason, setReason] = useState('')
  const [submitting, setSubmitting] = useState<'fulfill' | 'decline' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showDecline, setShowDecline] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  // Local stage for the Hybrid UX: 'input' → 'provided' (operator just sealed) → 'verified' (Agent confirmed)
  const [cardStage, setCardStage] = useState<'input' | 'provided' | 'verified'>('input')

  // Adopt a live update from the WS layer when it arrives.
  useEffect(() => {
    if (liveEnvelope === undefined) return
    setResolved(liveEnvelope)
  }, [liveEnvelope])

  // On mount, backfill the current server-side state. The chat-message
  // body holds the envelope as written at request-creation time
  // (state='pending'); without this fetch, a page reload after the
  // operator already provided the credential renders the input form
  // again as if the request were still open. WS events only push on
  // STATE CHANGE, not snapshots, so the live router does not cover the
  // fresh-load case. Bug observed 2026-05-17 with David's first
  // credential_request.
  useEffect(() => {
    if (!parsed) return
    if (resolved.state !== 'pending') return // already terminal
    let cancelled = false
    void api
      .credentialRequestList(agent)
      .then((res) => {
        if (cancelled) return
        const match = res.items.find((r) => r.id === parsed.request_id)
        if (!match) return
        if (match.state === 'pending') return // server agrees, leave input form
        setResolved({
          state: match.state,
          ...(match.fulfilled_at ? { fulfilledAt: match.fulfilled_at } : {}),
          ...(match.declined_at ? { declinedAt: match.declined_at } : {}),
          ...(match.expired_at ? { expiredAt: match.expired_at } : {}),
          declineReason: match.decline_reason,
          expiredReason: match.expired_reason,
        })
      })
      .catch(() => {
        // Best effort: if the snapshot fetch fails, fall back to the
        // embedded envelope state (which is what we had before this
        // backfill). The WS layer will still update us when the next
        // state-change event lands.
      })
    return () => {
      cancelled = true
    }
  }, [agent, parsed, resolved.state])

  // Tick `now` every second so the expires-in countdown stays fresh.
  useEffect(() => {
    if (resolved.state !== 'pending') return
    const t = setInterval(() => {
      setNow(Date.now())
    }, 1000)
    return () => {
      clearInterval(t)
    }
  }, [resolved.state])

  if (!parsed) {
    return (
      <div className={styles.card}>
        <div className={styles.head}>
          <span className={styles.flag}>⚐ credential request</span>
          <span className={styles.spacer} />
          <span className={styles.time}>{formatTime(ts)}</span>
        </div>
        <pre className={styles.fallback}>{body}</pre>
      </div>
    )
  }

  const handleFulfill = async (): Promise<void> => {
    if (value.length === 0) {
      setError('paste a value before providing')
      return
    }
    setSubmitting('fulfill')
    setError(null)
    try {
      const result = await api.credentialRequestFulfill(agent, parsed.request_id, value)
      setResolved({
        state: result.state,
        fulfilledAt: result.fulfilled_at ?? undefined,
      })
      setValue('')
      setCardStage('provided') // Move to "Provided – sealed, awaiting Agent verification" state
    } catch (err) {
      setError(err instanceof Error ? err.message : 'fulfill failed')
    } finally {
      setSubmitting(null)
    }
  }

  const handleDecline = async (): Promise<void> => {
    setSubmitting('decline')
    setError(null)
    try {
      const result = await api.credentialRequestDecline(
        agent,
        parsed.request_id,
        reason.length > 0 ? reason : undefined,
      )
      setResolved({
        state: result.state,
        declinedAt: result.declined_at ?? undefined,
        declineReason: result.decline_reason,
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'decline failed')
    } finally {
      setSubmitting(null)
    }
  }

  // Hybrid UX: Show a clean "Provided" state right after the operator clicks Provide.
  // The Agent is still forced (via TaskBlocker) to produce a final confirmation in chat.
  if (cardStage === 'provided') {
    return (
      <div className={styles.card}>
        <div className={styles.head}>
          <span className={styles.flag}>✓ credential request</span>
          <span className={styles.spacer} />
          <span className={styles.time}>{formatTime(ts)}</span>
        </div>
        <div className={styles.label}>{parsed.label}</div>
        <div className={styles.resolvedBody}>
          Provided and sealed to the Agent’s private vault. The Agent has been instructed to verify
          receipt.
        </div>
        <div className={styles.expiredHint}>
          The Agent will confirm in chat once it has verified the credential.
        </div>
      </div>
    )
  }

  // Resolved (terminal) state ... render a compact summary, no input
  // surface. The card stays in the chat history forever; this is what
  // the operator sees later when scrolling back.
  if (resolved.state !== 'pending') {
    return (
      <div className={resolvedCardClass(resolved.state)}>
        <div className={styles.head}>
          <span className={styles.flag}>
            {resolvedHeadGlyph(resolved.state)} credential request
          </span>
          <span className={styles.spacer} />
          <span className={styles.severity}>{resolved.state}</span>
          <span className={styles.time}>{formatTime(ts)}</span>
        </div>
        <div className={styles.label}>{parsed.label}</div>
        <div className={styles.resolvedBody}>{resolvedDescription(parsed, resolved)}</div>
        {resolved.state === 'expired' && (
          <div className={styles.expiredHint}>
            ask {agent} to issue a new request when you're ready
          </div>
        )}
      </div>
    )
  }

  // Pending: full operator-input surface.
  const remainingMs = Math.max(0, Date.parse(parsed.expires_at) - now)
  return (
    <div className={styles.card}>
      <div className={styles.head}>
        <span className={styles.flag}>⚐ credential request</span>
        <span className={styles.spacer} />
        <span className={styles.kind}>{parsed.kind}</span>
        <span className={styles.time}>{formatTime(ts)}</span>
      </div>
      <div className={styles.label}>{parsed.label}</div>
      {parsed.help.length > 0 && <div className={styles.help}>{parsed.help}</div>}
      <div className={styles.reasonRow}>
        <span className={styles.reasonLabel}>reason</span>
        <span className={styles.reasonText}>{parsed.reason}</span>
      </div>
      <div className={styles.destination}>
        destination · <code>{parsed.destination_credential_name}</code> in <code>{agent}</code>
        {"'s"} vault
      </div>

      {/* Security reassurance — first-class, not an afterthought */}
      <div className={styles.securityNote}>
        This value is sealed directly into the Agent’s encrypted vault. The Agent will never see it.
      </div>

      <div className={styles.countdown}>{formatRemaining(remainingMs)}</div>
      <div className={styles.inputRow}>
        <input
          type="password"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          value={value}
          placeholder={inputPlaceholder(parsed.kind)}
          className={styles.input}
          disabled={submitting !== null || remainingMs === 0}
          onChange={(e) => {
            setValue(e.target.value)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && value.length > 0) {
              e.preventDefault()
              void handleFulfill()
            }
          }}
        />
      </div>
      {parsed.kind === 'file' && (
        <textarea
          className={styles.textarea}
          value={value}
          placeholder="paste the file contents here"
          disabled={submitting !== null || remainingMs === 0}
          onChange={(e) => {
            setValue(e.target.value)
          }}
          rows={6}
        />
      )}
      {showDecline && (
        <input
          type="text"
          className={styles.input}
          value={reason}
          placeholder="optional decline reason (operator-typed text)"
          disabled={submitting !== null}
          onChange={(e) => {
            setReason(e.target.value)
          }}
        />
      )}
      {error !== null && <div className={styles.error}>{error}</div>}
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.declineBtn}
          disabled={submitting !== null}
          onClick={() => {
            if (!showDecline) {
              setShowDecline(true)
              return
            }
            void handleDecline()
          }}
        >
          {submitting === 'decline' ? 'declining…' : showDecline ? 'CONFIRM DECLINE' : 'DECLINE'}
        </button>
        <button
          type="button"
          className={styles.provideBtn}
          disabled={submitting !== null || value.length === 0 || remainingMs === 0}
          onClick={() => {
            void handleFulfill()
          }}
        >
          {submitting === 'fulfill' ? 'providing…' : 'PROVIDE'}
        </button>
      </div>
    </div>
  )
}

function parseEnvelope(body: string): CredentialRequestEnvelopeV1 | null {
  try {
    const parsed = JSON.parse(body) as unknown
    if (typeof parsed !== 'object' || parsed === null) return null
    const env = parsed as Partial<CredentialRequestEnvelopeV1>
    if (env.envelope !== 'credential_request_v1') return null
    if (
      env.state !== 'pending' &&
      env.state !== 'fulfilled' &&
      env.state !== 'declined' &&
      env.state !== 'expired'
    ) {
      return null
    }
    if (typeof env.request_id !== 'string') return null
    if (typeof env.label !== 'string') return null
    if (typeof env.destination_credential_name !== 'string') return null
    if (env.kind !== 'value' && env.kind !== 'secret' && env.kind !== 'file') return null
    return env as CredentialRequestEnvelopeV1
  } catch {
    return null
  }
}

function inputPlaceholder(kind: CredentialRequestEnvelopeV1['kind']): string {
  if (kind === 'secret') return 'paste the secret value here'
  if (kind === 'file') return 'optional filename for reference'
  return 'paste the value here'
}

function formatTime(ts: string): string {
  try {
    return new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  } catch {
    return ts
  }
}

function formatRemaining(ms: number): string {
  if (ms <= 0) return 'expired'
  const totalSec = Math.floor(ms / 1000)
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `expires in ${String(m)}m ${String(s).padStart(2, '0')}s`
}

function resolvedHeadGlyph(state: CredentialRequestState): string {
  switch (state) {
    case 'fulfilled':
      return '✓'
    case 'declined':
      return '✗'
    case 'expired':
      return '⏱'
    default:
      return '⚐'
  }
}

function resolvedCardClass(state: CredentialRequestState): string {
  const base = styles.card ?? ''
  switch (state) {
    case 'fulfilled':
      return `${base} ${styles.cardFulfilled ?? ''}`
    case 'declined':
      return `${base} ${styles.cardDeclined ?? ''}`
    case 'expired':
      return `${base} ${styles.cardExpired ?? ''}`
    default:
      return base
  }
}

function resolvedDescription(
  env: CredentialRequestEnvelopeV1,
  resolved: ResolvedState,
): ReactElement | string {
  if (resolved.state === 'fulfilled') {
    return (
      <span>
        provided to <code>{env.destination_credential_name}</code>
        {resolved.fulfilledAt !== undefined && (
          <span className={styles.subtle}> at {formatTime(resolved.fulfilledAt)}</span>
        )}
      </span>
    )
  }
  if (resolved.state === 'declined') {
    return (
      <span>
        declined
        {resolved.declineReason !== undefined && resolved.declineReason !== null && (
          <span className={styles.subtle}> ... {resolved.declineReason}</span>
        )}
      </span>
    )
  }
  // expired
  const reason = resolved.expiredReason ?? 'timeout'
  return (
    <span>
      expired ({reason})
      {resolved.expiredAt !== undefined && (
        <span className={styles.subtle}> at {formatTime(resolved.expiredAt)}</span>
      )}
    </span>
  )
}
