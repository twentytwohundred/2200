import type { ReactNode } from 'react'
import { cx } from './cx'
import styles from './States.module.css'

export interface EmptyStateProps {
  icon?: ReactNode
  title: string
  body?: ReactNode
  action?: ReactNode
}

export function EmptyState({ icon, title, body, action }: EmptyStateProps): ReactNode {
  return (
    <div className={styles.shell}>
      {icon ? <div className={styles.icon}>{icon}</div> : null}
      <h3 className={styles.title}>{title}</h3>
      {body ? <p className={styles.body}>{body}</p> : null}
      {action ? <div className={styles.action}>{action}</div> : null}
    </div>
  )
}

export interface LoadingStateProps {
  /** Number of skeleton rows. Default 4. */
  rows?: number
}

export function LoadingState({ rows = 4 }: LoadingStateProps): ReactNode {
  const items: number[] = []
  for (let i = 0; i < rows; i += 1) items.push(i)
  return (
    <div className={styles.skeleton} aria-busy="true" aria-label="Loading">
      {items.map((i) => (
        <span key={i} className={styles.skeletonRow} />
      ))}
    </div>
  )
}

export interface ErrorStateProps {
  title: string
  body?: ReactNode
  action?: ReactNode
}

export function ErrorState({ title, body, action }: ErrorStateProps): ReactNode {
  return (
    <div className={cx(styles.shell, styles.errorShell)} role="alert">
      <h3 className={cx(styles.title, styles.errorTitle)}>{title}</h3>
      {body ? <p className={styles.body}>{body}</p> : null}
      {action ? <div className={styles.action}>{action}</div> : null}
    </div>
  )
}
