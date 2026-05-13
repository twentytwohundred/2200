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
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type BudgetState } from '../../lib/api'
import {
  AgentMark,
  Card,
  EmptyState,
  KV,
  LoadingState,
  Pill,
  ProgressBar,
  Screen,
  ScreenNavLink,
  SectionHeader,
} from '../../primitives'
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
  // Drill-in: when null, show the fleet-total + per-agent grid;
  // when set, show that agent's detail view (today + history).
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null)

  const agentsQuery = useQuery({
    queryKey: ['agents'],
    queryFn: () => api.agents(),
    staleTime: 5_000,
  })

  const agents = agentsQuery.data?.items ?? []

  // Fan out one query per agent so we can show the fleet total at
  // the top and a thumbnail per agent below. Tanstack Query
  // dedups + caches per key; the per-agent detail view re-uses
  // the same cache entries when the user drills in.
  const perAgentBudget = useQueries({
    queries: agents.map((a) => ({
      queryKey: ['budget', a.name],
      queryFn: () => api.budget(a.name),
      staleTime: 10_000,
    })),
  })

  // Fleet total: sum cumulative + cap across all agents that have
  // a `today` row. Agents with no spend yet today contribute 0/0
  // so the bar reflects the active fleet, not 0/<sum-of-caps> when
  // nobody has called a model.
  const fleetTotal = useMemo(() => {
    let cumulative = 0
    let cap = 0
    let blocked = false
    let warned = false
    for (const q of perAgentBudget) {
      const today = q.data?.today
      if (!today) continue
      cumulative += today.cumulative_usd
      cap += today.cap_usd
      if (today.blocked) blocked = true
      if (today.warned_today) warned = true
    }
    return { cumulative, cap, blocked, warned }
  }, [perAgentBudget])

  const selectedBudget =
    selectedAgent !== null
      ? (perAgentBudget[agents.findIndex((a) => a.name === selectedAgent)]?.data ?? null)
      : null

  return (
    <Screen
      crumbs={['2200', 'budget']}
      title="Budget"
      lede="Daily spend per Agent. Cap, cumulative, override, and per-day history."
      actions={<ScreenNavLink to="/">← Fleet</ScreenNavLink>}
    >
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
          {/* Fleet total: leads the screen so the operator sees
              "what is the team spending today" before drilling
              into a specific agent. */}
          <section>
            <SectionHeader title={`FLEET TODAY · ${todayDay()}`} />
            <Card padding={20}>
              {fleetTotal.cap === 0 ? (
                <EmptyState
                  title="No spend yet today"
                  body="No Agent has made a model call today. The fleet total appears once any Agent records its first spend."
                />
              ) : (
                <>
                  <div className={styles.heroRow}>
                    <div className={styles.heroPrimary}>
                      <span className={styles.heroAmount}>{fmtUsd(fleetTotal.cumulative)}</span>
                      <span className={styles.heroOf}>of {fmtUsd(fleetTotal.cap)}</span>
                    </div>
                    {fleetTotal.blocked ? (
                      <Pill variant="error">BLOCKED</Pill>
                    ) : fleetTotal.warned ? (
                      <Pill variant="attention">WARNED</Pill>
                    ) : (
                      <Pill variant="info">OK</Pill>
                    )}
                  </div>
                  <ProgressBar
                    value={fleetTotal.cumulative}
                    max={fleetTotal.cap}
                    variant={
                      fleetTotal.blocked ? 'error' : fleetTotal.warned ? 'attention' : 'auto'
                    }
                  />
                  <div className={styles.totalSummary}>
                    <span>
                      AGENTS <strong>{String(agents.length)}</strong>
                    </span>
                    <span>
                      REPORTING TODAY{' '}
                      <strong>{String(perAgentBudget.filter((q) => q.data?.today).length)}</strong>
                    </span>
                    <span>
                      REMAINING{' '}
                      <strong>{fmtUsd(Math.max(0, fleetTotal.cap - fleetTotal.cumulative))}</strong>
                    </span>
                  </div>
                </>
              )}
            </Card>
          </section>

          {/* Per-agent grid. Click a card to drill in. */}
          <section>
            <SectionHeader title="BY AGENT" />
            <ul className={styles.agentGrid}>
              {agents.map((a, i) => {
                const today = perAgentBudget[i]?.data?.today ?? null
                const cum = today?.cumulative_usd ?? 0
                const cap = today?.cap_usd ?? 0
                const variant: 'auto' | 'error' | 'attention' = today?.blocked
                  ? 'error'
                  : today?.warned_today
                    ? 'attention'
                    : 'auto'
                return (
                  <li key={a.name} className={styles.agentCard}>
                    <button
                      type="button"
                      className={styles.agentCardLink}
                      data-active={selectedAgent === a.name}
                      onClick={() => {
                        setSelectedAgent((curr) => (curr === a.name ? null : a.name))
                      }}
                      aria-label={`Open ${a.name} budget detail`}
                    >
                      <div className={styles.agentCardHeader}>
                        <AgentMark
                          id={a.name}
                          name={a.name}
                          size="sm"
                          glyph={a.avatar ?? undefined}
                          imageUrl={api.authedUrl(a.avatar_image_url) ?? undefined}
                        />
                        <span className={styles.agentCardName}>{a.name}</span>
                        {today ? (
                          today.blocked ? (
                            <Pill variant="error">BLOCKED</Pill>
                          ) : today.warned_today ? (
                            <Pill variant="attention">WARNED</Pill>
                          ) : (
                            <Pill variant="idle">OK</Pill>
                          )
                        ) : (
                          <Pill variant="idle">QUIET</Pill>
                        )}
                      </div>
                      {cap > 0 ? <ProgressBar value={cum} max={cap} variant={variant} /> : null}
                      <div className={styles.agentCardSpend}>
                        <span>
                          <span className={styles.agentCardSpendAmount}>{fmtUsd(cum)}</span> spent
                        </span>
                        <span>cap {fmtUsd(cap)}</span>
                      </div>
                    </button>
                  </li>
                )
              })}
            </ul>
          </section>

          {/* Drill-in: today + history for the selected agent. */}
          {selectedAgent && selectedBudget ? (
            <>
              <section>
                <SectionHeader
                  title={`${selectedAgent.toUpperCase()} · ${selectedBudget.today?.day ?? 'no spend yet'}`}
                />
                <Card padding={20}>
                  {selectedBudget.today ? (
                    <>
                      <div className={styles.heroRow}>
                        <div className={styles.heroPrimary}>
                          <span className={styles.heroAmount}>
                            {fmtUsd(selectedBudget.today.cumulative_usd)}
                          </span>
                          <span className={styles.heroOf}>
                            of {fmtUsd(selectedBudget.today.cap_usd)}
                          </span>
                        </div>
                        {pillForState(selectedBudget.today)}
                      </div>
                      <ProgressBar
                        value={selectedBudget.today.cumulative_usd}
                        max={selectedBudget.today.cap_usd}
                        variant={
                          selectedBudget.today.blocked
                            ? 'error'
                            : selectedBudget.today.warned_today
                              ? 'attention'
                              : 'auto'
                        }
                      />
                      <KV
                        k="WARN AT"
                        v={
                          <span className={styles.mono}>
                            {String(selectedBudget.today.warn_at_pct)}%
                          </span>
                        }
                      />
                      <KV
                        k="LAST RECORDED"
                        v={
                          <span className={styles.mono}>
                            {selectedBudget.today.last_recorded_at ?? '—'}
                          </span>
                        }
                      />
                      {selectedBudget.override ? (
                        <KV
                          k="OVERRIDE"
                          v={
                            <span className={styles.mono}>
                              until {selectedBudget.override.until}
                              {selectedBudget.override.reason
                                ? ` · ${selectedBudget.override.reason}`
                                : ''}
                            </span>
                          }
                        />
                      ) : null}
                      <BudgetCapEditor
                        agent={selectedAgent}
                        capUsd={selectedBudget.today.cap_usd}
                        warnAtPct={selectedBudget.today.warn_at_pct}
                      />
                    </>
                  ) : (
                    <BudgetCapEditor
                      agent={selectedAgent}
                      capUsd={null}
                      warnAtPct={null}
                      emptyHint={`${selectedAgent} has not made a model call today. Set the daily cap below; it activates the next time ${selectedAgent} starts.`}
                    />
                  )}
                </Card>
              </section>

              <section>
                <SectionHeader title={`HISTORY · ${String(selectedBudget.history.length)} DAYS`} />
                <Card padding={0}>
                  {selectedBudget.history.length === 0 ? (
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
                        {[...selectedBudget.history].reverse().map((s) => {
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
    </Screen>
  )
}

function todayDay(): string {
  return new Date().toISOString().slice(0, 10)
}

/**
 * Inline cap editor. Click "Edit" to swap the value in place for a
 * number input; Enter or Save commits; Esc or Cancel reverts. Writes
 * `cost_caps.daily_usd` in identity.md via `api.agentBudgetSet`. The
 * running AgentProcess keeps its loaded cap until restart so we show
 * an "applies on restart" hint when applicable.
 */
function BudgetCapEditor({
  agent,
  capUsd,
  warnAtPct,
  emptyHint,
}: {
  agent: string
  capUsd: number | null
  warnAtPct: number | null
  emptyHint?: string
}): ReactElement {
  const qc = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<string>('')
  const [appliesOnRestart, setAppliesOnRestart] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)

  const mutation = useMutation({
    mutationFn: (next: number) => api.agentBudgetSet(agent, { daily_usd: next }),
    onSuccess: (result) => {
      setAppliesOnRestart(result.applies_on_restart)
      setEditing(false)
      // Refresh: the GET endpoint reads from the per-day state file
      // which the AgentProcess owns. The fleet+agents queries also
      // depend on cap_usd via toAgentDto's identity read.
      void qc.invalidateQueries({ queryKey: ['budget', agent] })
      void qc.invalidateQueries({ queryKey: ['agents'] })
    },
  })

  useEffect(() => {
    if (editing) {
      setTimeout(() => {
        inputRef.current?.focus()
        inputRef.current?.select()
      }, 0)
    }
  }, [editing])

  const start = (): void => {
    setDraft(capUsd !== null ? capUsd.toFixed(2) : '50')
    setEditing(true)
  }

  const commit = (): void => {
    const n = Number(draft)
    if (!Number.isFinite(n) || n <= 0) {
      setEditing(false)
      return
    }
    if (capUsd !== null && Math.abs(n - capUsd) < 0.005) {
      setEditing(false)
      return
    }
    mutation.mutate(Number(n.toFixed(2)))
  }

  const cancel = (): void => {
    setEditing(false)
    setDraft('')
  }

  return (
    <>
      <div className={styles.editRow}>
        <span className={styles.editRowLabel}>DAILY CAP</span>
        {editing ? (
          <div className={styles.editForm}>
            <span className={styles.editPrefix}>$</span>
            <input
              ref={inputRef}
              className={styles.editInput}
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  commit()
                } else if (e.key === 'Escape') {
                  e.preventDefault()
                  cancel()
                }
              }}
              type="number"
              min="0.01"
              step="0.01"
              inputMode="decimal"
              spellCheck={false}
            />
            <button
              type="button"
              className={styles.editSave}
              onClick={commit}
              disabled={mutation.isPending}
            >
              {mutation.isPending ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              className={styles.editCancel}
              onClick={cancel}
              disabled={mutation.isPending}
            >
              Cancel
            </button>
          </div>
        ) : (
          <>
            <span className={styles.editRowValue}>
              {capUsd !== null ? `$${capUsd.toFixed(2)}/day` : '— not set —'}
            </span>
            {warnAtPct !== null && (
              <span className={styles.editRowLabel}>· warn at {warnAtPct}%</span>
            )}
            <button type="button" className={styles.editTrigger} onClick={start}>
              Edit
            </button>
          </>
        )}
      </div>
      {emptyHint && !editing && <div className={styles.editHint}>{emptyHint}</div>}
      {appliesOnRestart && !editing && (
        <div className={styles.editHint}>Saved. Cap activates the next time {agent} starts.</div>
      )}
      {mutation.error && (
        <div className={styles.editHint}>
          Could not save:{' '}
          {mutation.error instanceof Error ? mutation.error.message : 'unknown error'}
        </div>
      )}
    </>
  )
}
