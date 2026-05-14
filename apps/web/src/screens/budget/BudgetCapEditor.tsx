/**
 * Inline cap editor. Used by the fleet-wide Budget screen and the
 * per-Agent Budget panel.
 *
 * Click "Edit" → number input swaps in. Enter/Save commits, Esc/
 * Cancel reverts. Writes `cost_caps.daily_usd` in identity.md via
 * `api.agentBudgetSet`. The running BudgetTracker keeps its loaded
 * cap until restart, so the route reports `applies_on_restart`; we
 * surface that hint inline.
 */
import { useEffect, useRef, useState, type ReactElement } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import styles from './BudgetCapEditor.module.css'

export interface BudgetCapEditorProps {
  /** Agent name (the cost_caps key on identity.md). */
  agent: string
  /** Operator-set cap (from `configured.daily_usd`). Null when no identity available. */
  capUsd: number | null
  /** Operator-set warn percentage (from `configured.warn_at_pct`). */
  warnAtPct: number | null
  /** Optional copy shown when no spend has happened today. */
  emptyHint?: string
}

export function BudgetCapEditor({
  agent,
  capUsd,
  warnAtPct,
  emptyHint,
}: BudgetCapEditorProps): ReactElement {
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
