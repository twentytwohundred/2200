import type { ReactNode } from 'react'
import { cx } from './cx'
import styles from './Pill.module.css'

export type PillVariant = 'running' | 'attention' | 'error' | 'info' | 'idle' | 'draft'
export type PillSize = 'xs' | 'sm' | 'md'

export interface PillProps {
  /** Semantic status. Maps to --color-status-* tokens. */
  variant?: PillVariant
  /** Show the leading dot. */
  dot?: boolean
  /**
   * Pulse the leading dot. Defaults to true for `running` so the alive
   * signal still fires without an explicit prop; explicit `pulse` wins
   * for any variant when set.
   */
  pulse?: boolean
  /** xs (18px tall) / sm (20px) / md (24px). Default sm. */
  size?: PillSize
  /** Label. Always lowercase mono. Keep <= 12 chars. */
  children: ReactNode
}

export function Pill({
  variant = 'idle',
  dot = true,
  pulse,
  size = 'sm',
  children,
}: PillProps): ReactNode {
  const shouldPulse = pulse ?? variant === 'running'
  return (
    <span className={cx(styles.pill, styles[`v-${variant}`], styles[`s-${size}`])}>
      {dot && <span className={cx(styles.dot, shouldPulse && styles.pulse)} />}
      <span className={styles.label}>{children}</span>
    </span>
  )
}
