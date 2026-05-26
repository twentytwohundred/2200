/**
 * OAuth Clients sub-section of the MCP Connector Settings tile
 * (Phase 2 / PR-A2).
 *
 * Web operator surface for the OAuth Authorization Server that
 * Phase 2 PR-A1 added. Backs the same Supervisor methods the CLI
 * verbs `2200 connector oauth-client {register, list, revoke,
 * rotate-secret}` hit.
 *
 * Phase 1 framing (preserved): the operator's pre-authorization at
 * this trusted (loopback) surface IS the human security boundary.
 * Registering a client here implies trust for that client to call
 * the fleet via /mcp through any future /authorize handshake; the
 * tunnel surface never asks for consent again.
 *
 * Pattern matches WorkPackagesSection: two-step destructive
 * confirms, no window.confirm(), copy-on-display for secrets shown
 * exactly once.
 */
import { useState, type ReactElement } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  apiConnectorOAuthClients,
  ApiError,
  NetworkError,
  type OAuthClientSummary,
} from '../../lib/api'
import { Card } from '../../primitives'
import styles from './OAuthClientsSection.module.css'

function formatError(err: unknown): string {
  if (err instanceof ApiError) return `${err.code}: ${err.message}`
  if (err instanceof NetworkError) return 'Cannot reach the runtime.'
  return err instanceof Error ? err.message : String(err)
}

export function OAuthClientsSection(): ReactElement {
  const queryClient = useQueryClient()
  const listQuery = useQuery({
    queryKey: ['connector', 'oauth-clients'],
    queryFn: () => apiConnectorOAuthClients.list(),
    staleTime: 10_000,
  })
  const redirectQuery = useQuery({
    queryKey: ['connector', 'grok-redirect-uri'],
    queryFn: () => apiConnectorOAuthClients.grokRedirectUri(),
    staleTime: 60_000,
  })
  const [registerOpen, setRegisterOpen] = useState(false)

  const clients = listQuery.data?.items ?? []
  const defaultRedirect = redirectQuery.data?.redirect_uri ?? ''

  return (
    <Card padding={0}>
      <div className={styles.tile}>
        <div className={styles.header}>
          <h2 className={styles.title}>OAuth clients</h2>
          <p className={styles.subtitle}>
            Pre-authorize a remote MCP caller (Grok, or any other OAuth-capable client) to call your
            fleet. Registration here IS the human security boundary; subsequent /authorize requests
            from a registered client proceed without operator presence at the public tunnel.
          </p>
        </div>

        {listQuery.isLoading && <p className={styles.muted}>Loading...</p>}
        {listQuery.error && (
          <div className={styles.errorBlock}>List fetch failed: {formatError(listQuery.error)}</div>
        )}

        <div className={styles.list}>
          {clients.map((client) => (
            <OAuthClientCard
              key={client.clientId}
              client={client}
              onMutated={() => {
                void queryClient.invalidateQueries({ queryKey: ['connector', 'oauth-clients'] })
              }}
            />
          ))}
        </div>

        {clients.length === 0 && !listQuery.isLoading && !listQuery.error && (
          <p className={styles.muted}>
            No OAuth clients registered. Register one to enable grok.com / Tesla / any consumer-side
            MCP client.
          </p>
        )}

        {!registerOpen && (
          <div className={styles.buttons}>
            <button
              type="button"
              className={styles.primaryButton}
              onClick={() => {
                setRegisterOpen(true)
              }}
            >
              Register a new OAuth client
            </button>
          </div>
        )}

        {registerOpen && (
          <RegisterClientForm
            defaultRedirect={defaultRedirect}
            onCancel={() => {
              setRegisterOpen(false)
            }}
            onRegistered={() => {
              setRegisterOpen(false)
              void queryClient.invalidateQueries({ queryKey: ['connector', 'oauth-clients'] })
            }}
          />
        )}
      </div>
    </Card>
  )
}

interface RegisterClientFormProps {
  defaultRedirect: string
  onCancel: () => void
  onRegistered: () => void
}

function RegisterClientForm({
  defaultRedirect,
  onCancel,
  onRegistered,
}: RegisterClientFormProps): ReactElement {
  const [displayName, setDisplayName] = useState('Grok')
  const [redirectUri, setRedirectUri] = useState(defaultRedirect)
  const [mintSecret, setMintSecret] = useState(false)
  const [result, setResult] = useState<{
    clientId: string
    clientSecret: string | null
    redirectUris: string[]
  } | null>(null)

  const register = useMutation({
    mutationFn: () =>
      apiConnectorOAuthClients.register({
        display_name: displayName.trim(),
        redirect_uris: [redirectUri.trim() || defaultRedirect],
        ...(mintSecret ? { mint_secret: true } : {}),
      }),
    onSuccess: (data) => {
      setResult({
        clientId: data.clientId,
        clientSecret: data.clientSecret,
        redirectUris: data.redirectUris,
      })
    },
  })

  if (result !== null) {
    return (
      <RegisterResult
        result={result}
        onDone={() => {
          setResult(null)
          onRegistered()
        }}
      />
    )
  }

  return (
    <div className={styles.formBlock}>
      <h3 className={styles.formTitle}>Register a new OAuth client</h3>
      <div className={styles.formRow}>
        <label className={styles.label}>Display name</label>
        <input
          type="text"
          className={styles.input}
          value={displayName}
          onChange={(e) => {
            setDisplayName(e.target.value)
          }}
          placeholder="Grok"
        />
      </div>
      <div className={styles.formRow}>
        <label className={styles.label}>Redirect URI</label>
        <input
          type="text"
          className={styles.input}
          value={redirectUri}
          onChange={(e) => {
            setRedirectUri(e.target.value)
          }}
          placeholder={defaultRedirect}
        />
        <div className={styles.hint}>
          For grok.com/connectors, leave this on the default. Override only if you're registering a
          different consumer-side client.
        </div>
      </div>
      <div className={styles.formRow}>
        <label className={styles.checkboxLabel}>
          <input
            type="checkbox"
            checked={mintSecret}
            onChange={(e) => {
              setMintSecret(e.target.checked)
            }}
          />
          Mint a client_secret (default is PKCE-only, which matches grok.com's recommended path)
        </label>
      </div>
      <div className={styles.buttons}>
        <button
          type="button"
          className={styles.primaryButton}
          onClick={() => {
            register.mutate()
          }}
          disabled={register.isPending || displayName.trim().length === 0}
        >
          {register.isPending ? 'Registering...' : 'Register'}
        </button>
        <button
          type="button"
          className={styles.tertiaryButton}
          onClick={onCancel}
          disabled={register.isPending}
        >
          Cancel
        </button>
      </div>
      {register.error && <div className={styles.errorBlock}>{formatError(register.error)}</div>}
    </div>
  )
}

interface RegisterResultProps {
  result: { clientId: string; clientSecret: string | null; redirectUris: string[] }
  onDone: () => void
}

function RegisterResult({ result, onDone }: RegisterResultProps): ReactElement {
  return (
    <div className={styles.resultBlock}>
      <h3 className={styles.formTitle}>OAuth client registered.</h3>
      <p className={styles.subtitle}>
        Paste these values into grok.com/connectors → New Connector → Custom (or the equivalent
        configuration surface for your MCP client).
        {result.clientSecret !== null && (
          <>
            {' '}
            <strong>
              The client_secret is shown once below — copy it now; it cannot be re-displayed.
            </strong>
          </>
        )}
      </p>
      <CopyRow
        label="MCP server URL"
        value="https://<your-tunnel>/mcp"
        hint="replace <your-tunnel>"
      />
      <CopyRow label="Client ID" value={result.clientId} />
      {result.clientSecret !== null && (
        <CopyRow label="Client Secret" value={result.clientSecret} sensitive />
      )}
      <CopyRow
        label="Authorization Endpoint"
        value="https://<your-tunnel>/oauth/authorize"
        hint="replace <your-tunnel>"
      />
      <CopyRow
        label="Token Endpoint"
        value="https://<your-tunnel>/oauth/token"
        hint="replace <your-tunnel>"
      />
      <CopyRow label="Scopes" value="connector:full" />
      <CopyRow
        label="Token Auth Method"
        value={result.clientSecret !== null ? 'client_secret_post' : 'none (PKCE only)'}
      />
      <CopyRow
        label="Redirect URI(s)"
        value={result.redirectUris.join(', ')}
        hint="must match exactly at grok.com side"
      />
      <div className={styles.buttons}>
        <button type="button" className={styles.primaryButton} onClick={onDone}>
          Done
        </button>
      </div>
    </div>
  )
}

interface CopyRowProps {
  label: string
  value: string
  hint?: string
  sensitive?: boolean
}

function CopyRow({ label, value, hint, sensitive }: CopyRowProps): ReactElement {
  const [copied, setCopied] = useState(false)
  return (
    <div className={styles.copyRow}>
      <div className={styles.copyLabel}>{label}</div>
      <code className={`${styles.copyValue ?? ''} ${sensitive ? (styles.sensitive ?? '') : ''}`}>
        {value}
      </code>
      <button
        type="button"
        className={styles.copyButton}
        onClick={() => {
          void navigator.clipboard.writeText(value).then(() => {
            setCopied(true)
            window.setTimeout(() => {
              setCopied(false)
            }, 1500)
          })
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
      {hint !== undefined && <div className={styles.hint}>{hint}</div>}
    </div>
  )
}

interface OAuthClientCardProps {
  client: OAuthClientSummary
  onMutated: () => void
}

function OAuthClientCard({ client, onMutated }: OAuthClientCardProps): ReactElement {
  const [pendingConfirm, setPendingConfirm] = useState<'revoke' | 'rotate' | null>(null)
  const [rotatedSecret, setRotatedSecret] = useState<string | null>(null)

  const revoke = useMutation({
    mutationFn: () => apiConnectorOAuthClients.revoke(client.clientId),
    onSuccess: () => {
      setPendingConfirm(null)
      onMutated()
    },
  })

  const rotate = useMutation({
    mutationFn: () => apiConnectorOAuthClients.rotateSecret(client.clientId),
    onSuccess: (data) => {
      setPendingConfirm(null)
      setRotatedSecret(data.client_secret)
    },
  })

  const isRevoked = client.revokedAt !== null

  return (
    <article className={`${styles.card ?? ''} ${isRevoked ? (styles.cardRevoked ?? '') : ''}`}>
      <div className={styles.cardHead}>
        <div className={styles.cardTitleRow}>
          <h3 className={styles.cardTitle}>
            {client.displayName}
            {isRevoked && <span className={styles.revokedPill}>revoked</span>}
          </h3>
          <code className={styles.clientId}>{client.clientId}</code>
        </div>
        <div className={styles.cardMeta}>
          <span>auth: {client.hasSecret ? 'client_secret_post' : 'none (PKCE only)'}</span>
          <span>scopes: {client.scopesAllowed.join(', ')}</span>
          <span>registered: {new Date(client.registeredAt).toLocaleString()}</span>
          {client.lastAuthorizeAt !== null && (
            <span>last authorize: {new Date(client.lastAuthorizeAt).toLocaleString()}</span>
          )}
          {client.revokedAt !== null && (
            <span>revoked: {new Date(client.revokedAt).toLocaleString()}</span>
          )}
        </div>
        <div className={styles.cardMeta}>
          <span>redirect URI(s): {client.redirectUris.join(', ')}</span>
        </div>
      </div>

      {rotatedSecret !== null && (
        <div className={styles.resultBlock}>
          <strong>Client secret rotated.</strong>
          <p className={styles.subtitle}>Shown once; copy now.</p>
          <CopyRow label="New Client Secret" value={rotatedSecret} sensitive />
          <div className={styles.buttons}>
            <button
              type="button"
              className={styles.primaryButton}
              onClick={() => {
                setRotatedSecret(null)
                onMutated()
              }}
            >
              Done
            </button>
          </div>
        </div>
      )}

      {!isRevoked && pendingConfirm === null && rotatedSecret === null && (
        <div className={styles.buttons}>
          {client.hasSecret && (
            <button
              type="button"
              className={styles.secondaryButton}
              onClick={() => {
                setPendingConfirm('rotate')
              }}
            >
              Rotate secret
            </button>
          )}
          <button
            type="button"
            className={styles.tertiaryButton}
            onClick={() => {
              setPendingConfirm('revoke')
            }}
          >
            Revoke
          </button>
        </div>
      )}

      {pendingConfirm === 'revoke' && (
        <div className={styles.confirmBlock}>
          <div>
            <strong>Revoke this client?</strong> All outstanding access + refresh tokens for it are
            invalidated immediately. The client can no longer call /mcp.
          </div>
          <div className={styles.buttons}>
            <button
              type="button"
              className={styles.dangerButton}
              onClick={() => {
                revoke.mutate()
              }}
              disabled={revoke.isPending}
            >
              {revoke.isPending ? 'Revoking...' : 'Yes, revoke'}
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

      {pendingConfirm === 'rotate' && (
        <div className={styles.confirmBlock}>
          <div>
            <strong>Rotate this client's secret?</strong> Existing tokens stay valid; the next time
            this client authenticates with a secret, the new one is required. Use this to recover
            from a leaked secret without revoking active sessions.
          </div>
          <div className={styles.buttons}>
            <button
              type="button"
              className={styles.primaryButton}
              onClick={() => {
                rotate.mutate()
              }}
              disabled={rotate.isPending}
            >
              {rotate.isPending ? 'Rotating...' : 'Yes, rotate'}
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

      {(revoke.error ?? rotate.error) && (
        <div className={styles.errorBlock}>{formatError(revoke.error ?? rotate.error)}</div>
      )}
    </article>
  )
}
