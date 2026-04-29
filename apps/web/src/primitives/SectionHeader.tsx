import type { ReactNode } from 'react'
import styles from './SectionHeader.module.css'

export interface SectionHeaderProps {
  /** Uppercase mono. Often includes a count, e.g. "RUNNING · 4". */
  title: string
  /** Optional right-aligned widget (button, status). */
  action?: ReactNode
}

export function SectionHeader({ title, action }: SectionHeaderProps): ReactNode {
  return (
    <div className={styles.header}>
      <h3 className={styles.title}>{title}</h3>
      {action ? <div className={styles.action}>{action}</div> : null}
    </div>
  )
}
