/**
 * Inbox screen ... V2 Keyboard Triage variant per
 * wiki/design-system/decision-log.md.
 *
 * Two-pane layout: list of pending notifications on the left, focused
 * detail on the right. Keyboard moves the focus through the list.
 *
 * Bindings (when no input is focused):
 *   j / ↓        next item
 *   k / ↑        previous item
 *   e            focus the response input
 *   d            dismiss the focused item
 *   Enter        submit the response (when input is focused)
 *   Esc          blur the response input
 *
 * Filter bar: chips for tier (all/critical/important/normal) and
 * agent (all/<each agent on this instance>). The agent filter
 * pre-selects from the `?agent=<name>` URL parameter so the
 * AgentDetail screen's "INBOX →" link lands focused. Tier counts in
 * the header are computed off the unfiltered pending list, so the
 * counts stay accurate while a filter is active.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type SyntheticEvent,
  type ReactElement,
} from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiError, NetworkError, api, type Agent, type Notification } from '../../lib/api'
import {
  AgentMark,
  Button,
  Card,
  EmptyState,
  ErrorState,
  LoadingState,
  Meta,
  Screen,
  ScreenNavLink,
  Pill,
  type PillVariant,
} from '../../primitives'
import styles from './InboxScreen.module.css'

function tierVariant(tier: string): PillVariant {
  if (tier === 'critical') return 'error'
  if (tier === 'important') return 'attention'
  if (tier === 'normal') return 'info'
  return 'idle'
}

const TIERS = ['critical', 'important', 'normal'] as const
type Tier = (typeof TIERS)[number]
type TierFilter = Tier | 'all'

function isTextInput(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

export function InboxScreen(): ReactElement {
  const queryClient = useQueryClient()
  const [searchParams, setSearchParams] = useSearchParams()

  const tierParam = searchParams.get('tier')
  const agentParam = searchParams.get('agent')
  const tierFilter: TierFilter =
    tierParam === 'critical' || tierParam === 'important' || tierParam === 'normal'
      ? tierParam
      : 'all'
  const agentFilter: string | null = agentParam && agentParam.length > 0 ? agentParam : null

  // Unfiltered pending list ... drives the tier-count breakdown in the
  // header, the agent picker chips, and stays accurate regardless of
  // the active filter (so the user can always see how many
  // critical/important/normal items are pending in total).
  const unfilteredQuery = useQuery({
    queryKey: ['notifications', { state: 'pending' }],
    queryFn: () => api.notifications({ state: 'pending' }),
    staleTime: 5_000,
    refetchOnWindowFocus: true,
  })

  const filterParams = useMemo(
    () => ({
      state: 'pending',
      ...(tierFilter !== 'all' ? { tier: tierFilter } : {}),
      ...(agentFilter ? { agent: agentFilter } : {}),
    }),
    [tierFilter, agentFilter],
  )

  // Filtered list. Either a separate API call (when a filter is
  // active) or a reuse of the unfilteredQuery (when not). The cache
  // key includes the filter shape so each filter combo dedupes
  // independently.
  const filterIsActive = tierFilter !== 'all' || Boolean(agentFilter)
  const filteredQuery = useQuery({
    queryKey: ['notifications', filterParams],
    queryFn: () => api.notifications(filterParams),
    staleTime: 5_000,
    enabled: filterIsActive,
  })

  const query = filterIsActive ? filteredQuery : unfilteredQuery
  const items = useMemo(() => query.data?.items ?? [], [query.data])
  const allPending = useMemo(() => unfilteredQuery.data?.items ?? [], [unfilteredQuery.data])

  // Agents lookup so list rows + detail header can render the
  // operator-set avatar (glyph + portrait) for each notification's
  // emitter. Cheap React-Query cache hit when this also feeds the
  // Fleet/Agent screens.
  const agentsQuery = useQuery({
    queryKey: ['agents'],
    queryFn: () => api.agents(),
    staleTime: 5_000,
  })
  const agentByName = useMemo(() => {
    const map = new Map<string, Agent>()
    for (const a of agentsQuery.data?.items ?? []) {
      map.set(a.name, a)
    }
    return map
  }, [agentsQuery.data])

  const tierCounts = useMemo<Record<Tier, number>>(() => {
    const counts: Record<Tier, number> = { critical: 0, important: 0, normal: 0 }
    for (const n of allPending) {
      if (n.tier === 'critical' || n.tier === 'important' || n.tier === 'normal') {
        counts[n.tier] += 1
      }
    }
    return counts
  }, [allPending])

  const agentNames = useMemo(() => {
    const set = new Set<string>()
    for (const n of allPending) set.add(n.agent)
    return [...set].sort()
  }, [allPending])

  const updateFilter = useCallback(
    (next: { tier?: TierFilter; agent?: string | null }): void => {
      const sp = new URLSearchParams(searchParams)
      const nextTier = next.tier ?? tierFilter
      const nextAgent = next.agent !== undefined ? next.agent : agentFilter
      if (nextTier === 'all') sp.delete('tier')
      else sp.set('tier', nextTier)
      if (!nextAgent) sp.delete('agent')
      else sp.set('agent', nextAgent)
      setSearchParams(sp, { replace: true })
    },
    [searchParams, setSearchParams, tierFilter, agentFilter],
  )

  const resetFilters = useCallback(() => {
    const sp = new URLSearchParams(searchParams)
    sp.delete('tier')
    sp.delete('agent')
    setSearchParams(sp, { replace: true })
  }, [searchParams, setSearchParams])
  const [focusIdx, setFocusIdx] = useState(0)
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement | null>(null)
  const focused = items[focusIdx] ?? null

  // Keep focusIdx within bounds when the list shrinks.
  useEffect(() => {
    if (focusIdx >= items.length && items.length > 0) {
      setFocusIdx(items.length - 1)
    }
    if (items.length === 0) {
      setFocusIdx(0)
    }
  }, [items.length, focusIdx])

  // Reset the draft when the focused item changes.
  useEffect(() => {
    setDraft('')
  }, [focused?.id])

  const respondMutation = useMutation({
    mutationFn: ({ id, response }: { id: string; response: string }) =>
      api.notificationRespond(id, response),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['notifications'] })
    },
  })

  const dismissMutation = useMutation({
    mutationFn: (id: string) => api.notificationDismiss(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['notifications'] })
    },
  })

  const focusInput = useCallback(() => {
    inputRef.current?.focus()
  }, [])

  const submitResponse = useCallback(
    (response: string) => {
      if (!focused) return
      const trimmed = response.trim()
      if (!trimmed) return
      respondMutation.mutate({ id: focused.id, response: trimmed })
    },
    [focused, respondMutation],
  )

  const dismissFocused = useCallback(() => {
    if (!focused) return
    dismissMutation.mutate(focused.id)
  }, [focused, dismissMutation])

  // Keyboard handler at the screen level. Disabled while typing in an
  // input (so j/k don't get hijacked from the response field).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (isTextInput(e.target)) {
        if (e.key === 'Escape' && inputRef.current === e.target) {
          e.preventDefault()
          inputRef.current?.blur()
        }
        return
      }
      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault()
        setFocusIdx((i) => Math.min(i + 1, Math.max(items.length - 1, 0)))
      } else if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault()
        setFocusIdx((i) => Math.max(i - 1, 0))
      } else if (e.key === 'e') {
        e.preventDefault()
        focusInput()
      } else if (e.key === 'd') {
        e.preventDefault()
        dismissFocused()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
    }
  }, [items.length, focusInput, dismissFocused])

  const onSubmit = useCallback(
    (e: SyntheticEvent<HTMLFormElement>) => {
      e.preventDefault()
      submitResponse(draft)
    },
    [draft, submitResponse],
  )

  const totalPending = allPending.length
  const subtitle = (() => {
    const parts: string[] = []
    if (tierCounts.critical > 0) parts.push(`${String(tierCounts.critical)} critical`)
    if (tierCounts.important > 0) parts.push(`${String(tierCounts.important)} important`)
    if (tierCounts.normal > 0) parts.push(`${String(tierCounts.normal)} normal`)
    const head =
      totalPending === 0
        ? 'No pending asks.'
        : `${String(totalPending)} pending${parts.length > 0 ? ` (${parts.join(' · ')})` : ''}.`
    return `${head} Keyboard: j/k to move, e to respond, d to dismiss.`
  })()

  const titleNode = (
    <>
      Inbox
      <span className={styles.titleCount}>
        ·{' '}
        {filterIsActive
          ? `${String(items.length)} of ${String(totalPending)}`
          : String(items.length)}
      </span>
    </>
  )

  return (
    <Screen
      crumbs={['2200', 'inbox']}
      title={titleNode}
      lede={subtitle}
      actions={<ScreenNavLink to="/">← Fleet</ScreenNavLink>}
    >
      {totalPending > 0 ? (
        <div className={styles.filterBar} role="toolbar" aria-label="Filter inbox">
          <div className={styles.filterGroup}>
            <Meta>tier</Meta>
            <button
              type="button"
              className={styles.filterChip}
              data-active={tierFilter === 'all'}
              onClick={() => {
                updateFilter({ tier: 'all' })
              }}
            >
              all <span className={styles.filterCount}>· {String(totalPending)}</span>
            </button>
            {TIERS.map((t) => (
              <button
                key={t}
                type="button"
                className={styles.filterChip}
                data-active={tierFilter === t}
                onClick={() => {
                  updateFilter({ tier: t })
                }}
              >
                {t} <span className={styles.filterCount}>· {String(tierCounts[t])}</span>
              </button>
            ))}
          </div>
          {agentNames.length > 1 || agentFilter ? (
            <div className={styles.filterGroup}>
              <Meta>agent</Meta>
              <button
                type="button"
                className={styles.filterChip}
                data-active={!agentFilter}
                onClick={() => {
                  updateFilter({ agent: null })
                }}
              >
                all
              </button>
              {agentNames.map((a) => (
                <button
                  key={a}
                  type="button"
                  className={styles.filterChip}
                  data-active={agentFilter === a}
                  onClick={() => {
                    updateFilter({ agent: a })
                  }}
                >
                  {a}
                </button>
              ))}
              {agentFilter && !agentNames.includes(agentFilter) ? (
                <button
                  type="button"
                  className={styles.filterChip}
                  data-active
                  onClick={() => {
                    updateFilter({ agent: null })
                  }}
                  title="The named Agent has no pending notifications. Click to clear."
                >
                  {agentFilter}
                </button>
              ) : null}
            </div>
          ) : null}
          <span className={styles.filterSpacer} />
          <button
            type="button"
            className={styles.filterReset}
            disabled={!filterIsActive}
            onClick={resetFilters}
          >
            reset
          </button>
        </div>
      ) : null}

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
      ) : items.length === 0 ? (
        <Card padding={0}>
          {filterIsActive ? (
            <EmptyState
              title="No notifications match your filter"
              body="Clear the filter to see the full pending list."
              action={
                <Button size="sm" onClick={resetFilters}>
                  Reset filters
                </Button>
              }
            />
          ) : (
            <EmptyState
              title="No pending asks"
              body="Quiet inbox. When an Agent emits an ask via notification.ask, it shows up here."
            />
          )}
        </Card>
      ) : (
        <div className={styles.split}>
          <section className={styles.list}>
            <Meta>pending · {String(items.length)}</Meta>
            <ul className={styles.listItems}>
              {items.map((n, i) => {
                const agent = agentByName.get(n.agent)
                return (
                  <li
                    key={n.id}
                    className={[styles.listRow, i === focusIdx ? styles.listRowFocused : '']
                      .filter(Boolean)
                      .join(' ')}
                    onMouseEnter={() => {
                      setFocusIdx(i)
                    }}
                    onClick={() => {
                      setFocusIdx(i)
                    }}
                  >
                    <Pill variant={tierVariant(n.tier)} dot>
                      {n.tier}
                    </Pill>
                    <AgentMark
                      id={n.agent}
                      name={n.agent}
                      size="sm"
                      glyph={agent?.avatar ?? undefined}
                      imageUrl={api.authedUrl(agent?.avatar_image_url) ?? undefined}
                    />
                    <span className={styles.listLabel}>
                      <span className={styles.listAgent}>{n.agent}</span>
                      <span className={styles.listKind}>{n.kind}</span>
                    </span>
                    <span className={styles.listTs}>{n.ts.slice(11, 19)}</span>
                  </li>
                )
              })}
            </ul>
          </section>

          <section className={styles.detail}>
            <Meta>focused</Meta>
            {focused ? (
              <Card padding={20}>
                {(() => {
                  const focusedAgent = agentByName.get(focused.agent)
                  return (
                    <div className={styles.detailHeader}>
                      <AgentMark
                        id={focused.agent}
                        name={focused.agent}
                        size="md"
                        glyph={focusedAgent?.avatar ?? undefined}
                        imageUrl={api.authedUrl(focusedAgent?.avatar_image_url) ?? undefined}
                      />
                      <Link
                        to={`/agent/${encodeURIComponent(focused.agent)}`}
                        className={styles.detailAgentLink}
                      >
                        {focused.agent}
                      </Link>
                      <Pill variant={tierVariant(focused.tier)} dot>
                        {focused.tier}
                      </Pill>
                      <span className={styles.detailSpacer} />
                      <span className={styles.detailTimestamp}>{focused.ts}</span>
                    </div>
                  )
                })()}
                <div className={styles.kvMini}>
                  <div className={styles.kvMiniRow}>
                    <Meta>kind</Meta>
                    <span className={styles.kvMiniValue}>{focused.kind}</span>
                  </div>
                  <div className={styles.kvMiniRow}>
                    <Meta>id</Meta>
                    <span className={styles.kvMiniValueMuted}>{focused.id}</span>
                  </div>
                </div>
                <NotificationBody body={focused.body} />
                <form onSubmit={onSubmit} className={styles.respondForm}>
                  <input
                    ref={inputRef}
                    className={styles.respondInput}
                    value={draft}
                    onChange={(e) => {
                      setDraft(e.target.value)
                    }}
                    placeholder={
                      focused.requires_response
                        ? 'Type response, press Enter to submit'
                        : 'Type response (optional ack)'
                    }
                  />
                  <Button
                    type="submit"
                    variant="primary"
                    size="md"
                    kbd="↵"
                    disabled={!draft.trim() || respondMutation.isPending}
                  >
                    {respondMutation.isPending ? 'Sending…' : 'Respond'}
                  </Button>
                  <Button
                    type="button"
                    variant="destructive"
                    size="md"
                    kbd="d"
                    disabled={dismissMutation.isPending}
                    onClick={dismissFocused}
                  >
                    {dismissMutation.isPending ? 'Dismissing…' : 'Dismiss'}
                  </Button>
                </form>
                {(respondMutation.error ?? dismissMutation.error) ? (
                  <p className={styles.detailError}>
                    {(() => {
                      const err = respondMutation.error ?? dismissMutation.error
                      if (err instanceof ApiError) return `${err.code}: ${err.message}`
                      return err instanceof Error ? err.message : String(err)
                    })()}
                  </p>
                ) : null}
              </Card>
            ) : (
              <Card padding={0}>
                <EmptyState title="Select an item" body="Use j/k to move through the list." />
              </Card>
            )}
          </section>
        </div>
      )}
    </Screen>
  )
}

interface NotificationBodyProps {
  body: string
}

function NotificationBody({ body }: NotificationBodyProps): ReactElement | null {
  const trimmed = body.trim()
  if (!trimmed) return null
  return <p className={styles.bodyText}>{trimmed}</p>
}

function errorTitle(error: unknown): string {
  if (error instanceof ApiError && error.status === 401) return 'Not authorized'
  if (error instanceof NetworkError) return 'Cannot reach the runtime'
  return 'Could not load the inbox'
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

export type { Notification }
