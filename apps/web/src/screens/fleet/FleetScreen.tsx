/**
 * Fleet screen ... Mission Control variant per
 * wiki/design-system/decision-log.md.
 *
 * Layout: a "needs you" band (errored / blocked agents) on top, a
 * "running" band in the middle, and a compressed "idle" band at the
 * bottom. The status pill on each row updates without a page refresh
 * via the WebSocket subscription in src/ws/useLiveSignal.tsx.
 */
import type { ReactElement } from 'react'
import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api, type Agent, ApiError, NetworkError } from '../../lib/api'
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
  PulseDot,
  SectionHeader,
} from '../../primitives'
import { useNavigate } from 'react-router-dom'
import { useTheme } from '../../theme/ThemeProvider'
import { ThemeSwitcher } from '../../theme/ThemeSwitcher'
import { useLiveSignal } from '../../ws/useLiveSignal'
import styles from './FleetScreen.module.css'

interface BandGroups {
  needsYou: Agent[]
  running: Agent[]
  idle: Agent[]
}

const NEEDS_YOU_STATES = new Set([
  'errored',
  'blocked_on_user',
  'blocked_on_agent',
  'blocked_on_detector',
])
const RUNNING_STATES = new Set(['running', 'waiting'])

function group(agents: Agent[]): BandGroups {
  const out: BandGroups = { needsYou: [], running: [], idle: [] }
  for (const a of agents) {
    if (NEEDS_YOU_STATES.has(a.status)) out.needsYou.push(a)
    else if (RUNNING_STATES.has(a.status)) out.running.push(a)
    else out.idle.push(a)
  }
  return out
}

function pillVariant(status: string): PillVariant {
  if (status === 'running') return 'running'
  if (status === 'waiting') return 'info'
  if (status === 'errored') return 'error'
  if (status.startsWith('blocked_')) return 'attention'
  if (status === 'stopped') return 'idle'
  return 'idle'
}

function pillLabel(status: string): string {
  if (status === 'blocked_on_user') return 'NEEDS YOU'
  if (status === 'blocked_on_agent') return 'BLOCKED'
  if (status === 'blocked_on_detector') return 'PAUSED'
  return status.toUpperCase().replace(/_/g, ' ')
}

export function FleetScreen(): ReactElement {
  const { theme } = useTheme()
  const live = useLiveSignal()
  const navigate = useNavigate()

  const query = useQuery({
    queryKey: ['agents'],
    queryFn: () => api.agents(),
    staleTime: 5_000,
    refetchOnWindowFocus: true,
  })

  const inboxQuery = useQuery({
    queryKey: ['notifications', { state: 'pending' }],
    queryFn: () => api.notifications({ state: 'pending' }),
    staleTime: 5_000,
  })

  const groups = useMemo(() => group(query.data?.items ?? []), [query.data])
  const aggregateStatus = `${theme} · WS ${live.status}`
  const pendingCount = inboxQuery.data?.items.length ?? 0

  return (
    <main className={styles.shell}>
      <PageHeader
        eyebrow={`2200 · FLEET · ${aggregateStatus.toUpperCase()}`}
        title="Fleet"
        subtitle="Mission control for the Agents on this instance. Status pills are live."
        actions={
          <div className={styles.headerActions}>
            <Link to="/studio" className={styles.inboxLink}>
              STUDIO
            </Link>
            <Link to="/inbox" className={styles.inboxLink}>
              INBOX{pendingCount > 0 ? ` · ${String(pendingCount)}` : ''}
            </Link>
            <Link to="/budget" className={styles.inboxLink}>
              BUDGET
            </Link>
            <Link to="/onboarding" className={styles.inboxLink}>
              SPAWN
            </Link>
            <Link to="/settings" className={styles.inboxLink}>
              SETTINGS
            </Link>
            <ThemeSwitcher />
          </div>
        }
      />

      {query.isLoading ? (
        <Card padding={20}>
          <LoadingState rows={5} />
        </Card>
      ) : query.isError ? (
        <Card padding={0}>
          <ErrorState
            title={errorTitle(query.error)}
            body={errorBody(query.error)}
            action={
              <button
                type="button"
                className={styles.retry}
                onClick={() => {
                  void query.refetch()
                }}
              >
                Retry
              </button>
            }
          />
        </Card>
      ) : query.data?.items.length === 0 ? (
        <Card padding={0}>
          <EmptyState
            title="No Agents yet"
            body={
              <>
                Spawn one through the conversational onboarding flow, or run{' '}
                <span className={styles.mono}>2200 agent spawn</span> in your shell. Either way the
                Agent lands here once it's on disk.
              </>
            }
            action={
              <Button
                variant="primary"
                onClick={() => {
                  void navigate('/onboarding')
                }}
              >
                Spawn an Agent
              </Button>
            }
          />
        </Card>
      ) : (
        <div className={styles.bands}>
          <Band
            title={`NEEDS YOU · ${String(groups.needsYou.length)}`}
            agents={groups.needsYou}
            empty="Nothing waiting on you. Quiet is the goal."
            density="comfortable"
          />
          <Band
            title={`RUNNING · ${String(groups.running.length)}`}
            agents={groups.running}
            empty="No Agents running right now."
            density="comfortable"
          />
          <Band
            title={`IDLE · ${String(groups.idle.length)}`}
            agents={groups.idle}
            empty="No idle Agents."
            density="compact"
          />
        </div>
      )}
    </main>
  )
}

interface BandProps {
  title: string
  agents: Agent[]
  empty: string
  density: 'comfortable' | 'compact'
}

function Band({ title, agents, empty, density }: BandProps): ReactElement {
  const listClass = [styles.list, density === 'compact' ? styles.listCompact : '']
    .filter(Boolean)
    .join(' ')
  return (
    <section className={styles.band}>
      <SectionHeader title={title} />
      {agents.length === 0 ? (
        <p className={styles.bandEmpty}>{empty}</p>
      ) : (
        <ul className={listClass}>
          {agents.map((a) => (
            <li key={a.name} className={styles.row}>
              <Link
                to={`/agent/${encodeURIComponent(a.name)}`}
                className={styles.rowLink}
                aria-label={`Open ${a.name}`}
              >
                <AgentMark id={a.name} name={a.name} size={density === 'compact' ? 'sm' : 'md'} />
                <span className={styles.rowName}>{a.name}</span>
                <Pill variant={pillVariant(a.status)}>{pillLabel(a.status)}</Pill>
                {a.pulse && (
                  <PulseDot
                    state={a.pulse.state}
                    intensity={a.pulse.intensity}
                    size={density === 'compact' ? 'sm' : 'md'}
                  />
                )}
                <span className={styles.rowActivity}>
                  {a.current_task_id ? (
                    <KV
                      k="TASK"
                      v={<span className={styles.mono}>{a.current_task_id.slice(0, 12)}</span>}
                      kw={48}
                    />
                  ) : (
                    <span className={styles.rowMuted}>
                      {density === 'compact' ? '—' : 'no current task'}
                    </span>
                  )}
                </span>
                <span className={styles.rowPid}>
                  {a.pid !== null ? `pid ${String(a.pid)}` : '—'}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function errorTitle(error: unknown): string {
  if (error instanceof ApiError && error.status === 401) return 'Not authorized'
  if (error instanceof NetworkError) return 'Cannot reach the runtime'
  return 'Could not load the fleet'
}

function errorBody(error: unknown): string {
  if (error instanceof ApiError && error.status === 401) {
    return 'The bearer token is missing or invalid. Run `2200 web token rotate` and follow the URL it prints.'
  }
  if (error instanceof NetworkError) {
    return 'The supervisor may not be running. Try `2200 daemon start` and refresh.'
  }
  if (error instanceof ApiError) {
    return `${error.code}: ${error.message}`
  }
  return error instanceof Error ? error.message : String(error)
}
