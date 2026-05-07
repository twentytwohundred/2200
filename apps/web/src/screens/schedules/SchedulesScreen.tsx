/**
 * Schedule editor ... per-Agent CRUD over the schedule store.
 *
 * List on top, create-form below. Each row shows the timing block
 * (cron + tz OR every-N-seconds), the prompt, last/next-fire
 * timestamps, an enabled/disabled toggle, and a delete button.
 *
 * Mutating endpoints (POST / PATCH / DELETE) all trigger a live
 * scheduler reload on the daemon side, so timer changes take effect
 * immediately without a daemon bounce.
 */
import { useCallback, useState, type FormEvent, type ReactElement } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ApiError,
  NetworkError,
  api,
  type ScheduleCreateBody,
  type ScheduleEntry,
  type ScheduleTiming,
} from '../../lib/api'
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
  SectionHeader,
} from '../../primitives'
import { ThemeSwitcher } from '../../theme/ThemeSwitcher'
import { useTheme } from '../../theme/ThemeProvider'
import styles from './SchedulesScreen.module.css'

function formatTime(value: string | null): string {
  if (!value) return '—'
  try {
    return new Date(value).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'
  } catch {
    return value
  }
}

function timingLabel(t: ScheduleTiming): string {
  if (t.kind === 'cron') return `cron · ${t.expression} · ${t.timezone}`
  return `every ${String(t.interval_seconds)}s`
}

function formatError(err: unknown): string {
  if (err instanceof ApiError) return `${err.code}: ${err.message}`
  if (err instanceof NetworkError) return 'Cannot reach the runtime.'
  return err instanceof Error ? err.message : String(err)
}

export function SchedulesScreen(): ReactElement {
  const { name } = useParams<{ name: string }>()
  const { theme } = useTheme()
  const queryClient = useQueryClient()

  const listQuery = useQuery({
    queryKey: ['schedules', name],
    queryFn: () => {
      if (!name) throw new Error('agent name missing from route')
      return api.schedulesList(name)
    },
    enabled: Boolean(name),
    staleTime: 5_000,
  })

  const items: ScheduleEntry[] = listQuery.data?.items ?? []

  const refetch = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['schedules', name] })
  }, [queryClient, name])

  const createMutation = useMutation({
    mutationFn: (body: ScheduleCreateBody) => {
      if (!name) throw new Error('agent name missing')
      return api.scheduleCreate(name, body)
    },
    onSuccess: refetch,
  })

  const enabledMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => {
      if (!name) throw new Error('agent name missing')
      return api.scheduleSetEnabled(name, id, enabled)
    },
    onSuccess: refetch,
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => {
      if (!name) throw new Error('agent name missing')
      return api.scheduleDelete(name, id)
    },
    onSuccess: refetch,
  })

  const eyebrow = `2200 · SCHEDULES · ${(name ?? '').toUpperCase()} · ${theme.toUpperCase()}`

  return (
    <main className={styles.shell}>
      <PageHeader
        eyebrow={eyebrow}
        title={`Schedules · ${name ?? ''}`}
        subtitle="Cron + interval timers for this Agent. Mutations reload the live scheduler immediately."
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

      <section>
        <SectionHeader title={`SCHEDULES · ${String(items.length)}`} />
        {listQuery.isLoading ? (
          <Card padding={20}>
            <LoadingState rows={3} />
          </Card>
        ) : listQuery.isError ? (
          <Card padding={0}>
            <ErrorState title="Could not load schedules" body={formatError(listQuery.error)} />
          </Card>
        ) : items.length === 0 ? (
          <Card padding={0}>
            <EmptyState
              title="No schedules yet"
              body="Add one below ... cron expression with a timezone, or an every-N-seconds interval."
            />
          </Card>
        ) : (
          <div className={styles.scheduleList}>
            {items.map((s) => (
              <ScheduleRow
                key={s.id}
                schedule={s}
                onToggle={(enabled) => {
                  enabledMutation.mutate({ id: s.id, enabled })
                }}
                onDelete={() => {
                  deleteMutation.mutate(s.id)
                }}
                pending={enabledMutation.isPending || deleteMutation.isPending}
              />
            ))}
            {(enabledMutation.error ?? deleteMutation.error) ? (
              <div className={styles.errorMessage}>
                {formatError(enabledMutation.error ?? deleteMutation.error)}
              </div>
            ) : null}
          </div>
        )}
      </section>

      <section>
        <SectionHeader title="ADD SCHEDULE" />
        <Card padding={20}>
          <CreateForm
            disabled={createMutation.isPending}
            error={createMutation.error}
            onSubmit={(body) => {
              createMutation.mutate(body)
            }}
            success={createMutation.isSuccess}
          />
        </Card>
      </section>
    </main>
  )
}

interface ScheduleRowProps {
  schedule: ScheduleEntry
  onToggle: (enabled: boolean) => void
  onDelete: () => void
  pending: boolean
}

function ScheduleRow({ schedule, onToggle, onDelete, pending }: ScheduleRowProps): ReactElement {
  return (
    <div className={styles.scheduleRow} data-disabled={!schedule.enabled}>
      <div>
        <div className={styles.scheduleHead}>
          <span className={styles.scheduleDescription}>
            {schedule.description || '(no description)'}
          </span>
          <span className={styles.scheduleId}>{schedule.id}</span>
          {schedule.enabled ? (
            <Pill variant="info">ENABLED</Pill>
          ) : (
            <Pill variant="idle">DISABLED</Pill>
          )}
        </div>
        <div className={styles.scheduleTiming}>{timingLabel(schedule.timing)}</div>
        <div className={styles.schedulePrompt}>{schedule.prompt}</div>
        <div className={styles.scheduleMeta}>
          <span>last fired {formatTime(schedule.last_fired_at)}</span>
          <span>next fire {formatTime(schedule.next_fire_at)}</span>
        </div>
      </div>
      <div className={styles.scheduleActions}>
        <Button
          size="sm"
          variant={schedule.enabled ? 'ghost' : 'primary'}
          disabled={pending}
          onClick={() => {
            onToggle(!schedule.enabled)
          }}
        >
          {schedule.enabled ? 'Disable' : 'Enable'}
        </Button>
        <Button size="sm" variant="destructive" disabled={pending} onClick={onDelete}>
          Delete
        </Button>
      </div>
    </div>
  )
}

interface CreateFormProps {
  disabled: boolean
  error: unknown
  success: boolean
  onSubmit: (body: ScheduleCreateBody) => void
}

function CreateForm({ disabled, error, success, onSubmit }: CreateFormProps): ReactElement {
  const [kind, setKind] = useState<'cron' | 'interval'>('cron')
  const [description, setDescription] = useState('')
  const [prompt, setPrompt] = useState('')
  const [cronExpression, setCronExpression] = useState('0 9 * * *')
  const [timezone, setTimezone] = useState('UTC')
  const [intervalSeconds, setIntervalSeconds] = useState('300')

  const handleSubmit = useCallback(
    (e: FormEvent<HTMLFormElement>): void => {
      e.preventDefault()
      const trimmedPrompt = prompt.trim()
      if (!trimmedPrompt) return
      const body: ScheduleCreateBody = {
        prompt: trimmedPrompt,
        ...(description.trim() ? { description: description.trim() } : {}),
        timing:
          kind === 'cron'
            ? {
                kind: 'cron',
                expression: cronExpression.trim(),
                timezone: timezone.trim() || 'UTC',
              }
            : {
                kind: 'interval',
                interval_seconds: Math.max(5, parseInt(intervalSeconds, 10) || 5),
              },
      }
      onSubmit(body)
    },
    [prompt, description, kind, cronExpression, timezone, intervalSeconds, onSubmit],
  )

  return (
    <form onSubmit={handleSubmit} className={styles.formRow}>
      <div className={styles.kindToggle}>
        <button
          type="button"
          className={styles.kindChip}
          data-active={kind === 'cron'}
          onClick={() => {
            setKind('cron')
          }}
        >
          CRON
        </button>
        <button
          type="button"
          className={styles.kindChip}
          data-active={kind === 'interval'}
          onClick={() => {
            setKind('interval')
          }}
        >
          INTERVAL
        </button>
      </div>

      <label className={styles.label}>
        DESCRIPTION
        <span className={styles.labelInputWrapper}>
          <Input
            type="text"
            placeholder="Optional human-readable label"
            value={description}
            onChange={(e) => {
              setDescription(e.target.value)
            }}
            disabled={disabled}
          />
        </span>
      </label>

      <label className={styles.label}>
        PROMPT
        <textarea
          className={styles.textarea}
          placeholder="What should the Agent do when this schedule fires?"
          value={prompt}
          onChange={(e) => {
            setPrompt(e.target.value)
          }}
          disabled={disabled}
          required
        />
      </label>

      {kind === 'cron' ? (
        <div className={styles.formInline}>
          <label className={styles.label}>
            CRON EXPRESSION
            <span className={styles.labelInputWrapper}>
              <Input
                type="text"
                placeholder="0 9 * * *"
                value={cronExpression}
                onChange={(e) => {
                  setCronExpression(e.target.value)
                }}
                disabled={disabled}
              />
            </span>
          </label>
          <label className={styles.label}>
            TIMEZONE
            <span className={styles.labelInputWrapper}>
              <Input
                type="text"
                placeholder="UTC"
                value={timezone}
                onChange={(e) => {
                  setTimezone(e.target.value)
                }}
                disabled={disabled}
              />
            </span>
          </label>
        </div>
      ) : (
        <label className={styles.label}>
          INTERVAL (SECONDS · MIN 5)
          <span className={styles.labelInputWrapper}>
            <Input
              type="number"
              min="5"
              value={intervalSeconds}
              onChange={(e) => {
                setIntervalSeconds(e.target.value)
              }}
              disabled={disabled}
            />
          </span>
        </label>
      )}

      {error ? <div className={styles.errorMessage}>{formatError(error)}</div> : null}
      {success && !error ? (
        <KV k="LATEST" v={<span style={{ color: 'var(--color-text-muted)' }}>added</span>} />
      ) : null}

      <div className={styles.formActions}>
        <Button type="submit" variant="primary" disabled={disabled || prompt.trim().length === 0}>
          {disabled ? 'Adding…' : 'Add schedule'}
        </Button>
      </div>
    </form>
  )
}
