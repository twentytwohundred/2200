/**
 * Per-Agent tool inspector ... read-only view of the MCP servers
 * declared in the Agent's Identity + the dispatcher's tool-health
 * summary aggregated off Brain run records.
 *
 * Tool installation, OAuth credential management, and Identity
 * editing all happen via the CLI at v1; this screen is the
 * inspection surface that answers "which tools does this Agent
 * have, and how are they performing?"
 */
import type { ReactElement } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  ApiError,
  NetworkError,
  api,
  type McpServerInfo,
  type ToolHealthEntry,
} from '../../lib/api'
import {
  Card,
  EmptyState,
  ErrorState,
  KV,
  LoadingState,
  PageHeader,
  Pill,
  SectionHeader,
} from '../../primitives'
import { ThemeSwitcher } from '../../theme/ThemeSwitcher'
import { useTheme } from '../../theme/ThemeProvider'
import styles from './ToolsScreen.module.css'

function formatTime(value: string | null): string {
  if (!value) return '—'
  try {
    return new Date(value).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'
  } catch {
    return value
  }
}

function formatError(err: unknown): string {
  if (err instanceof ApiError) return `${err.code}: ${err.message}`
  if (err instanceof NetworkError) return 'Cannot reach the runtime.'
  return err instanceof Error ? err.message : String(err)
}

function pillForTool(t: ToolHealthEntry) {
  if (t.dormant) return <Pill variant="idle">DORMANT</Pill>
  if (t.recent_failure_rate > 0.25) return <Pill variant="error">FAILING</Pill>
  return <Pill variant="info">OK</Pill>
}

export function ToolsScreen(): ReactElement {
  const { name } = useParams<{ name: string }>()
  const { theme } = useTheme()

  const query = useQuery({
    queryKey: ['agent-tools', name],
    queryFn: () => {
      if (!name) throw new Error('agent name missing from route')
      return api.agentTools(name)
    },
    enabled: Boolean(name),
    staleTime: 10_000,
  })

  const eyebrow = `2200 · TOOLS · ${(name ?? '').toUpperCase()} · ${theme.toUpperCase()}`

  return (
    <main className={styles.shell}>
      <PageHeader
        eyebrow={eyebrow}
        title={`Tools · ${name ?? ''}`}
        subtitle="MCP servers declared by this Agent + run-record health summary."
        actions={
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <Link
              to={`/agent/${encodeURIComponent(name ?? '')}`}
              style={{
                fontFamily: 'var(--type-family-mono)',
                fontSize: '11px',
                letterSpacing: '0.08em',
                color: 'var(--color-text-muted)',
                textDecoration: 'none',
              }}
            >
              ← AGENT
            </Link>
            <ThemeSwitcher />
          </div>
        }
      />

      {query.isLoading ? (
        <Card padding={20}>
          <LoadingState rows={4} />
        </Card>
      ) : query.isError ? (
        <Card padding={0}>
          <ErrorState title="Could not load tools" body={formatError(query.error)} />
        </Card>
      ) : query.data ? (
        <>
          <section>
            <SectionHeader title={`MCP SERVERS · ${String(query.data.mcp_servers.length)}`} />
            {query.data.mcp_servers.length === 0 ? (
              <Card padding={0}>
                <EmptyState
                  title="No MCP servers"
                  body="The Identity declares no mcp_servers[]. Use `2200 agent edit` to add one, or assign Skills via `2200 skill install`."
                />
              </Card>
            ) : (
              <div className={styles.serverList}>
                {query.data.mcp_servers.map((s) => (
                  <ServerCard key={s.name} server={s} />
                ))}
              </div>
            )}
          </section>

          <section>
            <SectionHeader
              title={`TOOL HEALTH · ${String(query.data.health?.tools.length ?? 0)}`}
            />
            {query.data.health ? (
              <Card padding={0}>
                {query.data.health.tools.length === 0 ? (
                  <EmptyState
                    title="No tool activity yet"
                    body="The Agent has not invoked any tools whose runs were recorded to its Brain."
                  />
                ) : (
                  <table className={styles.healthGrid}>
                    <thead>
                      <tr>
                        <th>TOOL</th>
                        <th>STATE</th>
                        <th className="numeric">CALLS</th>
                        <th className="numeric">OK</th>
                        <th className="numeric">ERR</th>
                        <th className="numeric">RECENT FAIL</th>
                        <th className="numeric">MEAN MS</th>
                        <th>LAST CALLED</th>
                      </tr>
                    </thead>
                    <tbody>
                      {query.data.health.tools.map((t) => (
                        <tr key={t.tool}>
                          <td>{t.tool}</td>
                          <td>{pillForTool(t)}</td>
                          <td className={styles.numeric}>{String(t.total_calls)}</td>
                          <td className={styles.numeric}>{String(t.ok_calls)}</td>
                          <td className={styles.numeric}>{String(t.error_calls)}</td>
                          <td className={styles.numeric}>
                            {(t.recent_failure_rate * 100).toFixed(0)}%
                          </td>
                          <td className={styles.numeric}>{Math.round(t.mean_duration_ms)}</td>
                          <td>{formatTime(t.last_called_at)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Card>
            ) : (
              <Card padding={20}>
                <KV
                  k="HEALTH"
                  v={
                    <span style={{ color: 'var(--color-text-muted)' }}>
                      no run records for this Agent yet
                    </span>
                  }
                />
              </Card>
            )}
          </section>

          <section>
            <SectionHeader title="HOW TO ADD" />
            <div className={styles.callout}>
              <div className={styles.calloutLabel}>v1 management surface</div>
              <div className={styles.calloutBody}>
                Tool installation, OAuth credential setup, and Identity edits all happen via the
                CLI: <code>2200 agent edit</code> for the Identity, <code>2200 oauth login</code>{' '}
                for credentials, <code>2200 skill install</code> for Skills,{' '}
                <code>2200 extension install</code> for Extensions. Web-app surface for these is
                deferred to a later phase.
              </div>
            </div>
          </section>
        </>
      ) : null}
    </main>
  )
}

interface ServerCardProps {
  server: McpServerInfo
}

function ServerCard({ server }: ServerCardProps): ReactElement {
  return (
    <div className={styles.serverCard}>
      <div className={styles.serverHead}>
        <span className={styles.serverName}>{server.name}</span>
        <Pill variant="info">{server.transport.toUpperCase()}</Pill>
        {server.transport === 'http' && server.auth_kind ? (
          server.auth_kind === 'bearer' ? (
            <Pill variant="attention">BEARER</Pill>
          ) : (
            <Pill variant="idle">NO AUTH</Pill>
          )
        ) : null}
      </div>
      <div className={styles.serverDetails}>
        {server.transport === 'stdio' ? (
          <>
            <div>command · {server.command ?? '?'}</div>
            <div>args · {server.arg_count !== undefined ? String(server.arg_count) : '?'}</div>
          </>
        ) : (
          <div>url · {server.url ?? '?'}</div>
        )}
      </div>
      {server.transport === 'stdio' && server.env_keys && server.env_keys.length > 0 ? (
        <div className={styles.serverChips}>
          {server.env_keys.map((k) => (
            <span key={k} className={styles.envChip}>
              {k}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  )
}
