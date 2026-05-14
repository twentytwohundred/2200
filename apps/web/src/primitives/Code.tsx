import type { ReactNode } from 'react'
import { cx } from './cx'
import styles from './Code.module.css'

export interface CodeProps {
  children: ReactNode
  className?: string
}

/**
 * Inline mono token. Used for anything pastable into a terminal:
 * paths, IDs, env vars, command snippets, error codes.
 */
export function Code({ children, className }: CodeProps): ReactNode {
  return <code className={cx(styles.code, className)}>{children}</code>
}
