import type { ReactNode } from 'react'
import { cx } from './cx'
import styles from './Dot.module.css'

export type DotTone = 'running' | 'idle' | 'error' | 'warn' | 'info' | 'off'

export interface DotProps {
  /** Status tone. Only `running` is allowed to pulse (the alive signal). */
  tone?: DotTone
  /** Pulse animation. Honoured only for `running`. */
  pulse?: boolean
  /** Pixel size. Defaults to 8. */
  size?: number
  className?: string
}

/**
 * A solid color status dot. Tiny but load-bearing ... pulsing-green
 * is the single visual signal in the product that says "this thing is
 * alive."
 */
export function Dot({ tone = 'idle', pulse = false, size = 8, className }: DotProps): ReactNode {
  const style = {
    width: `${String(size)}px`,
    height: `${String(size)}px`,
  } as const

  return (
    <span
      aria-hidden="true"
      className={cx(
        styles.dot,
        styles[`t-${tone}`],
        pulse && tone === 'running' && styles.pulse,
        className,
      )}
      style={style}
    />
  )
}
