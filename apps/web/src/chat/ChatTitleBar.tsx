import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { AgentMark } from '../primitives/AgentMark'
import { Button } from '../primitives/Button'
import { cx } from '../primitives/cx'
import styles from './ChatTitleBar.module.css'

export interface ChatTitleBarProps {
  title: string
  agent: string
  /** Operator-set glyph (emoji) for the AgentMark. */
  agentGlyph?: string | null | undefined
  /** Operator-uploaded portrait. Authed URL — caller must pre-sign. */
  agentImageUrl?: string | null | undefined
  count: number
  /** Called with the new title string. Render inline ... never via window.prompt. */
  onRename?: (next: string) => void
  /** Called when the operator confirms the destructive action via the two-step button. */
  onArchive?: () => void
  onExport?: () => void
}

/**
 * Header above the chat pane. Title is click-to-edit (Enter saves,
 * Esc cancels, blur saves). Archive is two-step: first click swaps to
 * "Click to confirm"; a second click within 3 seconds commits, anything
 * else cancels.
 */
export function ChatTitleBar({
  title,
  agent,
  agentGlyph,
  agentImageUrl,
  count,
  onRename,
  onArchive,
  onExport,
}: ChatTitleBarProps): ReactNode {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(title)
  const inputRef = useRef<HTMLInputElement | null>(null)

  // Reset draft whenever the chat title changes externally.
  useEffect(() => {
    setDraft(title)
  }, [title])

  const startEdit = (): void => {
    if (!onRename) return
    setDraft(title)
    setEditing(true)
    // Focus + select-all on next tick once the input is in the DOM.
    setTimeout(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    }, 0)
  }

  const commit = (): void => {
    if (!onRename) return
    const next = draft.trim()
    if (next.length === 0 || next === title) {
      setEditing(false)
      setDraft(title)
      return
    }
    onRename(next)
    setEditing(false)
  }

  const cancel = (): void => {
    setEditing(false)
    setDraft(title)
  }

  const onKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      e.preventDefault()
      commit()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      cancel()
    }
  }

  return (
    <div className={styles.bar}>
      <AgentMark
        id={agent}
        name={agent}
        size="md"
        state="speaking"
        glyph={agentGlyph ?? undefined}
        imageUrl={agentImageUrl ?? undefined}
      />
      <div className={styles.text}>
        {editing ? (
          <input
            ref={inputRef}
            className={styles.titleInput}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value)
            }}
            onBlur={commit}
            onKeyDown={onKey}
            spellCheck={false}
          />
        ) : (
          <button
            type="button"
            className={cx(styles.title, onRename && styles.titleEditable)}
            onClick={onRename ? startEdit : undefined}
            title={onRename ? 'Click to rename' : undefined}
          >
            {title}
          </button>
        )}
        <div className={styles.sub}>
          <span className={styles.count}>{count}</span>
          <span> messages · chat with </span>
          <span className={styles.subAgent}>{agent}</span>
        </div>
      </div>
      {onExport && (
        <Button size="sm" variant="ghost" onClick={onExport}>
          Export
        </Button>
      )}
      {onArchive && <ConfirmingDestructiveButton label="Archive" onConfirm={onArchive} />}
    </div>
  )
}

/**
 * Two-step destructive button. First click flips to "Click to
 * confirm" + danger-soft background; second click within 3s
 * commits; mouse-leave or timeout reverts.
 */
function ConfirmingDestructiveButton({
  label,
  onConfirm,
}: {
  label: string
  onConfirm: () => void
}): ReactNode {
  const [armed, setArmed] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const arm = (): void => {
    setArmed(true)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      setArmed(false)
    }, 3000)
  }

  const disarm = (): void => {
    setArmed(false)
    if (timer.current) {
      clearTimeout(timer.current)
      timer.current = null
    }
  }

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [])

  return (
    <Button
      size="sm"
      variant="destructive"
      onClick={() => {
        if (armed) {
          disarm()
          onConfirm()
        } else {
          arm()
        }
      }}
      onMouseLeave={armed ? disarm : undefined}
    >
      {armed ? 'Click to confirm' : label}
    </Button>
  )
}
