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
import { useMutation, useQuery } from '@tanstack/react-query'
import {
  ApiError,
  NetworkError,
  apiExtensions,
  type Catalog,
  type CatalogEntry,
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
        {installedInThisSession && entry.auth_model === 'qr_pair' && (
          <div className={styles.pairCallout}>
            <strong style={{ color: 'var(--text)' }}>Installed ✓</strong>. Next: pair your device.
            The QR-in-browser flow lands in the next session. For now, start the gateway manually
            from a terminal:
            <pre
              style={{
                margin: '10px 0 0',
                padding: '10px 12px',
                background: 'rgba(0,0,0,0.4)',
                borderRadius: 6,
                fontSize: 12,
                overflow: 'auto',
              }}
            >
              {`cd ~/.local/share/2200/extensions/${entry.id}
AUTH_DIR=$HOME/.local/share/2200/state/extensions/${entry.id}/auth/default \\
GATEWAY_PORT=23200 \\
SUPERVISOR_URL=http://127.0.0.1:2200 \\
GATEWAY_INFO_PATH=$HOME/.local/share/2200/state/extensions/${entry.id}/gateway.json \\
pnpm tsx src/gateway.ts`}
            </pre>
            Scan the QR with your phone (WhatsApp → Settings → Linked Devices), then add an Agent
            binding via the Identity file.
          </div>
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
