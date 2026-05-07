/**
 * Agent detail screen ... Identity Card variant per
 * wiki/design-system/decision-log.md.
 *
 * Hero is the AgentMark + name + status pill (the "who"). Beneath
 * sits a KV stack with the operational fields (the "what"). Quick
 * actions (Pause / Resume) live in the page header. The status pill
 * updates live without a refresh via the WebSocket subscription.
 */
import type { ReactElement } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ApiError,
  NetworkError,
  api,
  type Agent,
  type BudgetResponse,
  type ListEnvelope,
  type Notification,
} from '../../lib/api'
import {
  AgentMark,
  Button,
  Card,
  EmptyState,
  ErrorState,
  KV,
  LoadingState,
  PageHeader,
  Pill,
  type PillVariant,
  ProgressBar,
  PulseDot,
  SectionHeader,
} from '../../primitives'
import { ThemeSwitcher } from '../../theme/ThemeSwitcher'
import { useTheme } from '../../theme/ThemeProvider'
import { useLiveSignal } from '../../ws/useLiveSignal'
import styles from './AgentDetailScreen.module.css'

function pillVariant(status: string): PillVariant {
  if (status === 'running') return 'running'
  if (status === 'waiting') return 'info'
  if (status === 'errored') return 'error'
  if (status.startsWith('blocked_')) return 'attention'
  return 'idle'
}

function pillLabel(status: string): string {
  if (status === 'blocked_on_user') return 'NEEDS YOU'
  if (status === 'blocked_on_agent') return 'BLOCKED'
  if (status === 'blocked_on_detector') return 'PAUSED'
  return status.toUpperCase().replace(/_/g, ' ')
}

function formatTimestamp(value: string | null): string {
  if (!value) return '—'
  try {
    const d = new Date(value)
    if (Number.isNaN(d.getTime())) return value
    return d.toISOString().replace('T', ' ').slice(0, 19) + ' UTC'
  } catch {
    return value
  }
}

export function AgentDetailScreen(): ReactElement {
  const { name } = useParams<{ name: string }>()
  const { theme } = useTheme()
  const live = useLiveSignal()
  const queryClient = useQueryClient()

  const query = useQuery({
    queryKey: ['agents', name],
    queryFn: () => {
      if (!name) throw new Error('agent name missing from route')
      return api.agent(name)
    },
    enabled: Boolean(name),
    staleTime: 5_000,
  })

  const startMutation = useMutation({
    mutationFn: (agent: string) => api.agentStart(agent),
    onSuccess: (data) => {
      queryClient.setQueryData(['agents', name], data)
      void queryClient.invalidateQueries({ queryKey: ['agents'] })
    },
  })

  const stopMutation = useMutation({
    mutationFn: (agent: string) => api.agentStop(agent, 'web_request'),
    onSuccess: (data) => {
      queryClient.setQueryData(['agents', name], data)
      void queryClient.invalidateQueries({ queryKey: ['agents'] })
    },
  })

  // Recent notifications scoped to this Agent. v1 shows the most
  // recent five regardless of state so the user can spot pending
  // asks, recent answers, and dismissals at a glance.
  const notificationsQuery = useQuery({
    queryKey: ['notifications', { agent: name }],
    queryFn: () => {
      if (!name) throw new Error('agent name missing from route')
      return api.notifications({ agent: name })
    },
    enabled: Boolean(name),
    staleTime: 10_000,
  })

  // Today's budget snapshot. The dedicated /budget screen still owns
  // the full per-day history + overrides UI; the inline view here is
  // a "is this Agent close to its cap?" health check.
  const budgetQuery = useQuery({
    queryKey: ['budget', name],
    queryFn: () => {
      if (!name) throw new Error('agent name missing from route')
      return api.budget(name)
    },
    enabled: Boolean(name),
    staleTime: 10_000,
  })

  const agent = query.data
  const eyebrow = `2200 · AGENT · ${(name ?? '').toUpperCase()} · ${theme.toUpperCase()} · WS ${live.status.toUpperCase()}`

  const pendingMutation = startMutation.isPending || stopMutation.isPending
  const mutationError =
    startMutation.error instanceof Error
      ? startMutation.error
      : stopMutation.error instanceof Error
        ? stopMutation.error
        : null

  return (
    <main className={styles.shell}>
      <PageHeader
        eyebrow={eyebrow}
        title={name ?? 'Agent'}
        subtitle="Identity, status, and quick actions for this Agent."
        actions={
          <div className={styles.headerActions}>
            <Link to="/" className={styles.back}>
              ← Fleet
            </Link>
            <Link to={`/agent/${encodeURIComponent(name ?? '')}/brain`} className={styles.back}>
              BRAIN →
            </Link>
            <Link to={`/agent/${encodeURIComponent(name ?? '')}/schedules`} className={styles.back}>
              SCHEDULES →
            </Link>
            <ThemeSwitcher />
          </div>
        }
      />

      {query.isLoading ? (
        <Card padding={20}>
          <LoadingState rows={6} />
        </Card>
      ) : query.isError ? (
        <Card padding={0}>
          <ErrorState
            title={errorTitle(query.error)}
            body={errorBody(query.error)}
            action={
              <Button
                size="sm"
                onClick={() => {
                  void query.refetch()
                }}
              >
                Retry
              </Button>
            }
          />
        </Card>
      ) : agent ? (
        <>
          <Card padding={24} elevated>
            <div className={styles.hero}>
              <AgentMark id={agent.name} name={agent.name} size="xl" solid />
              <div className={styles.heroText}>
                <h2 className={styles.heroName}>{agent.name}</h2>
                <div className={styles.heroStatusRow}>
                  <Pill variant={pillVariant(agent.status)}>{pillLabel(agent.status)}</Pill>
                  {agent.pulse && (
                    <PulseDot
                      state={agent.pulse.state}
                      intensity={agent.pulse.intensity}
                      size="md"
                    />
                  )}
                </div>
                {agent.errored_reason ? (
                  <p className={styles.heroError}>
                    <span className={styles.heroErrorLabel}>ERRORED:</span> {agent.errored_reason}
                  </p>
                ) : null}
              </div>
              <div className={styles.heroActions}>
                {agent.status === 'running' || agent.status === 'waiting' ? (
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={pendingMutation}
                    onClick={() => {
                      stopMutation.mutate(agent.name)
                    }}
                  >
                    {stopMutation.isPending ? 'Stopping…' : 'Stop'}
                  </Button>
                ) : (
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={pendingMutation}
                    onClick={() => {
                      startMutation.mutate(agent.name)
                    }}
                  >
                    {startMutation.isPending ? 'Starting…' : 'Start'}
                  </Button>
                )}
              </div>
            </div>
          </Card>

          {mutationError ? (
            <Card padding={0}>
              <ErrorState
                title="Action failed"
                body={
                  mutationError instanceof ApiError
                    ? `${mutationError.code}: ${mutationError.message}`
                    : mutationError.message
                }
              />
            </Card>
          ) : null}

          <section>
            <SectionHeader title="STATUS" />
            <Card padding={20}>
              <KV k="STATE" v={<span className={styles.mono}>{agent.status}</span>} />
              <KV
                k="PID"
                v={
                  <span className={styles.mono}>
                    {agent.pid !== null ? String(agent.pid) : '—'}
                  </span>
                }
              />
              <KV
                k="TASK"
                v={
                  <span className={styles.mono}>
                    {agent.current_task_id ?? <span className={styles.muted}>none</span>}
                  </span>
                }
              />
              <KV
                k="PULSE"
                v={
                  agent.pulse ? (
                    <span className={styles.pulseRow}>
                      <PulseDot
                        state={agent.pulse.state}
                        intensity={agent.pulse.intensity}
                        size="sm"
                      />
                      <span className={styles.mono}>
                        {agent.pulse.state} · {agent.pulse.intensity.toFixed(2)}
                      </span>
                    </span>
                  ) : (
                    <span className={styles.muted}>(no pulse data)</span>
                  )
                }
              />
              <KV
                k="HEARTBEAT"
                v={<span className={styles.mono}>{formatTimestamp(agent.last_heartbeat)}</span>}
              />
              <KV
                k="SPAWNED"
                v={<span className={styles.mono}>{formatTimestamp(agent.spawned_at)}</span>}
              />
              {agent.errored_at ? (
                <KV
                  k="ERR AT"
                  v={<span className={styles.mono}>{formatTimestamp(agent.errored_at)}</span>}
                />
              ) : null}
            </Card>
          </section>

          <section>
            <SectionHeader title="IDENTITY" />
            <Card padding={20}>
              <KV
                k="PATH"
                v={
                  <span className={styles.monoPath} title={agent.identity_path}>
                    {agent.identity_path}
                  </span>
                }
                kw={64}
              />
              <p className={styles.advisory}>
                The Agent record's identity is loaded from this path. Edit the markdown there and
                bounce the Agent to pick up changes.
              </p>
            </Card>
          </section>

          <BudgetSection name={agent.name} query={budgetQuery} />

          <ActivitySection name={agent.name} query={notificationsQuery} />

          <section>
            <SectionHeader title="MORE FOR THIS AGENT" />
            <Card padding={20}>
              <div className={styles.moreLinks}>
                <Link
                  to={`/agent/${encodeURIComponent(agent.name)}/brain`}
                  className={styles.moreLink}
                >
                  <span className={styles.moreLinkLabel}>BRAIN →</span>
                  <span className={styles.moreLinkBody}>
                    Search this Agent's notes by title, tags, or full text. Read individual notes
                    inline.
                  </span>
                </Link>
                <Link
                  to={`/agent/${encodeURIComponent(agent.name)}/schedules`}
                  className={styles.moreLink}
                >
                  <span className={styles.moreLinkLabel}>SCHEDULES →</span>
                  <span className={styles.moreLinkBody}>
                    View, add, enable, disable, or delete cron + interval timers for this Agent.
                  </span>
                </Link>
                <Link
                  to={`/agent/${encodeURIComponent(agent.name)}/tools`}
                  className={styles.moreLink}
                >
                  <span className={styles.moreLinkLabel}>TOOLS →</span>
                  <span className={styles.moreLinkBody}>
                    MCP servers from the Identity + tool-health summary across this Agent's runs.
                  </span>
                </Link>
              </div>
            </Card>
          </section>
        </>
      ) : null}
    </main>
  )
}

interface BudgetSectionProps {
  name: string
  query: ReturnType<typeof useQuery<BudgetResponse>>
}

function BudgetSection({ name, query }: BudgetSectionProps): ReactElement {
  const today = query.data?.today ?? null
  const override = query.data?.override ?? null
  return (
    <section>
      <SectionHeader
        title="BUDGET · TODAY"
        action={
          <Link to={`/budget?agent=${encodeURIComponent(name)}`} className={styles.sectionLink}>
            FULL LEDGER →
          </Link>
        }
      />
      <Card padding={20}>
        {query.isLoading ? (
          <LoadingState rows={2} />
        ) : query.isError ? (
          <ErrorState
            title="Could not load budget"
            body={query.error instanceof Error ? query.error.message : String(query.error)}
          />
        ) : today ? (
          <>
            <div className={styles.budgetHero}>
              <span>
                <span className={styles.budgetAmount}>{fmtUsd(today.cumulative_usd)}</span>
                <span className={styles.budgetOf}>of {fmtUsd(today.cap_usd)}</span>
              </span>
              {today.blocked ? (
                <Pill variant="error">BLOCKED</Pill>
              ) : today.warned_today ? (
                <Pill variant="attention">WARNED</Pill>
              ) : (
                <Pill variant="info">OK</Pill>
              )}
            </div>
            <ProgressBar
              value={today.cumulative_usd}
              max={today.cap_usd}
              variant={today.blocked ? 'error' : today.warned_today ? 'attention' : 'auto'}
            />
            {override ? (
              <KV
                k="OVERRIDE"
                v={
                  <span className={styles.mono}>
                    until {override.until}
                    {override.reason ? ` · ${override.reason}` : ''}
                  </span>
                }
              />
            ) : null}
          </>
        ) : (
          <EmptyState
            title="No spend yet today"
            body="The Agent has not made a model call today."
          />
        )}
      </Card>
    </section>
  )
}

interface ActivitySectionProps {
  name: string
  query: ReturnType<typeof useQuery<ListEnvelope<Notification>>>
}

function ActivitySection({ name, query }: ActivitySectionProps): ReactElement {
  const items: Notification[] = (query.data?.items ?? []).slice(0, 5)
  return (
    <section>
      <SectionHeader
        title="RECENT NOTIFICATIONS"
        action={
          <Link to={`/inbox?agent=${encodeURIComponent(name)}`} className={styles.sectionLink}>
            INBOX →
          </Link>
        }
      />
      <Card padding={20}>
        {query.isLoading ? (
          <LoadingState rows={3} />
        ) : query.isError ? (
          <ErrorState
            title="Could not load notifications"
            body={query.error instanceof Error ? query.error.message : String(query.error)}
          />
        ) : items.length === 0 ? (
          <EmptyState
            title="No notifications"
            body="This Agent has not emitted any notifications yet."
          />
        ) : (
          <div className={styles.activityList}>
            {items.map((n) => (
              <div key={n.id} className={styles.activityRow}>
                <Pill variant={tierVariant(n.tier)} dot={false}>
                  {n.tier.toUpperCase()}
                </Pill>
                <span className={styles.activityKind}>{n.kind}</span>
                <span className={styles.activityBody} title={n.body}>
                  {n.body || <span className={styles.muted}>(no body)</span>}
                </span>
                <span className={styles.activityTime}>{n.ts.slice(11, 19)}</span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </section>
  )
}

function fmtUsd(n: number): string {
  return `$${n.toFixed(2)}`
}

function tierVariant(tier: string): PillVariant {
  if (tier === 'critical') return 'error'
  if (tier === 'important') return 'attention'
  if (tier === 'normal') return 'info'
  return 'idle'
}

function errorTitle(error: unknown): string {
  if (error instanceof ApiError && error.status === 401) return 'Not authorized'
  if (error instanceof ApiError && error.status === 404) return 'Agent not found'
  if (error instanceof NetworkError) return 'Cannot reach the runtime'
  return 'Could not load this Agent'
}

function errorBody(error: unknown): string {
  if (error instanceof ApiError && error.status === 401) {
    return 'The bearer token is missing or invalid. Run `2200 web token rotate` and follow the URL it prints.'
  }
  if (error instanceof ApiError && error.status === 404) {
    return 'No Agent with that name lives on this instance. The fleet view has the active roster.'
  }
  if (error instanceof NetworkError) {
    return 'The supervisor may not be running. Try `2200 daemon start` and refresh.'
  }
  if (error instanceof ApiError) {
    return `${error.code}: ${error.message}`
  }
  return error instanceof Error ? error.message : String(error)
}

export type { Agent }
