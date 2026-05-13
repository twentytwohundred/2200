/**
 * Per-Agent budget summary on the Agent screen.
 *
 * Shows today's spend, the cap, the warn threshold, and a small
 * history list. Heavier per-day breakdowns + sparkline live on the
 * fleet-wide Budget screen.
 */
import type { ReactElement } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ApiError, NetworkError, api } from '../../lib/api'
import { Card, ErrorState, KV, LoadingState, Meta, Pill, ProgressBar } from '../../primitives'
import styles from './AgentBudgetPanel.module.css'

function formatUsd(n: number): string {
  return `$${n.toFixed(2)}`
}

function formatError(err: unknown): string {
  if (err instanceof ApiError) return `${err.code}: ${err.message}`
  if (err instanceof NetworkError) return 'Cannot reach the runtime.'
  return err instanceof Error ? err.message : String(err)
}

export interface AgentBudgetPanelProps {
  agentName: string
}

export function AgentBudgetPanel({ agentName }: AgentBudgetPanelProps): ReactElement {
  const query = useQuery({
    queryKey: ['budget', agentName],
    queryFn: () => api.budget(agentName),
    staleTime: 10_000,
    refetchInterval: 15_000,
  })

  if (query.isLoading) {
    return (
      <div className={styles.panel}>
        <Card padding={20}>
          <LoadingState rows={3} />
        </Card>
      </div>
    )
  }

  if (query.isError) {
    return (
      <div className={styles.panel}>
        <Card padding={0}>
          <ErrorState title="Could not load budget" body={formatError(query.error)} />
        </Card>
      </div>
    )
  }

  const today = query.data?.today ?? null
  const override = query.data?.override ?? null
  const history = (query.data?.history ?? []).slice(-7).reverse()

  return (
    <div className={styles.panel}>
      <section className={styles.section}>
        <Meta>today</Meta>
        <Card padding={24}>
          {today === null ? (
            <p className={styles.muted}>No spend recorded yet today.</p>
          ) : (
            <>
              <div className={styles.todayRow}>
                <span className={styles.spend}>{formatUsd(today.cumulative_usd)}</span>
                <span className={styles.cap}>of {formatUsd(today.cap_usd)}</span>
                <span className={styles.spacer} />
                <Pill variant={today.blocked ? 'error' : today.warned_today ? 'attention' : 'info'}>
                  {today.blocked ? 'blocked' : today.warned_today ? 'warn' : 'ok'}
                </Pill>
              </div>
              <div className={styles.bar}>
                <ProgressBar
                  value={Math.min(100, (today.cumulative_usd / today.cap_usd) * 100)}
                  ariaLabel="spend versus cap"
                />
              </div>
              <div className={styles.kvRow}>
                <KV k="day" v={<span className={styles.mono}>{today.day}</span>} />
                <KV k="warn at" v={<span className={styles.mono}>{today.warn_at_pct}%</span>} />
                {today.last_recorded_at && (
                  <KV
                    k="last recorded"
                    v={<span className={styles.mono}>{today.last_recorded_at.slice(11, 19)}</span>}
                  />
                )}
              </div>
            </>
          )}
        </Card>
      </section>

      {override !== null && (
        <section className={styles.section}>
          <Meta>override</Meta>
          <Card padding={20}>
            <p className={styles.overrideBody}>
              Budget block lifted until <code className={styles.mono}>{override.until}</code>
              {override.reason !== null && <> · {override.reason}</>}.
            </p>
          </Card>
        </section>
      )}

      {history.length > 0 && (
        <section className={styles.section}>
          <Meta>last {String(history.length)} days</Meta>
          <Card padding={20}>
            <table className={styles.historyTable}>
              <thead>
                <tr>
                  <th>Day</th>
                  <th>Spend</th>
                  <th>Cap</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {history.map((row) => (
                  <tr key={row.day}>
                    <td className={styles.mono}>{row.day}</td>
                    <td className={styles.mono}>{formatUsd(row.cumulative_usd)}</td>
                    <td className={styles.mono}>{formatUsd(row.cap_usd)}</td>
                    <td>
                      <Pill
                        variant={row.blocked ? 'error' : row.warned_today ? 'attention' : 'idle'}
                      >
                        {row.blocked ? 'blocked' : row.warned_today ? 'warn' : 'ok'}
                      </Pill>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </section>
      )}
    </div>
  )
}
