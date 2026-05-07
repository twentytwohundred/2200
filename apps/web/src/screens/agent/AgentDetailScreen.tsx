/**
 * Agent detail screen ... Identity Card variant per
 * wiki/design-system/decision-log.md.
 *
 * Hero is the AgentMark + name + status pill (the "who"). Beneath
 * sits a KV stack with the operational fields (the "what"). Quick
 * actions (Pause / Resume) live in the page header. The status pill
 * updates live without a refresh via the WebSocket subscription.
 */
import { useEffect, useState, type FormEvent, type ReactElement } from 'react'
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
  type TaskListItem,
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
            <Link to={`/agent/${encodeURIComponent(name ?? '')}/chat`} className={styles.back}>
              CHAT →
            </Link>
            <Link to={`/agent/${encodeURIComponent(name ?? '')}/brain`} className={styles.back}>
              BRAIN →
            </Link>
            <Link to={`/agent/${encodeURIComponent(name ?? '')}/schedules`} className={styles.back}>
              SCHEDULES →
            </Link>
            <Link to={`/agent/${encodeURIComponent(name ?? '')}/tools`} className={styles.back}>
              TOOLS →
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
                {agent.status === 'errored' && agent.errored_reason ? (
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

          <SendTaskSection name={agent.name} />

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

          <section>
            <SectionHeader title="CHAT" />
            <Link to={`/agent/${encodeURIComponent(agent.name)}/chat`} className={styles.chatCard}>
              <div className={styles.chatCardLabel}>Open chat with {agent.name} →</div>
              <div className={styles.chatCardBody}>
                Persistent conversation thread. Each turn carries the prior 20 messages of context
                to the agent. Brain, fs, and pub tools are available — no idempotency gating.
              </div>
            </Link>
          </section>

          <section>
            <SectionHeader title="STATUS" />
            <Card padding={20}>
              <div className={styles.statusGrid}>
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
                  k="PULSE"
                  v={
                    agent.pulse ? (
                      <span
                        className={styles.pulseRow}
                        title={`activity intensity ${agent.pulse.intensity.toFixed(2)} of 1.00`}
                      >
                        <PulseDot
                          state={agent.pulse.state}
                          intensity={agent.pulse.intensity}
                          size="sm"
                        />
                        <span className={styles.mono}>{agent.pulse.state.replace(/_/g, ' ')}</span>
                      </span>
                    ) : (
                      <span className={styles.muted}>(no pulse data)</span>
                    )
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
                {agent.status === 'errored' && agent.errored_at ? (
                  <KV
                    k="ERR AT"
                    v={<span className={styles.mono}>{formatTimestamp(agent.errored_at)}</span>}
                  />
                ) : null}
              </div>
            </Card>
          </section>

          <BudgetSection name={agent.name} query={budgetQuery} />

          <TasksSection name={agent.name} />

          <ActivitySection name={agent.name} query={notificationsQuery} />

          <IdentitySection name={agent.name} path={agent.identity_path} />
        </>
      ) : null}
    </main>
  )
}

interface SendTaskSectionProps {
  name: string
}

type Idempotency = 'pure' | 'checkpointed' | 'destructive'

const IDEMPOTENCY_HINTS: Record<Idempotency, string> = {
  pure: 'read-only; mutating tools blocked',
  checkpointed: 'mutations OK; resume from checkpoint on restart',
  destructive: 'mutations OK; never auto-resume',
}

function SendTaskSection({ name }: SendTaskSectionProps): ReactElement {
  const [body, setBody] = useState('')
  const [idempotency, setIdempotency] = useState<Idempotency>('checkpointed')
  const [lastSent, setLastSent] = useState<string | null>(null)

  const mutation = useMutation({
    mutationFn: (args: { body: string; idempotency: Idempotency }) =>
      api.taskCreate(name, { body: args.body, idempotency: args.idempotency }),
    onSuccess: (res) => {
      setBody('')
      setLastSent(res.id)
    },
  })

  const handleSubmit = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault()
    const trimmed = body.trim()
    if (trimmed.length === 0) return
    mutation.mutate({ body: trimmed, idempotency })
  }

  return (
    <section>
      <SectionHeader title="SEND TASK" />
      <Card padding={20}>
        <form onSubmit={handleSubmit} className={styles.sendForm}>
          <textarea
            className={styles.sendInput}
            placeholder={`Tell ${name} what to do...`}
            value={body}
            onChange={(e) => {
              setBody(e.target.value)
            }}
            disabled={mutation.isPending}
          />
          {mutation.error ? (
            <div className={styles.sendError}>
              {mutation.error instanceof ApiError
                ? `${mutation.error.code}: ${mutation.error.message}`
                : mutation.error instanceof Error
                  ? mutation.error.message
                  : String(mutation.error)}
            </div>
          ) : null}
          {lastSent && !mutation.error ? (
            <div className={styles.sendSuccess}>
              Sent task <span className={styles.mono}>{lastSent}</span>. The Agent's loop will pick
              it up on the next tick.
            </div>
          ) : null}
          <div className={styles.sendActions}>
            <span className={styles.idempotencyGroup} title={IDEMPOTENCY_HINTS[idempotency]}>
              {(['pure', 'checkpointed', 'destructive'] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  className={styles.idempotencyChip}
                  data-active={idempotency === v}
                  onClick={() => {
                    setIdempotency(v)
                  }}
                  disabled={mutation.isPending}
                >
                  {v}
                </button>
              ))}
            </span>
            <Button
              type="submit"
              variant="primary"
              disabled={mutation.isPending || body.trim().length === 0}
              kbd="↵"
            >
              {mutation.isPending ? 'Sending...' : 'Send'}
            </Button>
          </div>
        </form>
      </Card>
    </section>
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

interface IdentitySectionProps {
  name: string
  path: string
}

function IdentitySection({ name, path }: IdentitySectionProps): ReactElement {
  const queryClient = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')

  const query = useQuery({
    queryKey: ['identity', name],
    queryFn: () => api.identityRead(name),
    staleTime: 60_000,
  })

  const saveMutation = useMutation({
    mutationFn: (content: string) => api.identityWrite(name, content),
    onSuccess: () => {
      setEditing(false)
      void queryClient.invalidateQueries({ queryKey: ['identity', name] })
    },
  })

  const beginEdit = (): void => {
    setDraft(query.data?.content ?? '')
    setEditing(true)
  }

  return (
    <section>
      <SectionHeader title="IDENTITY" />
      <Card padding={20}>
        <KV
          k="PATH"
          v={
            <span className={styles.monoPath} title={path}>
              {path}
            </span>
          }
          kw={64}
        />
        {query.isLoading ? (
          <LoadingState rows={4} />
        ) : query.isError ? (
          <ErrorState
            title="Could not load identity"
            body={
              query.error instanceof ApiError
                ? `${query.error.code}: ${query.error.message}`
                : query.error instanceof Error
                  ? query.error.message
                  : String(query.error)
            }
          />
        ) : editing ? (
          <>
            <textarea
              className={styles.identityEditor}
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value)
              }}
              disabled={saveMutation.isPending}
              spellCheck={false}
            />
            {saveMutation.error ? (
              <div className={styles.sendError}>
                {saveMutation.error instanceof ApiError
                  ? `${saveMutation.error.code}: ${saveMutation.error.message}`
                  : saveMutation.error instanceof Error
                    ? saveMutation.error.message
                    : String(saveMutation.error)}
              </div>
            ) : null}
            <div className={styles.sendActions}>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setEditing(false)
                }}
                disabled={saveMutation.isPending}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                size="sm"
                disabled={saveMutation.isPending || draft.trim().length === 0}
                onClick={() => {
                  saveMutation.mutate(draft)
                }}
              >
                {saveMutation.isPending ? 'Saving…' : 'Save & restart required'}
              </Button>
            </div>
          </>
        ) : (
          <>
            <pre className={styles.identityPre}>{query.data?.content ?? ''}</pre>
            <div className={styles.sendActions}>
              <Button size="sm" onClick={beginEdit}>
                Edit
              </Button>
            </div>
            {saveMutation.isSuccess ? (
              <p className={styles.advisory}>
                Saved. The Agent must be restarted for changes to take effect:{' '}
                <code>
                  2200 agent stop {name} && 2200 agent start {name}
                </code>{' '}
                — or click Stop then Start in the header.
              </p>
            ) : (
              <p className={styles.advisory}>
                Edit the markdown then bounce the Agent to pick up changes. Validation runs before
                write — bad YAML or schema errors are surfaced here, not at next start.
              </p>
            )}
          </>
        )}
      </Card>
    </section>
  )
}

interface TasksSectionProps {
  name: string
}

function TasksSection({ name }: TasksSectionProps): ReactElement {
  const [openTaskId, setOpenTaskId] = useState<string | null>(null)
  const query = useQuery({
    queryKey: ['tasks', name],
    queryFn: () => api.agentTasks(name, { limit: 8 }),
    enabled: Boolean(name),
    // Tight refetch during a session — Doug's just-sent tasks should
    // surface within a couple seconds of state transitions.
    staleTime: 2_000,
    refetchInterval: 5_000,
  })
  const items = query.data?.items ?? []
  return (
    <section>
      <SectionHeader title={`RECENT TASKS · ${String(items.length)}`} />
      <Card padding={20}>
        {query.isLoading ? (
          <LoadingState rows={3} />
        ) : query.isError ? (
          <ErrorState
            title="Could not load tasks"
            body={
              query.error instanceof ApiError
                ? `${query.error.code}: ${query.error.message}`
                : query.error instanceof Error
                  ? query.error.message
                  : String(query.error)
            }
          />
        ) : items.length === 0 ? (
          <EmptyState
            title="No tasks yet"
            body="Send a task above and it'll show up here. Tasks the Agent picks up via schedules and pub mentions also surface."
          />
        ) : (
          <div className={styles.taskList}>
            {items.map((t) => (
              <TaskRow
                key={t.id}
                task={t}
                onOpen={() => {
                  setOpenTaskId(t.id)
                }}
              />
            ))}
          </div>
        )}
      </Card>
      {openTaskId ? (
        <TaskDetailModal
          agentName={name}
          taskId={openTaskId}
          onClose={() => {
            setOpenTaskId(null)
          }}
        />
      ) : null}
    </section>
  )
}

interface TaskRowProps {
  task: TaskListItem
  onOpen: () => void
}

function taskPillVariant(state: string): PillVariant {
  if (state === 'running') return 'running'
  if (state === 'pending' || state === 'blocked_on_agent') return 'info'
  if (state === 'blocked_on_user' || state === 'blocked_on_detector') return 'attention'
  if (state === 'errored') return 'error'
  if (state === 'done') return 'idle'
  return 'idle'
}

function TaskRow({ task, onOpen }: TaskRowProps): ReactElement {
  return (
    <div
      className={styles.taskRow}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpen()
        }
      }}
      style={{ cursor: 'pointer' }}
    >
      <div className={styles.taskHead}>
        <Pill variant={taskPillVariant(task.state)}>
          {task.state.toUpperCase().replace(/_/g, ' ')}
        </Pill>
        <span className={styles.taskTitle}>{task.title}</span>
        <span className={styles.taskTime}>{formatTimestamp(task.last_at ?? task.created)}</span>
      </div>
      {task.outcome_preview ? (
        <div className={styles.taskPreview}>{task.outcome_preview}</div>
      ) : null}
      {task.detector_kind ? (
        <div className={styles.taskMeta}>detector · {task.detector_kind}</div>
      ) : null}
      {task.iterations !== null ? (
        <div className={styles.taskMeta}>{String(task.iterations)} iterations</div>
      ) : null}
    </div>
  )
}

interface TaskDetailModalProps {
  agentName: string
  taskId: string
  onClose: () => void
}

function TaskDetailModal({ agentName, taskId, onClose }: TaskDetailModalProps): ReactElement {
  const query = useQuery({
    queryKey: ['tasks', agentName, taskId],
    queryFn: () => api.agentTask(agentName, taskId),
    refetchInterval: 5_000,
  })

  // Esc closes the modal.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  return (
    <div className={styles.modalBackdrop} onClick={onClose} role="presentation">
      <div
        className={styles.modalShell}
        role="dialog"
        aria-modal="true"
        aria-label="Task detail"
        onClick={(e) => {
          e.stopPropagation()
        }}
      >
        {query.isLoading ? (
          <LoadingState rows={5} />
        ) : query.isError ? (
          <ErrorState
            title="Could not load task"
            body={
              query.error instanceof ApiError
                ? `${query.error.code}: ${query.error.message}`
                : query.error instanceof Error
                  ? query.error.message
                  : String(query.error)
            }
          />
        ) : query.data ? (
          <>
            <div className={styles.modalHeader}>
              <Pill variant={taskPillVariant(query.data.state)}>
                {query.data.state.toUpperCase().replace(/_/g, ' ')}
              </Pill>
              <h3 className={styles.modalTitle}>{query.data.title}</h3>
              <Button size="sm" variant="ghost" onClick={onClose} kbd="esc">
                Close
              </Button>
            </div>
            <div className={styles.modalMeta}>
              <span>id · {query.data.id}</span>
              <span>idempotency · {query.data.idempotency}</span>
              <span>priority · {String(query.data.priority)}</span>
              <span>created · {formatTimestamp(query.data.created)}</span>
              {query.data.last_at ? (
                <span>last · {formatTimestamp(query.data.last_at)}</span>
              ) : null}
              {query.data.iterations !== null ? (
                <span>iterations · {String(query.data.iterations)}</span>
              ) : null}
            </div>
            <SectionHeader title="PROMPT" />
            <pre className={styles.modalBody}>{query.data.body}</pre>
            {query.data.outcome_summary ? (
              <>
                <SectionHeader title="OUTCOME" />
                <pre className={styles.modalBody}>{query.data.outcome_summary}</pre>
              </>
            ) : null}
            {query.data.error_message ? (
              <>
                <SectionHeader title={`ERROR · ${query.data.error_class ?? '?'}`} />
                <pre className={styles.modalBody}>{query.data.error_message}</pre>
              </>
            ) : null}
            {query.data.detector_detail ? (
              <>
                <SectionHeader title={`DETECTOR · ${query.data.detector_kind ?? '?'}`} />
                <pre className={styles.modalBody}>{query.data.detector_detail}</pre>
                {query.data.detector_trip_id ? (
                  <KV
                    k="TRIP ID"
                    v={<span className={styles.mono}>{query.data.detector_trip_id}</span>}
                  />
                ) : null}
              </>
            ) : null}
            {query.data.checkpoint_iteration !== null ? (
              <>
                <SectionHeader title="CHECKPOINT" />
                <KV
                  k="ITERATION"
                  v={<span className={styles.mono}>{String(query.data.checkpoint_iteration)}</span>}
                />
                {query.data.checkpoint_taken_at ? (
                  <KV
                    k="TAKEN AT"
                    v={
                      <span className={styles.mono}>
                        {formatTimestamp(query.data.checkpoint_taken_at)}
                      </span>
                    }
                  />
                ) : null}
              </>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  )
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
