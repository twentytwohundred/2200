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
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactElement,
} from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiError, NetworkError, api, type Notification } from '../../lib/api'
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  Input,
  KV,
  LoadingState,
  PageHeader,
  Pill,
  type PillVariant,
  SectionHeader,
} from '../../primitives'
import { useTheme } from '../../theme/ThemeProvider'
import { ThemeSwitcher } from '../../theme/ThemeSwitcher'
import { useLiveSignal } from '../../ws/useLiveSignal'
import styles from './InboxScreen.module.css'

function tierVariant(tier: string): PillVariant {
  if (tier === 'critical') return 'error'
  if (tier === 'important') return 'attention'
  if (tier === 'normal') return 'info'
  return 'idle'
}

function isTextInput(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

export function InboxScreen(): ReactElement {
  const { theme } = useTheme()
  const live = useLiveSignal()
  const queryClient = useQueryClient()

  const query = useQuery({
    queryKey: ['notifications', { state: 'pending' }],
    queryFn: () => api.notifications({ state: 'pending' }),
    staleTime: 5_000,
    refetchOnWindowFocus: true,
  })

  const items = useMemo(() => query.data?.items ?? [], [query.data])
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
    (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault()
      submitResponse(draft)
    },
    [draft, submitResponse],
  )

  const eyebrow = `2200 · INBOX · ${theme.toUpperCase()} · WS ${live.status.toUpperCase()}`

  return (
    <main className={styles.shell}>
      <PageHeader
        eyebrow={eyebrow}
        title={`Inbox · ${String(items.length)}`}
        subtitle="Pending asks from your Agents. Keyboard: j/k to move, e to respond, d to dismiss."
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
          <EmptyState
            title="No pending asks"
            body="Quiet inbox. When an Agent emits an ask via notification.ask, it shows up here."
          />
        </Card>
      ) : (
        <div className={styles.split}>
          <section className={styles.list}>
            <SectionHeader title={`PENDING · ${String(items.length)}`} />
            <ul className={styles.listItems}>
              {items.map((n, i) => (
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
                  <Pill variant={tierVariant(n.tier)} dot={false}>
                    {n.tier.toUpperCase()}
                  </Pill>
                  <span className={styles.listAgent}>{n.agent}</span>
                  <span className={styles.listKind}>{n.kind}</span>
                  <span className={styles.listTs}>{n.ts.slice(11, 19)}</span>
                </li>
              ))}
            </ul>
          </section>

          <section className={styles.detail}>
            <SectionHeader title="FOCUSED" />
            {focused ? (
              <Card padding={20}>
                <div className={styles.detailHeader}>
                  <Pill variant={tierVariant(focused.tier)}>{focused.tier.toUpperCase()}</Pill>
                  <Link
                    to={`/agent/${encodeURIComponent(focused.agent)}`}
                    className={styles.detailAgentLink}
                  >
                    {focused.agent}
                  </Link>
                </div>
                <KV k="KIND" v={<span className={styles.mono}>{focused.kind}</span>} />
                <KV k="ID" v={<span className={styles.mono}>{focused.id}</span>} />
                <KV k="TIME" v={<span className={styles.mono}>{focused.ts}</span>} />
                <NotificationBody body={focused.body} />
                <form onSubmit={onSubmit} className={styles.respondForm}>
                  <Input
                    ref={inputRef}
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
                  <div className={styles.respondActions}>
                    <Button
                      type="submit"
                      variant="primary"
                      size="sm"
                      kbd="↵"
                      disabled={!draft.trim() || respondMutation.isPending}
                    >
                      {respondMutation.isPending ? 'Sending…' : 'Respond'}
                    </Button>
                    <Button
                      type="button"
                      variant="destructive"
                      size="sm"
                      kbd="d"
                      disabled={dismissMutation.isPending}
                      onClick={dismissFocused}
                    >
                      {dismissMutation.isPending ? 'Dismissing…' : 'Dismiss'}
                    </Button>
                  </div>
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
    </main>
  )
}

interface NotificationBodyProps {
  body: string
}

function NotificationBody({ body }: NotificationBodyProps): ReactElement | null {
  const trimmed = body.trim()
  if (!trimmed) return null
  return (
    <div className={styles.body}>
      <SectionHeader title="MESSAGE" />
      <p className={styles.bodyText}>{trimmed}</p>
    </div>
  )
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
