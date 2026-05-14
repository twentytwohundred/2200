import type { MouseEventHandler, ReactNode } from 'react'
import { cx } from './cx'
import { agentColorClass } from './agentColorClass'
import styles from './Tag.module.css'

export interface TagProps {
  /** Tag content (typically an @-handle, e.g. "@hobby"). */
  children: ReactNode
  /**
   * If provided, the leading dot picks up the agent's hashed hue. Pass
   * the agent's id (not the @-prefixed handle). Falls back to no dot if
   * omitted.
   */
  agent?: string
  /** Optional click handler; renders as a button when set. */
  onClick?: MouseEventHandler<HTMLElement>
  /** Optional class for inline override. */
  className?: string
}

/**
 * Identity chip. Pairs with Pill (state). The dot picks up the
 * agent's hue from the class-mapped --agent-color, so any agent
 * appears with the same hue everywhere in the UI.
 */
export function Tag({ children, agent, onClick, className }: TagProps): ReactNode {
  const hueClass = agent !== undefined ? agentColorClass(agent) : undefined
  const classes = cx(styles.tag, hueClass, onClick && styles.clickable, className)

  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={classes}>
        {agent !== undefined && <span className={styles.dot} aria-hidden="true" />}
        <span className={styles.label}>{children}</span>
      </button>
    )
  }

  return (
    <span className={classes}>
      {agent !== undefined && <span className={styles.dot} aria-hidden="true" />}
      <span className={styles.label}>{children}</span>
    </span>
  )
}
