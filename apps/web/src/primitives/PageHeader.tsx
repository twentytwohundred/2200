import type { ReactNode } from 'react'
import styles from './PageHeader.module.css'

export interface PageHeaderProps {
  /** Uppercase mono breadcrumb (e.g. "AGENT · TELEMETRY"). */
  eyebrow?: string
  title: string
  subtitle?: string
  /** Right-aligned button cluster. */
  actions?: ReactNode
}

export function PageHeader({ eyebrow, title, subtitle, actions }: PageHeaderProps): ReactNode {
  return (
    <header className={styles.header}>
      <div className={styles.text}>
        {eyebrow ? <span className={styles.eyebrow}>{eyebrow}</span> : null}
        <h1 className={styles.title}>{title}</h1>
        {subtitle ? <p className={styles.subtitle}>{subtitle}</p> : null}
      </div>
      {actions ? <div className={styles.actions}>{actions}</div> : null}
    </header>
  )
}
