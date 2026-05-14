import type { ReactNode } from 'react'
import { cx } from './cx'
import styles from './Breadcrumb.module.css'

export interface BreadcrumbProps {
  /** Crumb segments in order, e.g. ['2200', 'agent', 'jodin']. */
  path: readonly string[]
  className?: string
}

/**
 * Mono-uppercase crumb trail. Used at the top of every screen to
 * orient the operator. The last segment is rendered with --text-2 so
 * the active position pops out from the dimmer ancestors.
 */
export function Breadcrumb({ path, className }: BreadcrumbProps): ReactNode {
  if (path.length === 0) return null
  return (
    <nav aria-label="Breadcrumb" className={cx(styles.crumb, className)}>
      {path.map((seg, i) => {
        const isLast = i === path.length - 1
        return (
          <span key={`${String(i)}-${seg}`} className={styles.segWrap}>
            <span className={cx(styles.seg, isLast && styles.active)}>{seg}</span>
            {!isLast && <span className={styles.sep}>/</span>}
          </span>
        )
      })}
    </nav>
  )
}
