/**
 * Embassies / MCP conduits Settings sub-section (Phase 2 / PR-B5).
 *
 * The operator-facing view of the "diplomatic missions" the fleet
 * maintains to external MCP-speaking models (Grok today; Claude /
 * ChatGPT later). One conduit binds one OAuth client to one
 * embassy Agent.
 *
 * Atomic registration: this UI mints the OAuth client + provisions
 * the embassy in a single submit. The output displays the paste
 * block for grok.com/connectors → Custom (same shape the
 * OAuth-clients tile uses for register).
 *
 * Pattern matches OAuthClientsSection: two-step destructive
 * confirms on retire, copy-on-show secrets exactly once, no
 * `window.confirm`.
 */
import { useState, type ReactElement } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  apiConnectorConduits,
  apiConnectorOAuthClients,
  ApiError,
  NetworkError,
  type ConduitSummary,
  type ConduitMode,
} from '../../lib/api'
import { Card } from '../../primitives'
import styles from './EmbassiesSection.module.css'

function formatError(err: unknown): string {
  if (err instanceof ApiError) return `${err.code}: ${err.message}`
  if (err instanceof NetworkError) return 'Cannot reach the runtime.'
  return err instanceof Error ? err.message : String(err)
}

export function EmbassiesSection(): ReactElement {
  const queryClient = useQueryClient()
  const listQuery = useQuery({
    queryKey: ['connector', 'conduits'],
    queryFn: () => apiConnectorConduits.list(),
    staleTime: 10_000,
  })
  const redirectQuery = useQuery({
    queryKey: ['connector', 'grok-redirect-uri'],
    queryFn: () => apiConnectorOAuthClients.grokRedirectUri(),
    staleTime: 60_000,
  })
  const [registerOpen, setRegisterOpen] = useState(false)

  const conduits = listQuery.data?.items ?? []
  const activeCount = conduits.filter((c) => c.retired_at === null).length
  const defaultRedirect = redirectQuery.data?.redirect_uri ?? ''

  return (
    <Card padding={0}>
      <div className={styles.tile}>
        <div className={styles.header}>
          <h2 className={styles.title}>Embassies</h2>
          <p className={styles.subtitle}>
            Each embassy is the local Agent that owns the relationship with one external model.
            Registering an embassy mints an OAuth client and provisions the embassy Agent in one
            step. The output gives you the exact block to paste at grok.com/connectors → Custom.
          </p>
        </div>

        {listQuery.isLoading && <p className={styles.muted}>Loading...</p>}
        {listQuery.error && (
          <div className={styles.errorBlock}>List fetch failed: {formatError(listQuery.error)}</div>
        )}

        <div className={styles.list}>
          {conduits.map((c) => (
            <ConduitCard
              key={c.client_id}
              conduit={c}
              onMutated={() => {
                void queryClient.invalidateQueries({ queryKey: ['connector', 'conduits'] })
                void queryClient.invalidateQueries({ queryKey: ['connector', 'oauth-clients'] })
              }}
            />
          ))}
        </div>

        {conduits.length === 0 && !listQuery.isLoading && !listQuery.error && (
          <p className={styles.muted}>
            No embassies registered. Register one to enable a remote MCP-speaking model (Grok,
            Claude, etc.) to talk to your fleet.
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
              Register a new embassy
            </button>
          </div>
        )}

        {registerOpen && (
          <RegisterEmbassyForm
            defaultRedirect={defaultRedirect}
            existingAgentNames={new Set(conduits.map((c) => c.embassy_agent))}
            activeCount={activeCount}
            onCancel={() => {
              setRegisterOpen(false)
            }}
            onRegistered={() => {
              setRegisterOpen(false)
              void queryClient.invalidateQueries({ queryKey: ['connector', 'conduits'] })
              void queryClient.invalidateQueries({ queryKey: ['connector', 'oauth-clients'] })
            }}
          />
        )}
      </div>
    </Card>
  )
}

interface RegisterEmbassyFormProps {
  defaultRedirect: string
  existingAgentNames: Set<string>
  activeCount: number
  onCancel: () => void
  onRegistered: () => void
}

interface RegisterResultState {
  clientId: string
  clientSecret: string | null
  embassyAgent: string
  externalModel: string
}

function RegisterEmbassyForm({
  defaultRedirect,
  onCancel,
  onRegistered,
}: RegisterEmbassyFormProps): ReactElement {
  const [displayName, setDisplayName] = useState('Grok')
  const [externalModel, setExternalModel] = useState('grok')
  const [embassyAgent, setEmbassyAgent] = useState('grok-embassy')
  const [mode, setMode] = useState<ConduitMode>('dedicated')
  const [modelTier, setModelTier] = useState('frontier')
  const [modelProvider, setModelProvider] = useState('xai')
  const [modelId, setModelId] = useState('grok-4')
  const [redirectUri, setRedirectUri] = useState(defaultRedirect)
  const [mintSecret, setMintSecret] = useState(false)
  const [result, setResult] = useState<RegisterResultState | null>(null)

  const register = useMutation({
    mutationFn: () => {
      const body: Parameters<typeof apiConnectorConduits.register>[0] = {
        display_name: displayName.trim(),
        external_model: externalModel.trim().toLowerCase(),
        embassy_agent: embassyAgent.trim().toLowerCase(),
        mode,
        redirect_uris: [redirectUri.trim() || defaultRedirect],
      }
      if (mintSecret) body.mint_secret = true
      if (mode === 'dedicated') {
        body.model = {
          tier: modelTier.trim(),
          provider: modelProvider.trim(),
          model_id: modelId.trim(),
        }
      }
      return apiConnectorConduits.register(body)
    },
    onSuccess: (data) => {
      setResult({
        clientId: data.clientId,
        clientSecret: data.clientSecret,
        embassyAgent: data.conduit.embassy_agent,
        externalModel: data.conduit.external_model,
      })
    },
  })

  if (result !== null) {
    return (
      <RegisterResultView
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
      <h3 className={styles.formTitle}>Register a new embassy</h3>
      <div className={styles.formRow}>
        <label className={styles.label}>Display name</label>
        <input
          type="text"
          className={styles.input}
          value={displayName}
          onChange={(e) => {
            setDisplayName(e.target.value)
          }}
          placeholder="Grok (Doug's subscription)"
        />
      </div>
      <div className={styles.formRow}>
        <label className={styles.label}>External model</label>
        <input
          type="text"
          className={styles.input}
          value={externalModel}
          onChange={(e) => {
            setExternalModel(e.target.value)
          }}
          placeholder="grok"
        />
        <div className={styles.hint}>
          Lowercase slug identifying the remote model (e.g., `grok`, `claude`, `chatgpt`).
        </div>
      </div>
      <div className={styles.formRow}>
        <label className={styles.label}>Embassy agent</label>
        <input
          type="text"
          className={styles.input}
          value={embassyAgent}
          onChange={(e) => {
            setEmbassyAgent(e.target.value)
          }}
          placeholder="grok-embassy"
        />
        <div className={styles.hint}>
          {mode === 'dedicated'
            ? 'A new Agent will be created with this name to serve as the embassy.'
            : 'Must be an existing Agent name. The embassy role will be attached to it.'}
        </div>
      </div>
      <div className={styles.formRow}>
        <label className={styles.label}>Mode</label>
        <div className={styles.modeChoice}>
          <label className={styles.radioLabel}>
            <input
              type="radio"
              checked={mode === 'dedicated'}
              onChange={() => {
                setMode('dedicated')
              }}
            />
            Dedicated (create a fresh Agent)
          </label>
          <label className={styles.radioLabel}>
            <input
              type="radio"
              checked={mode === 'attached'}
              onChange={() => {
                setMode('attached')
              }}
            />
            Attached (use an existing Agent)
          </label>
        </div>
      </div>
      {mode === 'dedicated' && (
        <div className={styles.modelBlock}>
          <div className={styles.formRow}>
            <label className={styles.label}>Model tier</label>
            <input
              type="text"
              className={styles.input}
              value={modelTier}
              onChange={(e) => {
                setModelTier(e.target.value)
              }}
              placeholder="frontier | fast | economy | specialist"
            />
          </div>
          <div className={styles.formRow}>
            <label className={styles.label}>Model provider</label>
            <input
              type="text"
              className={styles.input}
              value={modelProvider}
              onChange={(e) => {
                setModelProvider(e.target.value)
              }}
              placeholder="xai | anthropic | openai | …"
            />
          </div>
          <div className={styles.formRow}>
            <label className={styles.label}>Model ID</label>
            <input
              type="text"
              className={styles.input}
              value={modelId}
              onChange={(e) => {
                setModelId(e.target.value)
              }}
              placeholder="grok-4"
            />
          </div>
        </div>
      )}
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
          For grok.com/connectors leave this on the default. Override only if you&apos;re
          registering a different consumer-side client.
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
          Mint a client_secret (default is PKCE-only, matches grok.com&apos;s recommended path)
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
          {register.isPending ? 'Registering...' : 'Register embassy'}
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

interface RegisterResultViewProps {
  result: RegisterResultState
  onDone: () => void
}

function RegisterResultView({ result, onDone }: RegisterResultViewProps): ReactElement {
  return (
    <div className={styles.resultBlock}>
      <h3 className={styles.formTitle}>
        Embassy registered for <code>{result.externalModel}</code>.
      </h3>
      <p className={styles.subtitle}>
        Paste these values into grok.com/connectors → New Connector → Custom.
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
      <p className={styles.subtitle}>
        The embassy <code>{result.embassyAgent}</code> is now provisioned. Inbound calls from this
        OAuth client will route through it; existing pre-embassy notes (if any) have been migrated
        into the embassy&apos;s brain.
      </p>
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

interface ConduitCardProps {
  conduit: ConduitSummary
  onMutated: () => void
}

function ConduitCard({ conduit, onMutated }: ConduitCardProps): ReactElement {
  const [pendingRetire, setPendingRetire] = useState(false)
  const retire = useMutation({
    mutationFn: () => apiConnectorConduits.retire(conduit.client_id),
    onSuccess: () => {
      setPendingRetire(false)
      onMutated()
    },
  })
  const isRetired = conduit.retired_at !== null

  return (
    <article className={`${styles.card ?? ''} ${isRetired ? (styles.cardRetired ?? '') : ''}`}>
      <div className={styles.cardHead}>
        <div className={styles.cardTitleRow}>
          <h3 className={styles.cardTitle}>
            {conduit.display_name}
            {isRetired && <span className={styles.retiredPill}>retired</span>}
          </h3>
          <code className={styles.clientId}>{conduit.client_id}</code>
        </div>
        <div className={styles.cardMeta}>
          <span>
            external model: <code>{conduit.external_model}</code>
          </span>
          <span>
            embassy agent: <code>{conduit.embassy_agent}</code> ({conduit.mode})
          </span>
          <span>registered: {new Date(conduit.registered_at).toLocaleString()}</span>
          {conduit.last_seen_at !== null && (
            <span>last seen: {new Date(conduit.last_seen_at).toLocaleString()}</span>
          )}
          {conduit.retired_at !== null && (
            <span>retired: {new Date(conduit.retired_at).toLocaleString()}</span>
          )}
        </div>
      </div>

      {!isRetired && !pendingRetire && (
        <div className={styles.buttons}>
          <button
            type="button"
            className={styles.tertiaryButton}
            onClick={() => {
              setPendingRetire(true)
            }}
          >
            Retire
          </button>
        </div>
      )}

      {pendingRetire && (
        <div className={styles.confirmBlock}>
          <div>
            <strong>Retire this embassy?</strong> The conduit record stays for audit but inbound
            calls from <code>{conduit.client_id}</code> will no longer route through{' '}
            <code>{conduit.embassy_agent}</code>. The Agent record itself is NOT deleted; the OAuth
            client also stays valid (revoke it separately under OAuth Clients if you want).
          </div>
          <div className={styles.buttons}>
            <button
              type="button"
              className={styles.dangerButton}
              onClick={() => {
                retire.mutate()
              }}
              disabled={retire.isPending}
            >
              {retire.isPending ? 'Retiring...' : 'Yes, retire'}
            </button>
            <button
              type="button"
              className={styles.tertiaryButton}
              onClick={() => {
                setPendingRetire(false)
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {retire.error && <div className={styles.errorBlock}>{formatError(retire.error)}</div>}
    </article>
  )
}
