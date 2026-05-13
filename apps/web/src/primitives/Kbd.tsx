import type { ReactNode } from 'react'
import { cx } from './cx'
import styles from './Kbd.module.css'

export interface KbdProps {
  children: ReactNode
  className?: string
}

/** Keycap. Used inline next to a hint, e.g. "⌘ + ⏎ to send". */
export function Kbd({ children, className }: KbdProps): ReactNode {
  return <kbd className={cx(styles.kbd, className)}>{children}</kbd>
}
