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
import { ApiError, NetworkError, api, type Agent } from '../../lib/api'
import {
  AgentMark,
  Button,
  Card,
  ErrorState,
  KV,
  LoadingState,
  PageHeader,
  Pill,
  type PillVariant,
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
                <Pill variant={pillVariant(agent.status)}>{pillLabel(agent.status)}</Pill>
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

          <section>
            <SectionHeader title="DEFERRED · ARRIVES IN A LATER PR" />
            <Card padding={20}>
              <p className={styles.advisory}>
                Brain notes preview, schedule list, budget summary, and tool list will land with
                their respective backend endpoints. Phase A's headline criterion (live status) is
                what this screen proves today.
              </p>
            </Card>
          </section>
        </>
      ) : null}
    </main>
  )
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
