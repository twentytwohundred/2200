import type { ReactNode } from 'react'
import { Meta } from '../primitives/Meta'
import styles from './DayDivider.module.css'

export interface DayDividerProps {
  label: string
}

/**
 * Horizontal rule with a centered Meta label. Used between messages
 * when the date changes.
 */
export function DayDivider({ label }: DayDividerProps): ReactNode {
  return (
    <div className={styles.row}>
      <span className={styles.line} />
      <Meta>{label}</Meta>
      <span className={styles.line} />
    </div>
  )
}
