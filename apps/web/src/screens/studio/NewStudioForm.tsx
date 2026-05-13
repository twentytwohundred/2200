/**
 * Inline "+ New Studio" form. Sits at the top of the Studio screen
 * when toggled open. Two fields: studio name + per-agent checklist
 * of who joins on creation. Submit hits POST /api/v1/pubs which
 * creates the pub, writes each chosen agent's pubs.md, and restarts
 * those agents so they attach a wake source.
 *
 * The form is intentionally inline rather than a modal ... no
 * popups (see [[feedback_no_browser_popups]]) and the agent
 * checklist is large enough that a modal would clip the live
 * fleet on smaller windows.
 */
import { useMemo, useState, type FormEvent, type ReactElement } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiError, NetworkError, api } from '../../lib/api'
import { AgentMark, Button, Meta, cx } from '../../primitives'
import styles from './NewStudioForm.module.css'

export interface NewStudioFormProps {
  /** Called when the operator clicks Cancel or after a successful create. */
  onClose: () => void
}

function slugifyDraft(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}

function formatError(err: unknown): string {
  if (err instanceof ApiError) return `${err.code}: ${err.message}`
  if (err instanceof NetworkError) return 'Cannot reach the runtime.'
  return err instanceof Error ? err.message : String(err)
}

export function NewStudioForm({ onClose }: NewStudioFormProps): ReactElement {
  const qc = useQueryClient()
  const navigate = useNavigate()

  const agentsQuery = useQuery({
    queryKey: ['agents'],
    queryFn: () => api.agents(),
    staleTime: 5_000,
  })
  const agents = useMemo(() => agentsQuery.data?.items ?? [], [agentsQuery.data])

  const [nameDraft, setNameDraft] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const slug = slugifyDraft(nameDraft)
  const slugValid = /^[a-z0-9][a-z0-9-]*$/.test(slug) && slug.length >= 1 && slug.length <= 64

  const mutation = useMutation({
    mutationFn: () =>
      api.pubCreate({
        name: slug,
        members: Array.from(selected),
      }),
    onSuccess: (result) => {
      void qc.invalidateQueries({ queryKey: ['pubs'] })
      void qc.invalidateQueries({ queryKey: ['agents'] })
      onClose()
      void navigate(`/studio/${encodeURIComponent(result.name)}`)
    },
  })

  const toggle = (agentName: string): void => {
    setSelected((curr) => {
      const next = new Set(curr)
      if (next.has(agentName)) next.delete(agentName)
      else next.add(agentName)
      return next
    })
  }

  const onSubmit = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault()
    if (!slugValid || selected.size === 0 || mutation.isPending) return
    mutation.mutate()
  }

  const canSubmit = slugValid && selected.size > 0 && !mutation.isPending

  return (
    <form className={styles.form} onSubmit={onSubmit}>
      <div className={styles.head}>
        <Meta>new studio</Meta>
        <button
          type="button"
          className={styles.closeBtn}
          onClick={onClose}
          aria-label="Close New Studio form"
        >
          ×
        </button>
      </div>

      <div className={styles.fieldRow}>
        <label className={styles.fieldLabel}>
          <Meta>name</Meta>
        </label>
        <input
          className={styles.nameInput}
          value={nameDraft}
          onChange={(e) => {
            setNameDraft(e.target.value)
          }}
          placeholder="e.g. deploy-coordination"
          autoFocus
          spellCheck={false}
        />
        {nameDraft.length > 0 && slug !== nameDraft && (
          <div className={styles.fieldHint}>
            saves as <span className={styles.slug}>{slug}</span>
          </div>
        )}
      </div>

      <div className={styles.fieldRow}>
        <Meta>members · {String(selected.size)} selected</Meta>
        {agentsQuery.isLoading ? (
          <div className={styles.fieldHint}>loading agents…</div>
        ) : agents.length === 0 ? (
          <div className={styles.fieldHint}>no agents on this instance yet</div>
        ) : (
          <ul className={styles.agentList}>
            {agents.map((a) => {
              const checked = selected.has(a.name)
              return (
                <li key={a.name}>
                  <button
                    type="button"
                    className={cx(styles.agentRow, checked && styles.agentRowChecked)}
                    onClick={() => {
                      toggle(a.name)
                    }}
                    aria-pressed={checked}
                  >
                    <AgentMark
                      id={a.name}
                      name={a.name}
                      size="sm"
                      glyph={a.avatar ?? undefined}
                      imageUrl={api.authedUrl(a.avatar_image_url) ?? undefined}
                    />
                    <span className={styles.agentName}>{a.name}</span>
                    <span className={styles.agentStatus}>{a.status}</span>
                    <span className={cx(styles.checkbox, checked && styles.checkboxChecked)}>
                      {checked ? '✓' : ''}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      {mutation.error && <div className={styles.errorRow}>{formatError(mutation.error)}</div>}

      <div className={styles.actions}>
        <span className={styles.hint}>
          Members get the new studio added to their <span className={styles.slug}>pubs.md</span> and
          restart so they attach a wake source.
        </span>
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" size="md" disabled={!canSubmit}>
          {mutation.isPending ? 'Creating…' : 'Create studio'}
        </Button>
      </div>
    </form>
  )
}
