/**
 * Inline audit card for claim-vs-evidence flags.
 *
 * The runtime appends a system-role message with `kind: 'audit'` and a
 * JSON envelope body whenever a task completes with severity above
 * `silent`. ChatMessage dispatches to this component on those rows so
 * the operator sees the verified / unverified / contradicted breakdown
 * inline in the chat surface that produced the claim.
 *
 * Fail-safe: if the envelope can't be parsed, render the raw body in
 * a muted code block rather than throwing. The audit card is a
 * surfacing of a runtime decision, never load-bearing for the chat
 * flow itself.
 */
import type { ReactElement } from 'react'
import type { AuditCardClaim, AuditCardEnvelope } from '../lib/api'
import styles from './AuditCard.module.css'

export interface AuditCardProps {
  /** The raw message body; we parse the JSON envelope inside. */
  body: string
  /** ISO ts of the message itself; used for the time label. */
  ts: string
}

export function AuditCard({ body, ts }: AuditCardProps): ReactElement {
  const parsed = parseEnvelope(body)
  if (!parsed) {
    return (
      <div className={styles.card}>
        <div className={styles.head}>
          <span className={styles.flag}>⚐ audit</span>
          <span className={styles.spacer} />
          <span className={styles.time}>{formatTime(ts)}</span>
        </div>
        <pre className={styles.fallback}>{body}</pre>
      </div>
    )
  }

  const verified = parsed.claims.filter((c) => c.status === 'verified').length
  const unverified = parsed.claims.filter((c) => c.status === 'unverified').length
  const contradicted = parsed.claims.filter((c) => c.status === 'contradicted').length

  return (
    <div className={severityClass(parsed.severity)}>
      <div className={styles.head}>
        <span className={styles.flag}>⚐ audit</span>
        <span className={styles.spacer} />
        <span className={styles.severity}>{parsed.severity}</span>
        <span className={styles.time}>{formatTime(ts)}</span>
      </div>
      <div className={styles.summary}>{parsed.summary}</div>
      <ul className={styles.claims}>
        {parsed.claims.map((c, i) => (
          <li key={`${String(i)}-${c.verb}-${c.object}`} className={styles.claimRow}>
            <span className={statusMarkerClass(c.status)} aria-label={c.status}>
              {statusGlyph(c.status)}
            </span>
            <div className={styles.claimBody}>
              <div className={styles.claimLine}>
                <span className={styles.verb}>{c.verb}</span>{' '}
                <span className={styles.object}>{c.object}</span>
                {c.path !== undefined && <span className={styles.path}> {c.path}</span>}
                {c.tool !== undefined && <span className={styles.path}> [{c.tool}]</span>}
              </div>
              <div className={styles.claimNote}>{c.note}</div>
            </div>
          </li>
        ))}
      </ul>
      {parsed.claims.length > 0 && (
        <div className={styles.tally}>
          {verified > 0 && <span className={styles.tallyOk}>{String(verified)} verified</span>}
          {unverified > 0 && (
            <span className={styles.tallyWarn}>{String(unverified)} unverified</span>
          )}
          {contradicted > 0 && (
            <span className={styles.tallyError}>{String(contradicted)} contradicted</span>
          )}
        </div>
      )}
    </div>
  )
}

function parseEnvelope(body: string): AuditCardEnvelope | null {
  try {
    const parsed = JSON.parse(body) as unknown
    if (typeof parsed !== 'object' || parsed === null) return null
    const env = parsed as Partial<AuditCardEnvelope>
    if (env.envelope !== 'audit_card_v1') return null
    if (!Array.isArray(env.claims)) return null
    if (
      env.severity !== 'silent' &&
      env.severity !== 'passive' &&
      env.severity !== 'normal' &&
      env.severity !== 'important'
    ) {
      return null
    }
    return env as AuditCardEnvelope
  } catch {
    return null
  }
}

function severityClass(severity: AuditCardEnvelope['severity']): string {
  const base = styles.card ?? ''
  switch (severity) {
    case 'important':
      return `${base} ${styles.cardImportant ?? ''}`
    case 'normal':
      return `${base} ${styles.cardNormal ?? ''}`
    case 'passive':
      return `${base} ${styles.cardPassive ?? ''}`
    case 'silent':
      return base
  }
}

function statusMarkerClass(status: AuditCardClaim['status']): string {
  const base = styles.marker ?? ''
  switch (status) {
    case 'verified':
      return `${base} ${styles.markerOk ?? ''}`
    case 'unverified':
      return `${base} ${styles.markerWarn ?? ''}`
    case 'contradicted':
      return `${base} ${styles.markerError ?? ''}`
  }
}

function statusGlyph(status: AuditCardClaim['status']): string {
  switch (status) {
    case 'verified':
      return '✓'
    case 'unverified':
      return '⚠'
    case 'contradicted':
      return '✗'
  }
}

function formatTime(ts: string): string {
  try {
    const d = new Date(ts)
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  } catch {
    return ts
  }
}
