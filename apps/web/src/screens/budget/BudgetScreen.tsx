/**
 * Budget screen ... v0.1 minimal Ledger Receipt.
 *
 * Per [[wiki/epics/15-web-app]] Phase B and [[wiki/design-system/decision-log]]
 * the canonical Budget variant is the V1 Stripe-style operational
 * ledger. v0.1 here ships the data substrate: pick an Agent, see
 * today's state + per-day history. The receipt-style polish
 * (transaction-by-transaction breakdown, Sparkline, threshold
 * markers) lands once the per-call telemetry is exposed via a
 * companion API endpoint.
 */
import { useMemo, useState, type ReactElement } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ApiError, NetworkError, api, type BudgetState } from '../../lib/api'
import {
  AgentMark,
  Card,
  EmptyState,
  ErrorState,
  KV,
  LoadingState,
  PageHeader,
  Pill,
  ProgressBar,
  SectionHeader,
} from '../../primitives'
import { ThemeSwitcher } from '../../theme/ThemeSwitcher'
import { useTheme } from '../../theme/ThemeProvider'
import { useLiveSignal } from '../../ws/useLiveSignal'
import styles from './BudgetScreen.module.css'

function fmtUsd(n: number): string {
  return `$${n.toFixed(2)}`
}

function pillForState(state: BudgetState | null) {
  if (!state) return null
  if (state.blocked) {
    return <Pill variant="error">BLOCKED</Pill>
  }
  if (state.warned_today) {
    return <Pill variant="attention">WARNED</Pill>
  }
  return <Pill variant="info">OK</Pill>
}

export function BudgetScreen(): ReactElement {
  const { theme } = useTheme()
  const live = useLiveSignal()
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null)

  const agentsQuery = useQuery({
    queryKey: ['agents'],
    queryFn: () => api.agents(),
    staleTime: 5_000,
  })

  const budgetQuery = useQuery({
    queryKey: ['budget', selectedAgent],
    queryFn: () => {
      if (!selectedAgent) throw new Error('no agent selected')
      return api.budget(selectedAgent)
    },
    enabled: Boolean(selectedAgent),
    staleTime: 10_000,
  })

  // Default the picker to the first agent in the list once loaded.
  const agents = agentsQuery.data?.items ?? []
  const effectiveAgent = useMemo(() => {
    if (selectedAgent) return selectedAgent
    return agents[0]?.name ?? null
  }, [selectedAgent, agents])

  const eyebrow = `2200 · BUDGET · ${theme.toUpperCase()} · WS ${live.status.toUpperCase()}`

  return (
    <main className={styles.shell}>
      <PageHeader
        eyebrow={eyebrow}
        title="Budget"
        subtitle="Daily spend per Agent. Cap, cumulative, override, and per-day history."
        actions={<ThemeSwitcher />}
      />

      {agentsQuery.isLoading ? (
        <Card padding={20}>
          <LoadingState rows={4} />
        </Card>
      ) : agents.length === 0 ? (
        <Card padding={0}>
          <EmptyState
            title="No Agents to budget"
            body="Spawn an Agent first; their daily spend appears here once the loop runs."
          />
        </Card>
      ) : (
        <>
          <section>
            <SectionHeader title="AGENT" />
            <Card padding={20}>
              <div className={styles.agentPicker}>
                {agents.map((a) => (
                  <button
                    key={a.name}
                    type="button"
                    className={styles.agentChip}
                    data-active={effectiveAgent === a.name}
                    onClick={() => {
                      setSelectedAgent(a.name)
                    }}
                  >
                    <AgentMark id={a.name} name={a.name} size="sm" />
                    <span className={styles.agentChipName}>{a.name}</span>
                  </button>
                ))}
              </div>
            </Card>
          </section>

          {budgetQuery.isLoading ? (
            <Card padding={20}>
              <LoadingState rows={6} />
            </Card>
          ) : budgetQuery.isError ? (
            <Card padding={0}>
              <ErrorState
                title={errorTitle(budgetQuery.error)}
                body={errorBody(budgetQuery.error)}
              />
            </Card>
          ) : budgetQuery.data ? (
            <>
              <section>
                <SectionHeader title={`TODAY · ${budgetQuery.data.today?.day ?? 'no spend yet'}`} />
                <Card padding={20}>
                  {budgetQuery.data.today ? (
                    <>
                      <div className={styles.heroRow}>
                        <div className={styles.heroPrimary}>
                          <span className={styles.heroAmount}>
                            {fmtUsd(budgetQuery.data.today.cumulative_usd)}
                          </span>
                          <span className={styles.heroOf}>
                            of {fmtUsd(budgetQuery.data.today.cap_usd)}
                          </span>
                        </div>
                        {pillForState(budgetQuery.data.today)}
                      </div>
                      <ProgressBar
                        value={budgetQuery.data.today.cumulative_usd}
                        max={budgetQuery.data.today.cap_usd}
                        variant={
                          budgetQuery.data.today.blocked
                            ? 'error'
                            : budgetQuery.data.today.warned_today
                              ? 'attention'
                              : 'auto'
                        }
                      />
                      <KV
                        k="WARN AT"
                        v={
                          <span className={styles.mono}>
                            {String(budgetQuery.data.today.warn_at_pct)}%
                          </span>
                        }
                      />
                      <KV
                        k="LAST RECORDED"
                        v={
                          <span className={styles.mono}>
                            {budgetQuery.data.today.last_recorded_at ?? '—'}
                          </span>
                        }
                      />
                      {budgetQuery.data.override ? (
                        <KV
                          k="OVERRIDE"
                          v={
                            <span className={styles.mono}>
                              until {budgetQuery.data.override.until}
                              {budgetQuery.data.override.reason
                                ? ` · ${budgetQuery.data.override.reason}`
                                : ''}
                            </span>
                          }
                        />
                      ) : null}
                    </>
                  ) : (
                    <EmptyState
                      title="No spend yet today"
                      body="The Agent has not made a model call today. The state file lands after the first record."
                    />
                  )}
                </Card>
              </section>

              <section>
                <SectionHeader
                  title={`HISTORY · ${String(budgetQuery.data.history.length)} DAYS`}
                />
                <Card padding={0}>
                  {budgetQuery.data.history.length === 0 ? (
                    <EmptyState
                      title="No history"
                      body="Each day's state will appear here as it accumulates."
                    />
                  ) : (
                    <table className={styles.historyTable}>
                      <thead>
                        <tr>
                          <th>DAY</th>
                          <th>SPEND</th>
                          <th>CAP</th>
                          <th>%</th>
                          <th>STATE</th>
                        </tr>
                      </thead>
                      <tbody>
                        {[...budgetQuery.data.history].reverse().map((s) => {
                          const pct =
                            s.cap_usd > 0 ? Math.round((s.cumulative_usd / s.cap_usd) * 100) : 0
                          return (
                            <tr key={s.day}>
                              <td className={styles.mono}>{s.day}</td>
                              <td className={styles.mono}>{fmtUsd(s.cumulative_usd)}</td>
                              <td className={styles.mono}>{fmtUsd(s.cap_usd)}</td>
                              <td className={styles.mono}>{String(pct)}%</td>
                              <td>
                                {s.blocked ? (
                                  <Pill variant="error">BLOCKED</Pill>
                                ) : s.warned_today ? (
                                  <Pill variant="attention">WARNED</Pill>
                                ) : (
                                  <Pill variant="idle">OK</Pill>
                                )}
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  )}
                </Card>
              </section>
            </>
          ) : null}
        </>
      )}
    </main>
  )
}

function errorTitle(error: unknown): string {
  if (error instanceof ApiError && error.status === 404) return 'Agent not found'
  if (error instanceof NetworkError) return 'Cannot reach the runtime'
  return 'Could not load budget'
}

function errorBody(error: unknown): string {
  if (error instanceof ApiError && error.status === 404) {
    return 'No Agent with that name lives on this instance.'
  }
  if (error instanceof NetworkError) {
    return 'The supervisor may not be running. Try `2200 daemon start` and refresh.'
  }
  if (error instanceof ApiError) return `${error.code}: ${error.message}`
  return error instanceof Error ? error.message : String(error)
}
