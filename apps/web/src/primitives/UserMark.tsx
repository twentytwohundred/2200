import type { ReactNode } from 'react'
import { cx } from './cx'
import styles from './UserMark.module.css'

export type UserMarkSize = 'sm' | 'md' | 'lg' | 'xl'
export type UserMarkState = 'speaking' | 'thinking' | null

export interface UserMarkProps {
  size?: UserMarkSize
  state?: UserMarkState
  /** Defaults to "YOU" inside the mark. */
  children?: ReactNode
}

export function UserMark({ size = 'md', state = null, children }: UserMarkProps): ReactNode {
  const classes = cx(
    styles.mark,
    styles[`size-${size}`],
    state ? styles[`state-${state}`] : undefined,
  )

  return (
    <span className={classes} aria-label="You">
      {children ?? 'YOU'}
    </span>
  )
}
