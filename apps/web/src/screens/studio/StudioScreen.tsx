/**
 * Read-only Studio: a live view of one pub's conversation.
 *
 * PR1 of the Studio sequence. Doug watches Hobby and Simon (and any
 * other agents in the pub) talk. No composer here yet ... PR2 wires
 * `@-tagging` and posts. PR3 adds reactions.
 *
 * Routing: `/studio` redirects to the install's first running pub.
 * `/studio/:pub` opens that pub specifically. The supervisor's pub
 * bridge (one PubClient per pub, authenticated as the local user)
 * holds the rolling buffer this screen polls every 3s.
 */
import { useEffect, useMemo, useRef, type ReactElement } from 'react'
import { Link, Navigate, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ApiError, NetworkError, api } from '../../lib/api'
import { Card, ErrorState, LoadingState, PageHeader, cx } from '../../primitives'
import { ThemeSwitcher } from '../../theme/ThemeSwitcher'
import { useTheme } from '../../theme/ThemeProvider'
import { useLiveSignal } from '../../ws/useLiveSignal'
import styles from './StudioScreen.module.css'

function formatTime(value: string): string {
  try {
    return new Date(value).toISOString().slice(11, 16) + ' UTC'
  } catch {
    return value
  }
}

function formatError(err: unknown): string {
  if (err instanceof ApiError) return `${err.code}: ${err.message}`
  if (err instanceof NetworkError) return 'Cannot reach the runtime.'
  return err instanceof Error ? err.message : String(err)
}

export function StudioScreen(): ReactElement {
  const { pub: pubParam } = useParams<{ pub?: string }>()
  const { theme } = useTheme()
  const live = useLiveSignal()

  // If no pub is specified, send the user to the first running pub.
  const pubsQuery = useQuery({
    queryKey: ['pubs'],
    queryFn: () => api.pubsList(),
    enabled: !pubParam,
    staleTime: 5_000,
  })

  if (!pubParam) {
    if (pubsQuery.isLoading) {
      return (
        <main className={styles.shell}>
          <Card padding={20}>
            <LoadingState rows={3} />
          </Card>
        </main>
      )
    }
    const first =
      pubsQuery.data?.items.find((p) => p.state === 'running') ?? pubsQuery.data?.items[0]
    if (!first) {
      return (
        <main className={styles.shell}>
          <PageHeader
            eyebrow={`2200 · STUDIO · ${theme.toUpperCase()} · WS ${live.status.toUpperCase()}`}
            title="Studio"
            subtitle="No pubs running on this install."
          />
          <div className={styles.banner}>
            Run <code>2200 pub create studio</code> and <code>2200 pub start studio</code> to bring
            up the default Studio.
          </div>
        </main>
      )
    }
    return <Navigate to={`/studio/${encodeURIComponent(first.name)}`} replace />
  }

  return <StudioPubView pubName={pubParam} />
}

function StudioPubView({ pubName }: { pubName: string }): ReactElement {
  const { theme } = useTheme()
  const live = useLiveSignal()
  const timelineRef = useRef<HTMLDivElement | null>(null)

  const pubQuery = useQuery({
    queryKey: ['pub', pubName],
    queryFn: () => api.pub(pubName),
    staleTime: 10_000,
    refetchInterval: 10_000,
  })

  const messagesQuery = useQuery({
    queryKey: ['pub', pubName, 'messages'],
    queryFn: () => api.pubMessages(pubName, { limit: 100 }),
    refetchInterval: 3_000,
    staleTime: 1_000,
  })

  const messages = useMemo(() => messagesQuery.data?.items ?? [], [messagesQuery.data])

  // Autoscroll to the bottom on new messages.
  useEffect(() => {
    const el = timelineRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages.length])

  const eyebrow = `2200 · STUDIO · ${pubName.toUpperCase()} · ${theme.toUpperCase()} · WS ${live.status.toUpperCase()}`

  return (
    <main className={styles.shell}>
      <PageHeader
        eyebrow={eyebrow}
        title={`Studio · ${pubName}`}
        subtitle="Read-only timeline. Composer + reactions land in PR2/PR3."
        actions={
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <Link to="/" style={{ color: 'var(--color-text-muted)' }}>
              ← Fleet
            </Link>
            <ThemeSwitcher />
          </div>
        }
      />

      {pubQuery.isError && !pubQuery.data ? (
        <Card padding={0}>
          <ErrorState title="Pub unavailable" body={formatError(pubQuery.error)} />
        </Card>
      ) : null}

      <aside className={styles.sidebar}>
        <Card padding={16}>
          <div className={styles.sidebarSection}>
            <div className={styles.sidebarLabel}>Members</div>
            {pubQuery.data?.members.length ? (
              pubQuery.data.members.map((m) => (
                <div key={m.agent_id} className={styles.memberRow}>
                  <span
                    className={cx(styles.memberDot, m.status !== 'active' && styles.memberDotIdle)}
                  />
                  <span>{m.display_name}</span>
                </div>
              ))
            ) : (
              <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
                {pubQuery.isLoading ? 'Loading…' : 'No members reported yet.'}
              </div>
            )}
          </div>
          {pubQuery.data?.atmosphere ? (
            <div className={styles.sidebarSection}>
              <div className={styles.sidebarLabel}>Atmosphere</div>
              <div className={styles.atmosphere}>
                {pubQuery.data.atmosphere.tone ?? '—'}
                {pubQuery.data.atmosphere.energy ? ` · ${pubQuery.data.atmosphere.energy}` : ''}
              </div>
              {pubQuery.data.atmosphere.active_topics?.length ? (
                <div className={styles.atmosphere}>
                  Topics: {pubQuery.data.atmosphere.active_topics.join(', ')}
                </div>
              ) : null}
            </div>
          ) : null}
        </Card>
      </aside>

      <div ref={timelineRef} className={styles.timeline}>
        {messagesQuery.isLoading && messages.length === 0 ? (
          <LoadingState rows={4} />
        ) : messages.length === 0 ? (
          <div className={styles.empty}>
            No messages in {pubName} yet. Try <code>2200 chat {pubName}</code> from a terminal to
            kick things off.
          </div>
        ) : (
          messages.map((m) => (
            <div key={m.message_id} className={styles.message}>
              <div className={styles.messageMeta}>
                <span className={styles.sender}>{m.display_name}</span>
                <span className={styles.timestamp}>{formatTime(m.timestamp)}</span>
                {m.mention_names.length > 0 ? (
                  <span className={styles.mentions}>
                    {m.mention_names.map((n) => `@${n}`).join(' ')}
                  </span>
                ) : null}
              </div>
              <div className={styles.content}>{m.content}</div>
            </div>
          ))
        )}
      </div>
    </main>
  )
}
