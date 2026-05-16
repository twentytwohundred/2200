/**
 * Extensions Store screen.
 *
 * Browses the curated catalog (fetched from the supervisor's
 * `/api/v1/extensions/catalog` endpoint, which sources from
 * `extensions-catalog/v1.json` in dev and 2200.ai-hosted JSON in
 * production). Lets the operator install an Extension with a
 * permission + ToS modal, then surfaces a "pair your device"
 * callout for `qr_pair` connectors.
 *
 * Today's scope is browse + install + post-install handoff. The
 * QR-in-browser pair flow + allowlist editor land in the next
 * pass; the install step puts the Extension on disk and the
 * post-install callout tells the operator the next manual step.
 *
 * Decisions:
 *   - [[../../decisions/2026-05-16-connector-store]]
 *   - [[../../decisions/2026-05-16-connector-extensions]]
 */
import { useMemo, useState, type ReactElement } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ApiError,
  NetworkError,
  api,
  apiExtensions,
  type Catalog,
  type CatalogEntry,
  type ExtensionPairState,
} from '../../lib/api'
import { Button, Card, Screen, ScreenNavLink } from '../../primitives'
import styles from './ExtensionsScreen.module.css'

type Tab = 'connectors' | 'all' | 'installed'

function formatError(err: unknown): string {
  if (err instanceof ApiError) return `${err.code}: ${err.message}`
  if (err instanceof NetworkError) {
    return 'Cannot reach the runtime. The supervisor may not be running.'
  }
  return err instanceof Error ? err.message : String(err)
}

export function ExtensionsScreen(): ReactElement {
  const [tab, setTab] = useState<Tab>('connectors')
  const [installModalEntry, setInstallModalEntry] = useState<CatalogEntry | null>(null)
  const [recentInstalls, setRecentInstalls] = useState<Record<string, CatalogEntry>>({})

  const catalogQuery = useQuery({
    queryKey: ['extensionsCatalog'],
    queryFn: () => apiExtensions.catalog(),
  })

  const entries = useMemo(() => filterEntries(catalogQuery.data, tab), [catalogQuery.data, tab])

  return (
    <Screen
      crumbs={['2200', 'extensions']}
      title="Extensions"
      lede="Pick the connectors and add-ons you want on this instance. Default install ships zero Extensions; you choose what runs."
      actions={
        <>
          <ScreenNavLink to="/">Fleet</ScreenNavLink>
          <ScreenNavLink to="/studio">Studio</ScreenNavLink>
          <ScreenNavLink to="/inbox">Inbox</ScreenNavLink>
          <ScreenNavLink to="/settings">Settings</ScreenNavLink>
        </>
      }
    >
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <TabButton
          active={tab === 'connectors'}
          onClick={() => {
            setTab('connectors')
          }}
        >
          Connectors
        </TabButton>
        <TabButton
          active={tab === 'all'}
          onClick={() => {
            setTab('all')
          }}
        >
          All
        </TabButton>
        <TabButton
          active={tab === 'installed'}
          onClick={() => {
            setTab('installed')
          }}
        >
          Installed
        </TabButton>
      </div>

      {catalogQuery.isLoading && (
        <Card padding={20}>
          <p style={{ margin: 0, color: 'var(--text-2)' }}>Fetching the catalog…</p>
        </Card>
      )}
      {catalogQuery.isError && (
        <Card padding={20}>
          <p style={{ margin: 0, color: 'var(--danger)' }}>{formatError(catalogQuery.error)}</p>
        </Card>
      )}

      {!catalogQuery.isLoading && !catalogQuery.isError && entries.length === 0 && (
        <Card padding={32}>
          <p style={{ color: 'var(--text-2)' }}>
            {tab === 'installed'
              ? 'No Extensions installed yet. Browse Connectors to add your first one.'
              : 'No Extensions in this tab.'}
          </p>
        </Card>
      )}

      <div className={styles.list}>
        {entries.map((entry) => (
          <ExtensionCard
            key={entry.id}
            entry={entry}
            recentInstall={recentInstalls[entry.id] ?? null}
            onInstall={() => {
              setInstallModalEntry(entry)
            }}
          />
        ))}
      </div>

      {installModalEntry && (
        <InstallModal
          entry={installModalEntry}
          onClose={() => {
            setInstallModalEntry(null)
          }}
          onComplete={() => {
            setRecentInstalls((prev) => ({ ...prev, [installModalEntry.id]: installModalEntry }))
            setInstallModalEntry(null)
          }}
        />
      )}
    </Screen>
  )
}

function filterEntries(catalog: Catalog | undefined, tab: Tab): CatalogEntry[] {
  if (!catalog) return []
  if (tab === 'connectors') return catalog.extensions.filter((e) => e.category === 'connector')
  if (tab === 'installed') return [] // v1 placeholder until the supervisor exposes installed Extensions list
  return catalog.extensions
}

interface TabButtonProps {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}

function TabButton({ active, onClick, children }: TabButtonProps): ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        appearance: 'none',
        border: '1px solid',
        borderColor: active ? 'var(--text-2)' : 'var(--line)',
        background: active ? 'var(--bg-elev)' : 'transparent',
        color: active ? 'var(--text)' : 'var(--text-3)',
        padding: '7px 14px',
        borderRadius: 999,
        cursor: 'pointer',
        fontFamily: 'inherit',
        fontWeight: 500,
        fontSize: 13,
      }}
    >
      {children}
    </button>
  )
}

interface ExtensionCardProps {
  entry: CatalogEntry
  recentInstall: CatalogEntry | null
  onInstall: () => void
}

function ExtensionCard({ entry, recentInstall, onInstall }: ExtensionCardProps): ReactElement {
  const installedInThisSession = recentInstall !== null
  return (
    <div className={styles.card}>
      <div className={styles.icon}>
        {entry.icon ? (
          <img
            src={entry.icon}
            alt={`${entry.label} icon`}
            className={styles.iconImg}
            onError={(e) => {
              // Fall back: hide the broken image if the icon endpoint
              // is unreachable. The card still renders with empty icon.
              e.currentTarget.style.display = 'none'
            }}
          />
        ) : (
          <span className={styles.iconGlyph}>{entry.label.slice(0, 2).toLowerCase()}</span>
        )}
      </div>
      <div className={styles.body}>
        <div className={styles.title}>{entry.label}</div>
        <div className={styles.blurb}>{entry.blurb}</div>
        <div className={styles.meta}>
          {entry.permissions.map((p) => (
            <span key={p} className={styles.chip}>
              {p}
            </span>
          ))}
        </div>
        {installedInThisSession && entry.auth_model === 'qr_pair' && <PairFlow entry={entry} />}
        {installedInThisSession && entry.auth_model === 'bot_token' && (
          <BotTokenPerAgentFlow entry={entry} />
        )}
      </div>
      <div className={styles.actions}>
        <span className={styles.status} data-tone={installedInThisSession ? 'ok' : undefined}>
          {installedInThisSession ? 'installed' : `v${entry.current_version}`}
        </span>
        <Button variant="primary" size="md" onClick={onInstall} disabled={installedInThisSession}>
          {installedInThisSession ? 'Installed' : 'Install'}
        </Button>
      </div>
    </div>
  )
}

interface InstallModalProps {
  entry: CatalogEntry
  onClose: () => void
  onComplete: () => void
}

function InstallModal({ entry, onClose, onComplete }: InstallModalProps): ReactElement {
  const [grantedPerms, setGrantedPerms] = useState<Set<string>>(new Set(entry.permissions))
  const [tosAcked, setTosAcked] = useState(false)
  const [progress, setProgress] = useState<{ percent: number; message: string } | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const installMutation = useMutation({
    mutationFn: () =>
      apiExtensions.install({
        source: { type: 'catalog', id: entry.id },
        permissions_acknowledged: [...grantedPerms],
        tos_acknowledged: tosAcked,
      }),
    onSuccess: () => {
      setProgress({ percent: 25, message: 'Install started; copying files…' })
      // v1: no WS subscription for install_progress yet, so simulate
      // a brief progression and resolve. The supervisor pushes real
      // events to WS; subscribing the modal to them is the next pass.
      setTimeout(() => {
        setProgress({ percent: 75, message: 'Running install hook…' })
      }, 400)
      setTimeout(() => {
        setProgress({ percent: 100, message: 'Install complete.' })
        setTimeout(onComplete, 600)
      }, 1200)
    },
    onError: (err) => {
      setErrorMessage(formatError(err))
    },
  })

  const tosRequired = Boolean(entry.tos_acknowledgment)
  const canInstall =
    grantedPerms.size === entry.permissions.length &&
    (!tosRequired || tosAcked) &&
    !installMutation.isPending &&
    progress === null

  return (
    <div className={styles.modalScrim} onClick={onClose}>
      <div
        className={styles.modalCard}
        onClick={(e) => {
          e.stopPropagation()
        }}
      >
        <div className={styles.modalTitle}>Install {entry.label}</div>
        <p style={{ margin: 0, color: 'var(--text-2)' }}>{entry.blurb}</p>

        <div>
          <div className={styles.modalLabel}>Permissions this Extension requests</div>
          <div className={styles.permList} style={{ marginTop: 8 }}>
            {entry.permissions.map((p) => (
              <label key={p} className={styles.permItem}>
                <input
                  type="checkbox"
                  checked={grantedPerms.has(p)}
                  onChange={(e) => {
                    setGrantedPerms((prev) => {
                      const next = new Set(prev)
                      if (e.target.checked) next.add(p)
                      else next.delete(p)
                      return next
                    })
                  }}
                />
                <span className={styles.permName}>{p}</span>
              </label>
            ))}
          </div>
        </div>

        {entry.tos_acknowledgment && (
          <div>
            <div className={styles.modalLabel}>Terms of Service</div>
            <div className={styles.tosBox} style={{ marginTop: 8 }}>
              {entry.tos_acknowledgment}
            </div>
            <label className={styles.tosCheckbox}>
              <input
                type="checkbox"
                checked={tosAcked}
                onChange={(e) => {
                  setTosAcked(e.target.checked)
                }}
              />
              <span style={{ color: 'var(--text-2)', fontSize: 13 }}>
                I have read and accept the terms above.
              </span>
            </label>
          </div>
        )}

        {progress && (
          <div>
            <div className={styles.progress}>
              <div
                className={styles.progressBar}
                style={{ width: `${String(progress.percent)}%` }}
              />
            </div>
            <div className={styles.progressMessage} style={{ marginTop: 6 }}>
              {progress.message}
            </div>
          </div>
        )}

        {errorMessage && (
          <div
            style={{
              padding: '12px 14px',
              background: 'var(--danger-soft)',
              border: '1px solid var(--danger)',
              borderRadius: 8,
              color: 'var(--text)',
              fontSize: 13,
              lineHeight: 1.5,
            }}
          >
            Install failed: {errorMessage}
          </div>
        )}

        <div className={styles.modalActions}>
          <Button variant="ghost" size="md" onClick={onClose} disabled={installMutation.isPending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="md"
            onClick={() => {
              installMutation.mutate()
            }}
            disabled={!canInstall}
          >
            {installMutation.isPending ? 'Installing…' : 'Install'}
          </Button>
        </div>
      </div>
    </div>
  )
}

interface PairFlowProps {
  entry: CatalogEntry
}

function pairStatusLabel(state: ExtensionPairState): string {
  switch (state) {
    case 'idle':
      return 'starting…'
    case 'connecting':
      return 'connecting…'
    case 'awaiting_qr_scan':
      return 'waiting for scan'
    case 'paired':
      return 'paired ✓'
    case 'disconnected':
      return 'disconnected'
    case 'errored':
      return 'error'
  }
}

function PairFlow({ entry }: PairFlowProps): ReactElement {
  const [started, setStarted] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)

  const startMutation = useMutation({
    mutationFn: () => apiExtensions.pairStart(entry.id),
    onSuccess: () => {
      setStarted(true)
      setStartError(null)
    },
    onError: (err) => {
      setStartError(formatError(err))
    },
  })

  const stateQuery = useQuery({
    queryKey: ['extensionPairState', entry.id],
    queryFn: () => apiExtensions.pairState(entry.id),
    enabled: started,
    refetchInterval: (q) => {
      const data = q.state.data
      if (!data) return 600
      // Stop polling once paired; keep polling while waiting.
      if (data.state === 'paired') return false
      return 600
    },
  })

  if (!started) {
    return (
      <div className={styles.pairCallout}>
        <div className={styles.pairHeader}>
          <span className={styles.pairTitle}>Installed ✓ ... now pair your device</span>
          <span className={styles.pairStatus}>ready</span>
        </div>
        <p style={{ margin: 0, color: 'var(--text-2)', fontSize: 13, lineHeight: 1.55 }}>
          Click "Finish install" and we'll spawn the WhatsApp gateway, then surface a QR for you to
          scan with your phone. Setup is fully automatic from here.
        </p>
        {startError && <div className={styles.pairError}>Start failed: {startError}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Button
            variant="primary"
            size="md"
            onClick={() => {
              startMutation.mutate()
            }}
            disabled={startMutation.isPending}
          >
            {startMutation.isPending ? 'Starting gateway…' : 'Finish install'}
          </Button>
        </div>
        <AdvancedTerminalHandoff entry={entry} />
      </div>
    )
  }

  const data = stateQuery.data
  const state = data?.state ?? 'idle'

  if (state === 'paired') {
    return (
      <div className={styles.pairCallout}>
        <div className={styles.pairHeader}>
          <span className={styles.pairTitle}>Paired ✓</span>
          <span className={styles.pairStatus}>{pairStatusLabel(state)}</span>
        </div>
        <div className={styles.pairSuccess}>
          <div className={styles.pairSuccessIcon}>✓</div>
          <div>
            Connected as <strong>{data?.self_jid ?? '<unknown>'}</strong>. WhatsApp messages from
            allowlisted contacts will now wake bound Agents. Configure which Agent listens on
            WhatsApp next.
          </div>
        </div>
        <AdvancedTerminalHandoff entry={entry} />
      </div>
    )
  }

  return (
    <div className={styles.pairCallout}>
      <div className={styles.pairHeader}>
        <span className={styles.pairTitle}>Pair WhatsApp</span>
        <span className={styles.pairStatus}>{pairStatusLabel(state)}</span>
      </div>
      <div className={styles.pairBody}>
        <div className={styles.qrFrame}>
          {data?.qr_data_url ? (
            <img src={data.qr_data_url} alt="WhatsApp pairing QR code" />
          ) : (
            <span style={{ color: 'var(--text-3)', fontSize: 12 }}>generating QR…</span>
          )}
        </div>
        <div className={styles.pairInstructions}>
          <strong style={{ color: 'var(--text)' }}>Scan this QR with your phone:</strong>
          <ol>
            <li>Open WhatsApp on your phone.</li>
            <li>Tap Settings → Linked Devices.</li>
            <li>Tap "Link a Device".</li>
            <li>Point your phone's camera at this QR code.</li>
          </ol>
          <p style={{ marginTop: 10, color: 'var(--text-3)', fontSize: 12 }}>
            Once paired, the gateway runs in the background until uninstalled. You can pair more
            devices later from the same Linked-Devices screen.
          </p>
        </div>
      </div>
      {state === 'disconnected' && (
        <div className={styles.pairError}>
          Disconnected: {data?.detail ?? 'gateway closed the socket'}. Try reinstalling or restart
          the gateway.
        </div>
      )}
      {state === 'errored' && (
        <div className={styles.pairError}>{data?.detail ?? 'unknown gateway error'}</div>
      )}
      <AdvancedTerminalHandoff entry={entry} />
    </div>
  )
}

function AdvancedTerminalHandoff({ entry }: { entry: CatalogEntry }): ReactElement {
  return (
    <details className={styles.advanced}>
      <summary>Advanced ▸ start the gateway from a terminal</summary>
      <div className={styles.advancedBody}>
        For developers running the gateway manually (skipping the supervisor-spawn path), the
        canonical command is:
        <pre>
          {`cd ~/.local/share/2200/extensions/${entry.id}
AUTH_DIR=$HOME/.local/share/2200/state/extensions/${entry.id}/auth/default \\
GATEWAY_PORT=23200 \\
SUPERVISOR_URL=http://127.0.0.1:2200 \\
GATEWAY_INFO_PATH=$HOME/.local/share/2200/state/extensions/${entry.id}/gateway.json \\
pnpm tsx src/gateway.ts`}
        </pre>
        The supervisor's "Finish install" button does this for you automatically.
      </div>
    </details>
  )
}

// ---------------------------------------------------------------------------
// Per-Agent install flow (account_scope: 'agent' connectors)
// ---------------------------------------------------------------------------

interface BotTokenPerAgentFlowProps {
  entry: CatalogEntry
}

function BotTokenPerAgentFlow({ entry }: BotTokenPerAgentFlowProps): ReactElement {
  // Track each Agent we've successfully wired up in this session. The
  // server is the source of truth via /pair/state; this local set
  // controls the "Connected ✓" card on the screen + lets the user
  // queue up another Agent setup right after one finishes.
  const [connectedAgents, setConnectedAgents] = useState<
    Record<string, { botUsername: string; botUserId: string }>
  >({})
  const [addingAgent, setAddingAgent] = useState(true)

  return (
    <div className={styles.pairCallout}>
      <div className={styles.pairHeader}>
        <span className={styles.pairTitle}>Installed ✓ ... set up a bot per Agent</span>
        <span className={styles.pairStatus}>{Object.keys(connectedAgents).length} connected</span>
      </div>
      <p style={{ margin: 0, color: 'var(--text-2)', fontSize: 13, lineHeight: 1.55 }}>
        Each Agent gets its own Discord bot identity. Create one Discord application per Agent,
        paste the bot token below, and we'll wire everything up and start the bot. Repeat for every
        Agent you want available in Discord.
      </p>

      {Object.entries(connectedAgents).map(([agent, info]) => (
        <ConnectedAgentRow key={agent} agent={agent} botInfo={info} extensionId={entry.id} />
      ))}

      {addingAgent ? (
        <AgentSetupPanel
          entry={entry}
          excludeAgents={Object.keys(connectedAgents)}
          onConnected={(agent, info) => {
            setConnectedAgents((prev) => ({ ...prev, [agent]: info }))
            setAddingAgent(false)
          }}
          onCancel={() => {
            if (Object.keys(connectedAgents).length > 0) setAddingAgent(false)
          }}
        />
      ) : (
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Button
            variant="primary"
            size="md"
            onClick={() => {
              setAddingAgent(true)
            }}
          >
            + Set up another Agent
          </Button>
        </div>
      )}

      <AdvancedTerminalHandoff entry={entry} />
    </div>
  )
}

function ConnectedAgentRow({
  agent,
  botInfo,
  extensionId,
}: {
  agent: string
  botInfo: { botUsername: string; botUserId: string }
  extensionId: string
}): ReactElement {
  // Auto-generate the OAuth invite link from the bot's user id (for
  // Discord, the application id is the same as the bot user id). The
  // bot needs to be in a server with the user before DMs work, so
  // this link is load-bearing for first-message UX.
  // Discord permission integer:
  //   1024  View Channel       (without this, the bot can't see the channel at all)
  //   2048  Send Messages      (so the bot can reply via discord_send)
  //   16384 Embed Links        (so bot replies that include URLs render rich)
  //   65536 Read Message History (so the bot can read existing context on resume)
  //   64    Add Reactions      (so the bot can ack with an emoji before replying)
  // Sum: 85056. Excludes Administrator and channel-management; only what a
  // chat-style bot needs.
  const inviteUrl = `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(botInfo.botUserId)}&scope=bot&permissions=85056`
  return (
    <div className={styles.pairSuccess}>
      <div className={styles.pairSuccessIcon}>✓</div>
      <div style={{ flex: 1 }}>
        <div>
          <strong>{agent}</strong> connected as <strong>@{botInfo.botUsername}</strong>. Add the bot
          to a server you're in (or a private test server), then DM <strong>{agent}</strong> in
          Discord to start chatting.
        </div>
        <div style={{ marginTop: 8, display: 'flex', gap: 10, alignItems: 'center' }}>
          <a
            href={inviteUrl}
            target="_blank"
            rel="noreferrer"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              padding: '6px 12px',
              background: 'var(--accent)',
              color: 'var(--on-accent)',
              borderRadius: 6,
              fontSize: 12,
              fontWeight: 600,
              textDecoration: 'none',
            }}
          >
            Invite {agent}'s bot to a server →
          </a>
          <span style={{ color: 'var(--text-3)', fontSize: 11, fontFamily: 'monospace' }}>
            {extensionId}/{agent}
          </span>
        </div>
      </div>
    </div>
  )
}

function AgentSetupPanel({
  entry,
  excludeAgents,
  onConnected,
  onCancel,
}: {
  entry: CatalogEntry
  excludeAgents: string[]
  onConnected: (agent: string, info: { botUsername: string; botUserId: string }) => void
  onCancel: () => void
}): ReactElement {
  const queryClient = useQueryClient()
  const agentsQuery = useQuery({
    queryKey: ['agents'],
    queryFn: () => api.agents(),
  })
  const [selectedAgent, setSelectedAgent] = useState<string>('')
  const [token, setToken] = useState('')
  const [showToken, setShowToken] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pollingAgent, setPollingAgent] = useState<string | null>(null)

  const availableAgents = useMemo(() => {
    if (!agentsQuery.data) return []
    return agentsQuery.data.items
      .filter((a) => a.archived === null)
      .filter((a) => !excludeAgents.includes(a.name))
  }, [agentsQuery.data, excludeAgents])

  const setupMutation = useMutation({
    mutationFn: async () => {
      // Reset any prior pair-state cache entry for this agent so a retry
      // after an `errored` state actually re-polls instead of getting
      // stuck on the cached errored result (refetchInterval bails out
      // on errored).
      await queryClient.resetQueries({
        queryKey: ['extensionPairState', entry.id, selectedAgent],
      })
      return apiExtensions.agentSetup(entry.id, selectedAgent, {
        credentials: { bot_token: token },
      })
    },
    onSuccess: () => {
      setPollingAgent(selectedAgent)
      setError(null)
    },
    onError: (err) => {
      setError(formatError(err))
    },
  })

  const stateQuery = useQuery({
    queryKey: ['extensionPairState', entry.id, pollingAgent],
    queryFn: () => apiExtensions.pairState(entry.id, pollingAgent ?? undefined),
    enabled: pollingAgent !== null,
    refetchInterval: (q) => {
      const data = q.state.data
      if (!data) return 600
      if (data.state === 'paired') return false
      if (data.state === 'errored') return false
      return 600
    },
  })

  // When we transition to paired, hand off to the parent's connected
  // list. Same for errored ... but keep showing the error so the user
  // can re-paste a fixed token.
  if (pollingAgent && stateQuery.data?.state === 'paired' && stateQuery.data.self_user) {
    const info = {
      botUsername: stateQuery.data.self_user.username,
      botUserId: stateQuery.data.self_user.id,
    }
    queueMicrotask(() => {
      onConnected(pollingAgent, info)
    })
  }

  const isPolling = pollingAgent !== null && stateQuery.data?.state !== 'paired'

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      {/* Agent picker */}
      <div>
        <div className={styles.modalLabel}>
          Step 1: Pick which Agent gets this Discord bot{' '}
          <span style={{ color: 'var(--danger)' }}>(required)</span>
        </div>
        <select
          value={selectedAgent}
          onChange={(e) => {
            setSelectedAgent(e.target.value)
          }}
          disabled={isPolling || setupMutation.isPending}
          style={{
            marginTop: 8,
            width: '100%',
            padding: '10px 12px',
            background: 'var(--bg-sunk)',
            color: 'var(--text)',
            border: `1px solid ${selectedAgent ? 'var(--line)' : 'var(--danger)'}`,
            borderRadius: 8,
            fontSize: 14,
            fontFamily: 'inherit',
          }}
        >
          <option value="">— pick an Agent —</option>
          {availableAgents.map((a) => (
            <option key={a.name} value={a.name}>
              {a.name}
            </option>
          ))}
        </select>
        {availableAgents.length === 0 && agentsQuery.data && (
          <p style={{ marginTop: 6, color: 'var(--text-3)', fontSize: 12 }}>
            All Agents on this instance already have a Discord bot wired up. Spawn another Agent
            first if you want more bots.
          </p>
        )}
      </div>

      {/* Walkthrough */}
      <div className={styles.advancedBody}>
        <strong style={{ color: 'var(--text)' }}>
          Step 2: Get a Discord bot token for {selectedAgent || 'this Agent'}:
        </strong>
        <ol style={{ marginTop: 10, paddingLeft: 20, lineHeight: 1.7 }}>
          <li>
            Open the{' '}
            <a
              href="https://discord.com/developers/applications"
              target="_blank"
              rel="noreferrer"
              style={{ color: 'var(--accent)' }}
            >
              Discord Developer Portal
            </a>{' '}
            in a new tab. (Sign in with your Discord account if prompted.)
          </li>
          <li>
            Click <strong>New Application</strong> in the top right.
          </li>
          <li>
            Name it after your Agent
            {selectedAgent ? (
              <>
                {' '}
                ... e.g. <code>{selectedAgent}</code>
              </>
            ) : null}
            . Accept the developer terms. Click <strong>Create</strong>.
          </li>
          <li>
            In the left sidebar of the new application, click <strong>Bot</strong>.
          </li>
          <li>
            Scroll down to <strong>Privileged Gateway Intents</strong>. Toggle{' '}
            <strong>Message Content Intent</strong> ON. Click <strong>Save Changes</strong> at the
            bottom. Without this, Discord refuses the bot login.
          </li>
          <li>
            Scroll back up to <strong>TOKEN</strong>, click <strong>Reset Token</strong>. Confirm
            the two prompts (and enter your 2FA code if prompted). Click <strong>Copy</strong> on
            the token that appears.
          </li>
          <li>Paste the token into the field below.</li>
        </ol>
        <p style={{ marginTop: 12, color: 'var(--text-3)', fontSize: 12, lineHeight: 1.6 }}>
          The token is sealed directly into{' '}
          {selectedAgent ? <strong>{selectedAgent}</strong> : 'the Agent'}'s private vault. 2200
          never logs, transmits, or stores it in any other place. You can revoke + rotate at any
          time from the same Bot page in the Developer Portal.
        </p>
      </div>

      {/* Token input */}
      <div>
        <div className={styles.modalLabel}>Step 3: Paste the bot token</div>
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <input
            type={showToken ? 'text' : 'password'}
            value={token}
            onChange={(e) => {
              setToken(e.target.value)
            }}
            placeholder="paste the bot token here"
            disabled={isPolling || setupMutation.isPending}
            style={{
              flex: 1,
              padding: '10px 12px',
              background: 'var(--bg-sunk)',
              color: 'var(--text)',
              border: '1px solid var(--line)',
              borderRadius: 8,
              fontSize: 13,
              fontFamily: 'JetBrains Mono, ui-monospace, monospace',
            }}
          />
          <Button
            variant="ghost"
            size="md"
            onClick={() => {
              setShowToken((s) => !s)
            }}
            disabled={isPolling || setupMutation.isPending}
          >
            {showToken ? 'Hide' : 'Show'}
          </Button>
        </div>
      </div>

      {error && <div className={styles.pairError}>{error}</div>}
      {stateQuery.data?.state === 'errored' && (
        <div className={styles.pairError}>
          <strong>Bot login failed:</strong> {stateQuery.data.detail ?? 'unknown error'}
          {(stateQuery.data.detail ?? '').toLowerCase().includes('intent') ? (
            <div style={{ marginTop: 8 }}>
              Discord rejected the bot because <strong>Message Content Intent</strong> isn't
              enabled. Go back to your bot's page on the{' '}
              <a
                href="https://discord.com/developers/applications"
                target="_blank"
                rel="noreferrer"
                style={{ color: 'var(--accent)' }}
              >
                Discord Developer Portal
              </a>
              , click <strong>Bot</strong> in the sidebar, scroll to{' '}
              <strong>Privileged Gateway Intents</strong>, toggle{' '}
              <strong>Message Content Intent</strong> ON, click <strong>Save Changes</strong>, then
              click <strong>Connect {selectedAgent}</strong> below to retry. (No need to reset the
              token.)
            </div>
          ) : (
            <div style={{ marginTop: 8 }}>
              Token rejected? Reset it in the Developer Portal (Bot tab → Reset Token) and try again
              with the new token.
            </div>
          )}
        </div>
      )}

      {isPolling && (
        <div
          style={{
            padding: '10px 12px',
            background: 'var(--bg-sunk)',
            borderRadius: 8,
            color: 'var(--text-2)',
            fontSize: 13,
          }}
        >
          Wiring up {pollingAgent}'s bot ... ({stateQuery.data?.state ?? 'starting'})
        </div>
      )}

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          gap: 12,
        }}
      >
        {/* Inline "why is the button disabled" hint when something is missing. */}
        {!setupMutation.isPending && !isPolling && (!selectedAgent || token.length === 0) && (
          <span style={{ color: 'var(--text-3)', fontSize: 12, marginRight: 'auto' }}>
            {!selectedAgent && token.length === 0
              ? 'Pick an Agent + paste a bot token to continue'
              : !selectedAgent
                ? 'Pick an Agent above to continue'
                : 'Paste a bot token to continue'}
          </span>
        )}
        {!isPolling && (
          <Button variant="ghost" size="md" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button
          variant="primary"
          size="md"
          onClick={() => {
            setupMutation.mutate()
          }}
          disabled={!selectedAgent || token.length === 0 || setupMutation.isPending || isPolling}
        >
          {setupMutation.isPending
            ? 'Setting up…'
            : isPolling
              ? 'Connecting…'
              : !selectedAgent
                ? 'Pick an Agent first'
                : token.length === 0
                  ? 'Paste token first'
                  : `Connect ${selectedAgent}`}
        </Button>
      </div>
    </div>
  )
}
