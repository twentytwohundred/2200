import type { ReactNode } from 'react'
import { cx } from './cx'
import styles from './Pill.module.css'

export type PillVariant = 'running' | 'attention' | 'error' | 'info' | 'idle' | 'draft'

export interface PillProps {
  /** Semantic status. Maps to --color-status-* tokens. */
  variant?: PillVariant
  /** Show the leading dot. The `running` dot pulses ... the only routine animation in the product. */
  dot?: boolean
  /** Label. Always uppercase, mono. Keep <= 12 chars. */
  children: ReactNode
}

export function Pill({ variant = 'idle', dot = true, children }: PillProps): ReactNode {
  return (
    <span className={cx(styles.pill, styles[`v-${variant}`])}>
      {dot && <span className={cx(styles.dot, variant === 'running' && styles.pulse)} />}
      <span className={styles.label}>{children}</span>
    </span>
  )
}
