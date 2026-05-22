/**
 * MCP connector Settings tile (Phase 1 / PR 1b).
 *
 * Operator-facing controls for the remote-MCP endpoint that exposes
 * 2200 to Grok and other MCP clients via the user's own tunnel. Three
 * visual states:
 *
 *   - No token (configured but unprovisioned): "Generate token" CTA.
 *   - Token present + listener live: status line + masked token +
 *     reveal toggle + copy + regenerate + disable.
 *   - Token present + listener not running: same as above plus an
 *     amber notice ... the substrate is provisioned but the bind
 *     refused (probably a port conflict). Operator can disable +
 *     regenerate to retry.
 *
 * Destructive actions (regenerate, disable) use inline two-step
 * confirms ... no window.confirm() per CLAUDE.md "no browser popups."
 */
import { useState, type ReactElement } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiConnector, ApiError, NetworkError } from '../../lib/api'
import { Card } from '../../primitives'
import styles from './ConnectorSection.module.css'

function formatError(err: unknown): string {
  if (err instanceof ApiError) return `${err.code}: ${err.message}`
  if (err instanceof NetworkError) return 'Cannot reach the runtime.'
  return err instanceof Error ? err.message : String(err)
}

function maskToken(token: string): string {
  // 2200-mcp-<43 chars>. Show prefix + last 4 so the operator can
  // visually verify a paste without exposing the full secret.
  if (!token.startsWith('2200-mcp-')) return '••••••••'
  const suffix = token.slice(-4)
  return `2200-mcp-${'•'.repeat(8)}${suffix}`
}

type ConfirmKind = 'regenerate' | 'disable' | null

export function ConnectorSection(): ReactElement {
  const queryClient = useQueryClient()
  const statusQuery = useQuery({
    queryKey: ['connector', 'status'],
    queryFn: () => apiConnector.status(),
    staleTime: 10_000,
  })

  const [revealed, setRevealed] = useState(false)
  const [pendingConfirm, setPendingConfirm] = useState<ConfirmKind>(null)
  const [copied, setCopied] = useState(false)
  // The fresh token surfaced by a regenerate is held in component
  // state so we can show it once with a one-click copy. The reveal
  // endpoint is the source of truth otherwise.
  const [justMinted, setJustMinted] = useState<string | null>(null)

  const tokenQuery = useQuery({
    queryKey: ['connector', 'token'],
    queryFn: () => apiConnector.token(),
    enabled: revealed,
    staleTime: 0,
  })

  const regenerate = useMutation({
    mutationFn: () => apiConnector.regenerate(),
    onSuccess: (data) => {
      setJustMinted(data.token)
      setRevealed(false)
      setPendingConfirm(null)
      void queryClient.invalidateQueries({ queryKey: ['connector', 'status'] })
      void queryClient.invalidateQueries({ queryKey: ['connector', 'token'] })
    },
  })

  const disable = useMutation({
    mutationFn: () => apiConnector.disable(),
    onSuccess: () => {
      setJustMinted(null)
      setRevealed(false)
      setPendingConfirm(null)
      void queryClient.invalidateQueries({ queryKey: ['connector', 'status'] })
      void queryClient.invalidateQueries({ queryKey: ['connector', 'token'] })
    },
  })

  async function copyToClipboard(value: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      window.setTimeout(() => {
        setCopied(false)
      }, 1500)
    } catch {
      // Clipboard API can fail under restricted contexts; the masked
      // value is still on-screen so the operator can read it.
    }
  }

  const status = statusQuery.data
  const tokenPresent = status?.bearer_present === true
  const listening = status?.listening === true
  const port = status?.port ?? 2201

  const displayToken = justMinted ?? (revealed ? (tokenQuery.data?.token ?? null) : null)

  return (
    <Card padding={0}>
      <div className={styles.tile}>
        <div className={styles.header}>
          <h2 className={styles.title}>MCP Connector</h2>
          <p className={styles.subtitle}>
            Expose a narrow, read-only slice of your fleet to Grok (and any other MCP-speaking
            client) via your own tunnel. Phase 1 ships the door; the operator pastes the bearer into{' '}
            <code>grok.com/connectors</code> as the Authorization for a Custom connector.
          </p>
        </div>

        {statusQuery.isLoading && <p className={styles.muted}>Loading...</p>}

        {statusQuery.error && (
          <div className={styles.errorBlock}>
            Status fetch failed: {formatError(statusQuery.error)}
          </div>
        )}

        {/* No token: invite the operator to mint one. */}
        {status && !tokenPresent && (
          <div className={styles.bodyRow}>
            <p className={styles.muted}>
              No token provisioned yet. Generating mints a fresh bearer, persists it in the sealed
              vault, and starts the connector listener on port {String(port)}.
            </p>
            <div className={styles.buttons}>
              <button
                type="button"
                className={styles.primaryButton}
                onClick={() => {
                  regenerate.mutate()
                }}
                disabled={regenerate.isPending}
              >
                {regenerate.isPending ? 'Generating...' : 'Generate connector token'}
              </button>
            </div>
          </div>
        )}

        {/* Token present: status + token row + actions. */}
        {status && tokenPresent && (
          <>
            <div className={styles.bodyRow}>
              <div className={styles.statusLine}>
                <span>Listener:</span>
                <strong className={listening ? styles.statusOn : styles.statusOff}>
                  {listening ? `active on :${String(port)}` : 'not running'}
                </strong>
              </div>
              {status.bearer_created_at && (
                <div className={styles.statusLine}>
                  <span>Token created:</span>
                  <strong>{new Date(status.bearer_created_at).toLocaleString()}</strong>
                </div>
              )}
              {status.bearer_regenerated_at && (
                <div className={styles.statusLine}>
                  <span>Last regenerated:</span>
                  <strong>{new Date(status.bearer_regenerated_at).toLocaleString()}</strong>
                </div>
              )}
            </div>

            {!listening && (
              <div className={styles.warnBlock}>
                The bearer is provisioned but the listener is not running. Disable then regenerate
                to retry the bind, or check the daemon log for the underlying error.
              </div>
            )}

            {justMinted !== null && (
              <div className={styles.mintedBlock}>
                <div className={styles.mintedLabel}>
                  New token (paste into <code>grok.com/connectors</code> Authorization):
                </div>
                <code className={styles.tokenDisplay}>{justMinted}</code>
                <div className={styles.buttons}>
                  <button
                    type="button"
                    className={styles.secondaryButton}
                    onClick={() => {
                      void copyToClipboard(justMinted)
                    }}
                  >
                    {copied ? 'Copied' : 'Copy'}
                  </button>
                  <button
                    type="button"
                    className={styles.tertiaryButton}
                    onClick={() => {
                      setJustMinted(null)
                    }}
                  >
                    Hide
                  </button>
                </div>
              </div>
            )}

            {justMinted === null && (
              <div className={styles.bodyRow}>
                <div className={styles.tokenRow}>
                  <code className={styles.tokenDisplay}>
                    {displayToken ?? maskToken('2200-mcp-' + 'x'.repeat(43))}
                  </code>
                  <div className={styles.tokenButtons}>
                    <button
                      type="button"
                      className={styles.secondaryButton}
                      onClick={() => {
                        setRevealed((v) => !v)
                      }}
                      disabled={tokenQuery.isLoading}
                    >
                      {revealed ? 'Hide' : 'Reveal'}
                    </button>
                    {displayToken !== null && (
                      <button
                        type="button"
                        className={styles.secondaryButton}
                        onClick={() => {
                          void copyToClipboard(displayToken)
                        }}
                      >
                        {copied ? 'Copied' : 'Copy'}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* Inline two-step destructive confirms. Per CLAUDE.md, no
                window.confirm(). */}
            {pendingConfirm === null && (
              <div className={styles.buttons}>
                <button
                  type="button"
                  className={styles.tertiaryButton}
                  onClick={() => {
                    setPendingConfirm('regenerate')
                  }}
                >
                  Regenerate
                </button>
                <button
                  type="button"
                  className={styles.tertiaryButton}
                  onClick={() => {
                    setPendingConfirm('disable')
                  }}
                >
                  Disable
                </button>
              </div>
            )}

            {pendingConfirm === 'regenerate' && (
              <div className={styles.confirmBlock}>
                <div>
                  <strong>Regenerate?</strong> The current token becomes invalid immediately. The
                  listener restarts with a fresh bearer. You will need to repaste the new token at{' '}
                  <code>grok.com/connectors</code>.
                </div>
                <div className={styles.buttons}>
                  <button
                    type="button"
                    className={styles.dangerButton}
                    onClick={() => {
                      regenerate.mutate()
                    }}
                    disabled={regenerate.isPending}
                  >
                    {regenerate.isPending ? 'Regenerating...' : 'Yes, regenerate'}
                  </button>
                  <button
                    type="button"
                    className={styles.tertiaryButton}
                    onClick={() => {
                      setPendingConfirm(null)
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {pendingConfirm === 'disable' && (
              <div className={styles.confirmBlock}>
                <div>
                  <strong>Disable connector?</strong> The bearer is deleted from the vault and the
                  listener stops. Grok and other MCP clients will be unable to call into 2200 until
                  you generate a new token.
                </div>
                <div className={styles.buttons}>
                  <button
                    type="button"
                    className={styles.dangerButton}
                    onClick={() => {
                      disable.mutate()
                    }}
                    disabled={disable.isPending}
                  >
                    {disable.isPending ? 'Disabling...' : 'Yes, disable'}
                  </button>
                  <button
                    type="button"
                    className={styles.tertiaryButton}
                    onClick={() => {
                      setPendingConfirm(null)
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {(regenerate.error ?? disable.error) && (
              <div className={styles.errorBlock}>
                {formatError(regenerate.error ?? disable.error)}
              </div>
            )}
          </>
        )}
      </div>
    </Card>
  )
}
