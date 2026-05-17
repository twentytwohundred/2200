/**
 * Extensions Store screen.
 *
 * Browses the curated catalog (fetched from the supervisor's
 * `/api/v1/extensions/catalog` endpoint, which sources from
 * `extensions-catalog/v1.json` in dev and 2200.ai-hosted JSON in
 * production). Lets the operator install an Extension with a
 * permission + ToS modal, then surfaces a pair flow or per-Agent
 * setup flow inline on the card.
 *
 * Persistent installed state comes from
 * `/api/v1/extensions/installed`, which the runtime computes from
 * `<home>/extensions/<id>/manifest.json` plus each Agent's
 * identity.md `connectors` block plus live gateway state. The
 * "Installed" tab + ConfigureView read from this so refreshing the
 * page does not erase the installed signal (the prior version held
 * install state in React-local memory and lost it on reload).
 *
 * Decisions:
 *   - [[../../decisions/2026-05-16-connector-store]]
 *   - [[../../decisions/2026-05-16-connector-extensions]]
 *   - [[../../decisions/2026-05-16-connector-per-agent-identity]]
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
  type InstalledExtensionEntry,
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
  const [expandedConfig, setExpandedConfig] = useState<string | null>(null)
  // Cards that just completed install in this session expand their
  // setup flow inline (pair / per-Agent). The server-side `installed`
  // query is authoritative for the "Installed" pill; this just tracks
  // which cards should auto-expand their inline setup section.
  const [recentInstalls, setRecentInstalls] = useState<Set<string>>(new Set())

  const catalogQuery = useQuery({
    queryKey: ['extensionsCatalog'],
    queryFn: () => apiExtensions.catalog(),
  })

  const installedQuery = useQuery({
    queryKey: ['extensionsInstalled'],
    queryFn: () => apiExtensions.installed(),
    refetchInterval: 4000,
  })

  const installedMap = useMemo(() => {
    const map = new Map<string, InstalledExtensionEntry>()
    for (const item of installedQuery.data?.items ?? []) {
      map.set(item.id, item)
    }
    return map
  }, [installedQuery.data])

  const entries = useMemo(
    () => filterEntries(catalogQuery.data, tab, installedMap),
    [catalogQuery.data, tab, installedMap],
  )

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
          Installed {installedMap.size > 0 && `(${String(installedMap.size)})`}
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
        {entries.map((entry) => {
          const installed = installedMap.get(entry.id) ?? null
          const isExpanded = expandedConfig === entry.id || recentInstalls.has(entry.id)
          return (
            <ExtensionCard
              key={entry.id}
              entry={entry}
              installed={installed}
              isExpanded={isExpanded}
              onInstall={() => {
                setInstallModalEntry(entry)
              }}
              onToggleConfigure={() => {
                setExpandedConfig((cur) => (cur === entry.id ? null : entry.id))
                // Clicking "Installed" pill stops treating this entry
                // as "just-installed" (the recentInstalls auto-expand);
                // user is now in explicit configure mode.
                setRecentInstalls((prev) => {
                  if (!prev.has(entry.id)) return prev
                  const next = new Set(prev)
                  next.delete(entry.id)
                  return next
                })
              }}
            />
          )
        })}
      </div>

      {installModalEntry && (
        <InstallModal
          entry={installModalEntry}
          onClose={() => {
            setInstallModalEntry(null)
          }}
          onComplete={() => {
            const id = installModalEntry.id
            setRecentInstalls((prev) => {
              const next = new Set(prev)
              next.add(id)
              return next
            })
            setInstallModalEntry(null)
          }}
        />
      )}
    </Screen>
  )
}

function filterEntries(
  catalog: Catalog | undefined,
  tab: Tab,
  installedMap: Map<string, InstalledExtensionEntry>,
): CatalogEntry[] {
  if (!catalog) return []
  if (tab === 'connectors') return catalog.extensions.filter((e) => e.category === 'connector')
  if (tab === 'installed') return catalog.extensions.filter((e) => installedMap.has(e.id))
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
  installed: InstalledExtensionEntry | null
  isExpanded: boolean
  onInstall: () => void
  onToggleConfigure: () => void
}

function ExtensionCard({
  entry,
  installed,
  isExpanded,
  onInstall,
  onToggleConfigure,
}: ExtensionCardProps): ReactElement {
  const isInstalled = installed !== null
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
        {isInstalled && isExpanded && (
          <ConfigureView entry={entry} installed={installed} onClose={onToggleConfigure} />
        )}
      </div>
      <div className={styles.actions}>
        <span className={styles.status} data-tone={isInstalled ? 'ok' : undefined}>
          {isInstalled ? `installed · v${entry.current_version}` : `v${entry.current_version}`}
        </span>
        {isInstalled ? (
          <Button variant="ghost" size="md" onClick={onToggleConfigure}>
            {isExpanded ? 'Hide' : 'Installed ✓ Configure'}
          </Button>
        ) : (
          <Button variant="primary" size="md" onClick={onInstall}>
            Install
          </Button>
        )}
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
  const queryClient = useQueryClient()
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
        setTimeout(() => {
          // Refresh the installed list so the card's "Installed" pill
          // appears on the next render. Without this, the card stays
          // on "Install" until the 4s poll catches up.
          void queryClient.invalidateQueries({ queryKey: ['extensionsInstalled'] })
          onComplete()
        }, 600)
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

// ---------------------------------------------------------------------------
// ConfigureView: opens under an installed card when the "Installed ✓"
// pill is clicked. Routes to the right inline editor based on the
// catalog entry's auth_model and account_scope. The shared layout +
// header live here; the per-auth-model editors are below.
// ---------------------------------------------------------------------------

interface ConfigureViewProps {
  entry: CatalogEntry
  installed: InstalledExtensionEntry
  onClose: () => void
}

function ConfigureView({ entry, installed, onClose }: ConfigureViewProps): ReactElement {
  // Per-Agent connectors (Discord, future Telegram/Slack) get the
  // per-Agent management view. Pair-once connectors (WhatsApp Inbox)
  // get the extension-level pair view.
  const isPerAgent = entry.account_scope === 'agent'
  return (
    <div className={styles.pairCallout}>
      <div className={styles.pairHeader}>
        <span className={styles.pairTitle}>Configure {entry.label}</span>
        <span className={styles.pairStatus}>
          {isPerAgent
            ? `${String(installed.bindings.length)} Agent${installed.bindings.length === 1 ? '' : 's'} wired`
            : installed.extension_gateway?.pair_state === 'paired'
              ? 'paired'
              : 'not paired'}
        </span>
      </div>
      {isPerAgent ? (
        <PerAgentManagement entry={entry} installed={installed} />
      ) : (
        <ExtensionPairManagement entry={entry} installed={installed} />
      )}
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Button variant="ghost" size="md" onClick={onClose}>
          Done
        </Button>
      </div>
    </div>
  )
}

function PerAgentManagement({
  entry,
  installed,
}: {
  entry: CatalogEntry
  installed: InstalledExtensionEntry
}): ReactElement {
  const [addingAgent, setAddingAgent] = useState(installed.bindings.length === 0)
  const excludeAgents = installed.bindings.map((b) => b.agent)
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {installed.bindings.map((b) => (
        <BindingRow key={b.agent} extensionId={entry.id} binding={b} />
      ))}
      {addingAgent ? (
        <AgentSetupPanel
          entry={entry}
          excludeAgents={excludeAgents}
          onConnected={() => {
            setAddingAgent(false)
          }}
          onCancel={() => {
            if (installed.bindings.length > 0) setAddingAgent(false)
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
    </div>
  )
}

function BindingRow({
  extensionId,
  binding,
}: {
  extensionId: string
  binding: InstalledExtensionEntry['bindings'][number]
}): ReactElement {
  const queryClient = useQueryClient()
  const restart = useMutation({
    mutationFn: () => apiExtensions.pairStart(extensionId, binding.agent),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['extensionsInstalled'] })
    },
  })
  // Inline channel-allowlist editor (Discord only for now ... other
  // per-Agent connectors land their own UX as they ship).
  const currentChannel = binding.allowlist_group[0] ?? ''
  const [channelInput, setChannelInput] = useState(currentChannel)
  const [channelError, setChannelError] = useState<string | null>(null)
  const channelDirty = channelInput.trim() !== currentChannel
  const savePolicy = useMutation({
    mutationFn: () =>
      apiExtensions.policyUpdate(extensionId, binding.agent, {
        allowlist_group: channelInput.trim() ? [channelInput.trim()] : [],
      }),
    onSuccess: () => {
      setChannelError(null)
      void queryClient.invalidateQueries({ queryKey: ['extensionsInstalled'] })
    },
    onError: (err) => {
      setChannelError(formatError(err))
    },
  })
  // For Discord: the bot's client_id (= bot_user_id) lets us
  // regenerate the OAuth invite URL. The same permission integer
  // (85056) covers View Channel + Send + Embed + History + Reactions.
  const inviteUrl = binding.bot_user_id
    ? `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(binding.bot_user_id)}&scope=bot&permissions=85056`
    : null

  return (
    <div
      style={{
        padding: '14px 16px',
        background: 'var(--bg)',
        border: '1px solid var(--line)',
        borderRadius: 10,
        display: 'grid',
        gap: 10,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
        }}
      >
        <div>
          <strong style={{ color: 'var(--text)' }}>{binding.agent}</strong>
          {binding.bot_username && (
            <>
              {' '}
              <span style={{ color: 'var(--text-2)' }}>as</span>{' '}
              <strong style={{ color: 'var(--text)' }}>@{binding.bot_username}</strong>
            </>
          )}
        </div>
        <span
          style={{
            fontFamily: 'JetBrains Mono, ui-monospace, monospace',
            fontSize: 11,
            color: binding.gateway_running ? 'var(--accent)' : 'var(--text-3)',
            letterSpacing: '0.05em',
            textTransform: 'uppercase',
          }}
        >
          {binding.gateway_running ? '● gateway running' : '○ gateway stopped'}
        </span>
      </div>
      {binding.pair_state_detail && binding.pair_state !== 'paired' && (
        <div style={{ color: 'var(--text-3)', fontSize: 12 }}>{binding.pair_state_detail}</div>
      )}
      {extensionId === 'discord' && (
        <div style={{ display: 'grid', gap: 6 }}>
          <div
            style={{
              fontFamily: 'JetBrains Mono, ui-monospace, monospace',
              fontSize: 10,
              color: 'var(--text-3)',
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
            }}
          >
            Channel ID
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input
              type="text"
              value={channelInput}
              onChange={(e) => {
                setChannelInput(e.target.value)
                setChannelError(null)
              }}
              placeholder="e.g. 1505299465865527418"
              inputMode="numeric"
              pattern="[0-9]*"
              style={{
                flex: 1,
                padding: '7px 10px',
                background: 'var(--bg-sunk)',
                color: 'var(--text)',
                border: '1px solid var(--line)',
                borderRadius: 6,
                fontSize: 12,
                fontFamily: 'JetBrains Mono, ui-monospace, monospace',
              }}
            />
            <Button
              variant="primary"
              size="md"
              onClick={() => {
                if (channelInput.trim() && !/^\d+$/.test(channelInput.trim())) {
                  setChannelError('Channel IDs are numeric (Discord snowflakes).')
                  return
                }
                savePolicy.mutate()
              }}
              disabled={!channelDirty || savePolicy.isPending}
            >
              {savePolicy.isPending ? 'Saving…' : 'Save'}
            </Button>
          </div>
          {channelError && (
            <div style={{ color: 'var(--danger)', fontSize: 11 }}>{channelError}</div>
          )}
          {!currentChannel && !channelInput && (
            <div style={{ color: 'var(--text-3)', fontSize: 11, lineHeight: 1.5 }}>
              No channel pinned. Enable Developer Mode in Discord (Settings → Advanced), right-click
              the channel you want this Agent in, choose <strong>Copy Channel ID</strong>, paste
              here. Every message in that channel wakes the Agent.
            </div>
          )}
        </div>
      )}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        {inviteUrl && (
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
            Invite {binding.agent}'s bot to a server →
          </a>
        )}
        {!binding.gateway_running && (
          <Button
            variant="ghost"
            size="md"
            onClick={() => {
              restart.mutate()
            }}
            disabled={restart.isPending}
          >
            {restart.isPending ? 'Starting…' : 'Start gateway'}
          </Button>
        )}
        <span
          style={{
            color: 'var(--text-3)',
            fontSize: 11,
            fontFamily: 'monospace',
            marginLeft: 'auto',
          }}
        >
          {extensionId}/{binding.agent}
        </span>
      </div>
      {restart.isError && (
        <div className={styles.pairError}>
          Could not start the gateway: {formatError(restart.error)}
        </div>
      )}
    </div>
  )
}

function ExtensionPairManagement({
  entry,
  installed,
}: {
  entry: CatalogEntry
  installed: InstalledExtensionEntry
}): ReactElement {
  // Extension-scope (WhatsApp Inbox): one gateway per Extension, paired
  // once to the operator's phone. Show pair state + self_jid + a
  // re-pair button that kicks the gateway to render a fresh QR.
  const gateway = installed.extension_gateway
  const isPaired = gateway?.pair_state === 'paired'
  if (isPaired) {
    return (
      <div className={styles.pairSuccess}>
        <div className={styles.pairSuccessIcon}>✓</div>
        <div>
          Paired as <strong>{gateway.self_jid ?? '<unknown>'}</strong>. Messages from allowlisted
          contacts wake bound Agents.
        </div>
      </div>
    )
  }
  return <PairFlow entry={entry} autoStart={gateway?.running ?? false} />
}

interface PairFlowProps {
  entry: CatalogEntry
  /** When true, skip the "Finish install" CTA and poll pair state directly. */
  autoStart?: boolean
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

function PairFlow({ entry, autoStart = false }: PairFlowProps): ReactElement {
  const [started, setStarted] = useState(autoStart)
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
          Click "Finish install" and we'll start the WhatsApp gateway, then surface a QR for you to
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
        For developers running the gateway manually (skipping the supervisor-launch path), the
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
// Per-Agent setup panel (account_scope: 'agent' connectors).
//
// Used both during the post-install "set up your first bot" flow and
// from the ConfigureView's "+ Set up another Agent" action. Wires:
//   1. picks an Agent (skipping any already wired)
//   2. walks the user through getting a Discord bot token
//   3. POSTs to /api/v1/extensions/:id/agents/:agent/setup
//   4. polls /pair/state until paired or errored
//
// On `paired`, calls onConnected so the parent can refresh state. The
// parent invalidates the installedQuery to flip the card's pill to
// "Installed ✓" and refresh the bindings list.
// ---------------------------------------------------------------------------

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
  const [channelId, setChannelId] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pollingAgent, setPollingAgent] = useState<string | null>(null)
  // Discord requires a channel id; other connectors don't (yet).
  const channelRequired = entry.id === 'discord'
  const channelValid = !channelRequired || /^\d+$/.test(channelId.trim())

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
        ...(channelId.trim() ? { allowlist_group: [channelId.trim()] } : {}),
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
  // list AND invalidate the installedQuery so the bindings list
  // refreshes immediately (without waiting for the 4s background poll).
  if (pollingAgent && stateQuery.data?.state === 'paired' && stateQuery.data.self_user) {
    const info = {
      botUsername: stateQuery.data.self_user.username,
      botUserId: stateQuery.data.self_user.id,
    }
    const agent = pollingAgent
    queueMicrotask(() => {
      void queryClient.invalidateQueries({ queryKey: ['extensionsInstalled'] })
      onConnected(agent, info)
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
            All Agents on this instance already have a Discord bot wired up. Build another Agent
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
        <div className={styles.modalLabel}>
          Step 3: Paste the bot token{' '}
          {!token && <span style={{ color: 'var(--danger)' }}>(required)</span>}
        </div>
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

      {/* Channel id input (Discord only for v1) */}
      {channelRequired && (
        <div>
          <div className={styles.modalLabel}>
            Step 4: Paste the Discord channel ID{' '}
            <span style={{ color: 'var(--danger)' }}>(required)</span>
          </div>
          <div className={styles.advancedBody} style={{ marginTop: 8 }}>
            <strong style={{ color: 'var(--text)' }}>How to get a channel ID:</strong>
            <ol style={{ marginTop: 8, paddingLeft: 20, lineHeight: 1.7 }}>
              <li>
                In Discord, open <strong>Settings → Advanced</strong>. Toggle{' '}
                <strong>Developer Mode</strong> on. (Phone: Settings → App Settings → Behavior.)
              </li>
              <li>
                Go to the server / channel you want this Agent to live in. Make a dedicated channel
                if you don't have one (e.g. <code>#{selectedAgent || 'simon'}</code>).
              </li>
              <li>
                Right-click the channel name in the sidebar (long-press on mobile). Pick{' '}
                <strong>Copy Channel ID</strong>.
              </li>
              <li>Paste it below. Every message in that channel wakes this Agent.</li>
            </ol>
            <p style={{ marginTop: 10, color: 'var(--text-3)', fontSize: 12 }}>
              You can't DM Discord bots directly, so the channel is your conversation surface. Treat
              it like a DM ... only you (and the Agent) belong in it.
            </p>
          </div>
          <input
            type="text"
            value={channelId}
            onChange={(e) => {
              setChannelId(e.target.value)
            }}
            placeholder="e.g. 1505299465865527418"
            disabled={isPolling || setupMutation.isPending}
            inputMode="numeric"
            pattern="[0-9]*"
            style={{
              marginTop: 8,
              width: '100%',
              padding: '10px 12px',
              background: 'var(--bg-sunk)',
              color: 'var(--text)',
              border: `1px solid ${channelId && !channelValid ? 'var(--danger)' : 'var(--line)'}`,
              borderRadius: 8,
              fontSize: 13,
              fontFamily: 'JetBrains Mono, ui-monospace, monospace',
            }}
          />
          {channelId && !channelValid && (
            <div style={{ marginTop: 6, color: 'var(--danger)', fontSize: 12 }}>
              Channel IDs are all-numeric Discord snowflakes (no letters, no spaces).
            </div>
          )}
        </div>
      )}

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
        {!setupMutation.isPending &&
          !isPolling &&
          (!selectedAgent ||
            token.length === 0 ||
            (channelRequired && (channelId.trim().length === 0 || !channelValid))) && (
            <span style={{ color: 'var(--text-3)', fontSize: 12, marginRight: 'auto' }}>
              {!selectedAgent
                ? 'Pick an Agent above to continue'
                : token.length === 0
                  ? 'Paste a bot token to continue'
                  : channelRequired && channelId.trim().length === 0
                    ? 'Paste a channel ID to continue'
                    : 'Channel ID must be numeric'}
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
          disabled={
            !selectedAgent ||
            token.length === 0 ||
            (channelRequired && (channelId.trim().length === 0 || !channelValid)) ||
            setupMutation.isPending ||
            isPolling
          }
        >
          {setupMutation.isPending
            ? 'Setting up…'
            : isPolling
              ? 'Connecting…'
              : !selectedAgent
                ? 'Pick an Agent first'
                : token.length === 0
                  ? 'Paste token first'
                  : channelRequired && channelId.trim().length === 0
                    ? 'Paste channel ID first'
                    : `Connect ${selectedAgent}`}
        </Button>
      </div>
    </div>
  )
}
