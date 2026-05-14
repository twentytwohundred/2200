import type { ReactNode } from 'react'
import { cx } from '../primitives/cx'
import styles from './ChatListRow.module.css'

export interface ChatListRowProps {
  title: string
  snippet?: string
  time?: string
  active?: boolean
  unread?: boolean
  /**
   * Soft accent pulse alongside the title when the agent is mid-task
   * in this chat but the operator is viewing a different chat. Lets
   * sidebar rows reflect "the thread is moving" without yanking
   * attention.
   */
  working?: boolean
  onClick?: () => void
}

/**
 * One row in the agent's chat-list sidebar. Active row gets the
 * hover-bg; unread surfaces the green dot in place of the time
 * stamp.
 */
export function ChatListRow({
  title,
  snippet,
  time,
  active = false,
  unread = false,
  working = false,
  onClick,
}: ChatListRowProps): ReactNode {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx(styles.row, active && styles.active)}
      aria-current={active ? 'page' : undefined}
    >
      <div className={styles.head}>
        {working && <span className={styles.workingPulse} aria-label="agent working" />}
        <span className={styles.title} title={title}>
          {title}
        </span>
        {unread ? (
          <span className={styles.unread} aria-label="unread" />
        ) : (
          time !== undefined && <span className={styles.time}>{time}</span>
        )}
      </div>
      {snippet !== undefined && snippet.length > 0 && (
        <span className={styles.snippet}>{snippet}</span>
      )}
    </button>
  )
}
