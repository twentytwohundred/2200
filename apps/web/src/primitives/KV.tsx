import type { ReactNode } from 'react'
import styles from './KV.module.css'

export interface KVProps {
  /** Uppercase mono label. */
  k: string
  /** Value (use mono inline elements for numerics). */
  v: ReactNode
  /** Label column width in px. Default 100. */
  kw?: number
}

export function KV({ k, v, kw = 100 }: KVProps): ReactNode {
  return (
    <div className={styles.row}>
      <span className={styles.k} style={{ width: kw }}>
        {k}
      </span>
      <span className={styles.v}>{v}</span>
    </div>
  )
}
