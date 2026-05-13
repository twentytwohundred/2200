import type { ReactNode } from 'react'
import { cx } from './cx'
import styles from './Meta.module.css'

export interface MetaProps {
  children: ReactNode
  className?: string
}

/**
 * Mono-uppercase label. Used for section eyebrows, KV row labels,
 * timestamps, breadcrumb segments ... anything that signals "this is
 * metadata, not prose."
 */
export function Meta({ children, className }: MetaProps): ReactNode {
  return <span className={cx(styles.meta, className)}>{children}</span>
}
