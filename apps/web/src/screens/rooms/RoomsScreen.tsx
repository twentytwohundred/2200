/**
 * Rooms screen ... index page for operator-created pubs.
 *
 * Per Doug 2026-05-13: "Studio" is the single canonical pub every
 * Agent lives in; this screen lists the OTHER pubs (Rooms) created
 * via "+ New room" with curated membership. Each card shows the
 * room name, its state, and the agents currently in it (small
 * AgentMark stack).
 *
 * The Studio is intentionally excluded from this list ... the Fleet
 * header has its own "Studio" link.
 */
import { useMemo, useState, type ReactElement } from 'react'
import { Link } from 'react-router-dom'
import { useQueries, useQuery } from '@tanstack/react-query'
import { ApiError, NetworkError, api, type Agent } from '../../lib/api'
import {
  AgentMark,
  Button,
  Card,
  EmptyState,
  ErrorState,
  LoadingState,
  Meta,
  Pill,
  Screen,
  ScreenNavLink,
  cx,
} from '../../primitives'
import { NewRoomForm } from '../studio/NewRoomForm'
import styles from './RoomsScreen.module.css'

const STUDIO_NAMES = new Set(['studio'])

function formatError(err: unknown): string {
  if (err instanceof ApiError) return `${err.code}: ${err.message}`
  if (err instanceof NetworkError) return 'Cannot reach the runtime.'
  return err instanceof Error ? err.message : String(err)
}

export function RoomsScreen(): ReactElement {
  const [showNew, setShowNew] = useState(false)

  const pubsQuery = useQuery({
    queryKey: ['pubs'],
    queryFn: () => api.pubsList(),
    staleTime: 5_000,
    refetchInterval: 8_000,
  })

  const agentsQuery = useQuery({
    queryKey: ['agents'],
    queryFn: () => api.agents(),
    staleTime: 5_000,
  })
  const agentByName = useMemo(() => {
    const map = new Map<string, Agent>()
    for (const a of agentsQuery.data?.items ?? []) map.set(a.name, a)
    return map
  }, [agentsQuery.data])

  // Studio is excluded. Sort the remainder by name for stability.
  const rooms = useMemo(() => {
    const items = pubsQuery.data?.items ?? []
    return items
      .filter((p) => !STUDIO_NAMES.has(p.name))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [pubsQuery.data])

  // Per-room detail (members + atmosphere). Fan out a query per room
  // so the cards can show member avatars without extra round-trips.
  const roomDetails = useQueries({
    queries: rooms.map((r) => ({
      queryKey: ['pub', r.name],
      queryFn: () => api.pub(r.name),
      staleTime: 5_000,
    })),
  })

  return (
    <Screen
      crumbs={['2200', 'rooms']}
      title="Rooms"
      lede="Operator-created pubs with curated membership. Studio holds the whole fleet; rooms hold focused conversations."
      actions={
        <>
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              setShowNew((v) => !v)
            }}
          >
            {showNew ? 'Close' : '+ New room'}
          </Button>
          <ScreenNavLink to="/">← Fleet</ScreenNavLink>
        </>
      }
    >
      {showNew && (
        <NewRoomForm
          onClose={() => {
            setShowNew(false)
          }}
        />
      )}

      {pubsQuery.isLoading ? (
        <Card padding={20}>
          <LoadingState rows={3} />
        </Card>
      ) : pubsQuery.isError ? (
        <Card padding={0}>
          <ErrorState title="Could not load rooms" body={formatError(pubsQuery.error)} />
        </Card>
      ) : rooms.length === 0 ? (
        <Card padding={0}>
          <EmptyState
            title="No rooms yet"
            body='Click "+ New room" above to create one. Pick the Agents you want in it; everyone else stays out.'
          />
        </Card>
      ) : (
        <ul className={styles.grid}>
          {rooms.map((r, i) => {
            const detail = roomDetails[i]?.data
            const members = detail?.members ?? []
            return (
              <li key={r.name}>
                <Link to={`/studio/${encodeURIComponent(r.name)}`} className={styles.card}>
                  <div className={styles.cardHead}>
                    <span className={styles.cardName}>{r.name}</span>
                    <Pill
                      variant={
                        r.state === 'running' ? 'running' : r.state === 'errored' ? 'error' : 'idle'
                      }
                      size="xs"
                      dot
                    >
                      {r.state}
                    </Pill>
                  </div>
                  <div className={styles.cardBody}>
                    <Meta>members · {String(members.length)}</Meta>
                    {members.length === 0 ? (
                      <p className={styles.cardEmpty}>
                        {roomDetails[i]?.isLoading ? 'loading…' : 'no members yet'}
                      </p>
                    ) : (
                      <ul className={styles.memberStack}>
                        {members.map((m) => {
                          const agent = agentByName.get(m.display_name)
                          return (
                            <li key={m.agent_id} className={styles.memberRow}>
                              <AgentMark
                                id={m.display_name}
                                name={m.display_name}
                                size="sm"
                                glyph={agent?.avatar ?? undefined}
                                imageUrl={api.authedUrl(agent?.avatar_image_url) ?? undefined}
                              />
                              <span className={styles.memberName}>{m.display_name}</span>
                            </li>
                          )
                        })}
                      </ul>
                    )}
                  </div>
                  <div className={cx(styles.cardFoot)}>
                    <Meta>open →</Meta>
                  </div>
                </Link>
              </li>
            )
          })}
        </ul>
      )}
    </Screen>
  )
}
