/**
 * Fleet screen ... mission control, design-system v1.1.
 *
 * All chrome (breadcrumb, title, lede, action row, padding, max-width)
 * comes from the canonical <Screen> primitive. Anything page-specific
 * lives below the header.
 */
import type { ReactElement } from 'react'
import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ApiError, NetworkError, api, type Agent } from '../../lib/api'
import {
  AgentMark,
  Button,
  Meta,
  Pill,
  Screen,
  ScreenNavLink,
  type PillVariant,
} from '../../primitives'
import { cx } from '../../primitives/cx'
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
  return 'idle'
}

function pillLabel(status: string): string {
  if (status === 'blocked_on_user') return 'needs you'
  if (status === 'blocked_on_agent') return 'warn'
  if (status === 'blocked_on_detector') return 'paused'
  if (status === 'archived') return 'archived'
  if (status === 'errored') return 'error'
  return status.replace(/_/g, ' ')
}

export function FleetScreen(): ReactElement {
  const navigate = useNavigate()
  const [showArchived, setShowArchived] = useState(false)

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

  const allItems = query.data?.items ?? []
  const archivedItems = useMemo(() => allItems.filter((a) => a.status === 'archived'), [allItems])
  const liveItems = useMemo(() => allItems.filter((a) => a.status !== 'archived'), [allItems])
  const groups = useMemo(() => group(liveItems), [liveItems])
  const pendingCount = inboxQuery.data?.items.length ?? 0

  const isLoading = query.isLoading
  const isError = query.isError
  const isEmpty = !isLoading && !isError && liveItems.length === 0 && archivedItems.length === 0

  return (
    <Screen
      crumbs={['2200', 'fleet']}
      title="Fleet"
      lede="Mission control for the agents on this instance."
      actions={
        <>
          <ScreenNavLink to="/studio">Studio</ScreenNavLink>
          <ScreenNavLink to="/rooms">Rooms</ScreenNavLink>
          <ScreenNavLink to="/extensions">Extensions</ScreenNavLink>
          <ScreenNavLink to="/inbox">
            Inbox{pendingCount > 0 ? ` · ${String(pendingCount)}` : ''}
          </ScreenNavLink>
          <ScreenNavLink to="/budget">Budget</ScreenNavLink>
          <ScreenNavLink to="/settings">Settings</ScreenNavLink>
          <Button
            variant="primary"
            size="md"
            onClick={() => {
              void navigate('/onboarding')
            }}
          >
            Build Agent
          </Button>
        </>
      }
    >
      {isLoading && <Banner kind="info" meta="loading" body="Fetching the fleet…" />}

      {isError && (
        <Banner
          kind="error"
          meta="error"
          title={errorTitle(query.error)}
          body={errorBody(query.error)}
          action={
            <Button
              variant="default"
              size="sm"
              onClick={() => {
                void query.refetch()
              }}
            >
              Retry
            </Button>
          }
        />
      )}

      {isEmpty && (
        <Banner
          kind="info"
          meta="empty"
          title="No Agents yet"
          body={
            <>
              Build one through the conversational onboarding flow, or run{' '}
              <code className={styles.bannerCode}>2200 agent build</code> in your shell. Either way
              the Agent lands here once it's on disk.
            </>
          }
          action={
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                void navigate('/onboarding')
              }}
            >
              Build an Agent
            </Button>
          }
        />
      )}

      {!isLoading && !isError && !isEmpty && (
        <div className={styles.bands}>
          <Band
            label="needs you"
            count={groups.needsYou.length}
            agents={groups.needsYou}
            empty="Nothing waiting on you. Quiet is the goal."
          />
          <Band
            label="running"
            count={groups.running.length}
            agents={groups.running}
            empty="No agents running right now."
          />
          <Band
            label="idle"
            count={groups.idle.length}
            agents={groups.idle}
            empty="No idle agents."
          />
          {archivedItems.length > 0 && (
            <section className={styles.band}>
              <div className={styles.bandHead}>
                <button
                  type="button"
                  className={styles.archivedToggle}
                  onClick={() => {
                    setShowArchived((v) => !v)
                  }}
                  aria-expanded={showArchived}
                >
                  <Meta>
                    {showArchived ? '▾' : '▸'} archived · {String(archivedItems.length)}
                  </Meta>
                </button>
                <span className={styles.bandRule} />
              </div>
              {showArchived && (
                <ul className={styles.grid}>
                  {archivedItems.map((a) => (
                    <li key={a.name} className={styles.cell}>
                      <AgentCard agent={a} />
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
        </div>
      )}
    </Screen>
  )
}

// ── Band ──────────────────────────────────────────────────────────────────

interface BandProps {
  label: string
  count: number
  agents: Agent[]
  empty: string
}

function Band({ label, count, agents, empty }: BandProps): ReactElement {
  return (
    <section className={styles.band}>
      <div className={styles.bandHead}>
        <Meta>
          {label} · {String(count)}
        </Meta>
        <span className={styles.bandRule} />
      </div>
      {agents.length === 0 ? (
        <p className={styles.bandEmpty}>{empty}</p>
      ) : (
        <ul className={styles.grid}>
          {agents.map((a) => (
            <li key={a.name} className={styles.cell}>
              <AgentCard agent={a} />
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

// ── AgentCard ──────────────────────────────────────────────────────────────

function AgentCard({ agent }: { agent: Agent }): ReactElement {
  const isArchived = agent.status === 'archived'
  const archivedAt = agent.archived?.at ?? null
  const taskValue = isArchived
    ? archivedAt
      ? `archived ${new Date(archivedAt).toLocaleDateString()}`
      : 'archived'
    : agent.current_task_id
      ? agent.current_task_id.slice(0, 24)
      : 'no current task'
  // Live cards route to the bare /agent/:name (which defaults to the
  // chat tab). Archived cards land on identity ... chat is moot for an
  // archived Agent and the identity tab is where restore + rename live.
  const cardHref = isArchived
    ? `/agent/${encodeURIComponent(agent.name)}?tab=identity`
    : `/agent/${encodeURIComponent(agent.name)}`
  return (
    <Link
      to={cardHref}
      className={cx(styles.card, isArchived && styles.cardArchived)}
      aria-label={`Open ${agent.name}`}
    >
      <div className={styles.cardRow}>
        <AgentMark
          id={agent.name}
          name={agent.name}
          size="md"
          glyph={agent.avatar ?? undefined}
          imageUrl={api.authedUrl(agent.avatar_image_url) ?? undefined}
        />
        <span className={styles.cardName}>{agent.name}</span>
        {agent.pid !== null && <span className={styles.cardPid}>pid {String(agent.pid)}</span>}
        <span className={styles.cardSpacer} />
        <Pill variant={pillVariant(agent.status)}>{pillLabel(agent.status)}</Pill>
      </div>
      <div className={styles.cardTask}>
        <Meta>{isArchived ? 'state' : 'task'}</Meta>
        <span className={styles.cardTaskValue}>{taskValue}</span>
      </div>
    </Link>
  )
}

// ── Banner ─────────────────────────────────────────────────────────────────

interface BannerProps {
  kind: 'info' | 'error'
  meta: string
  title?: string
  body: ReactElement | string
  action?: ReactElement
}

function Banner({ kind, meta, title, body, action }: BannerProps): ReactElement {
  return (
    <div className={cx(styles.banner, kind === 'error' && styles.bannerError)}>
      <Meta>{meta}</Meta>
      <div className={styles.bannerBody}>
        {title !== undefined && <strong className={styles.bannerTitle}>{title}</strong>}
        <div className={styles.bannerLine}>{body}</div>
        {action !== undefined && <div className={styles.bannerAction}>{action}</div>}
      </div>
    </div>
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
