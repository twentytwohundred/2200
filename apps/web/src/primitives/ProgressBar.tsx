import type { ReactNode } from 'react'
import { cx } from './cx'
import styles from './ProgressBar.module.css'

export type ProgressBarVariant = 'auto' | 'running' | 'attention' | 'error' | 'idle'

export interface ProgressBarProps {
  value?: number
  max?: number
  /** "auto" flips to attention >=75%, error >=90%. */
  variant?: ProgressBarVariant
  /** Bar height in px. Default 4. */
  height?: number
  /** Optional accessible label for screen readers. */
  ariaLabel?: string
}

function resolveVariant(
  variant: ProgressBarVariant,
  pct: number,
): Exclude<ProgressBarVariant, 'auto'> {
  if (variant !== 'auto') return variant
  if (pct >= 90) return 'error'
  if (pct >= 75) return 'attention'
  return 'running'
}

export function ProgressBar({
  value = 0,
  max = 100,
  variant = 'auto',
  height = 4,
  ariaLabel,
}: ProgressBarProps): ReactNode {
  const safeMax = max <= 0 ? 1 : max
  const pct = Math.max(0, Math.min(100, (value / safeMax) * 100))
  const resolved = resolveVariant(variant, pct)

  return (
    <div
      className={cx(styles.track, styles[`v-${resolved}`])}
      style={{ height }}
      role="progressbar"
      aria-label={ariaLabel}
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={max}
    >
      <span className={styles.fill} style={{ width: `${String(pct)}%` }} />
    </div>
  )
}
