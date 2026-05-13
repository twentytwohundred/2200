import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Breadcrumb } from './Breadcrumb'
import { cx } from './cx'
import styles from './Screen.module.css'

export interface ScreenProps {
  /**
   * Crumb segments. Always rendered with mono-uppercase + forward-slash
   * separators, e.g. `['2200', 'fleet']` → `2200 / FLEET`.
   */
  crumbs: readonly string[]
  /** Hero title. Sans-serif, 44px, weight 600. */
  title: ReactNode
  /**
   * Optional sub-line on the same row as `actions`. Used for the
   * one-sentence "what this page is" lede.
   */
  lede?: ReactNode
  /**
   * Optional right-aligned action area. Use `<ScreenNavLink>` for
   * plain text links and `<Button variant="primary">` for the primary
   * call-to-action; both line up on the same horizontal axis as the
   * lede.
   */
  actions?: ReactNode
  /** Body content (cards, tables, chat panes, etc). */
  children: ReactNode
  /** Optional override for the outer className. */
  className?: string | undefined
}

/**
 * Canonical screen shell + header for every route.
 *
 * Locks down the page padding, max width, breadcrumb, title, lede,
 * and action-row layout so every screen renders pixel-identical
 * chrome regardless of who built it. The body content (cards, chat
 * panes, lists, etc.) lives below the header via `children`.
 *
 *   ┌── max-width 1240px ─────────────────────────────┐
 *   │ 2200 / FLEET (crumbs)                            │
 *   │                                                  │
 *   │ Fleet                                            │
 *   │ Mission control for the agents on this instance.  ...Inbox·15  Budget  Settings  [Spawn agent]
 *   │                                                  │
 *   │ {children}                                       │
 *   └──────────────────────────────────────────────────┘
 *
 * Padding: 48px top · 40px left/right · 80px bottom.
 * Header gap: 24px between breadcrumb and title; 6px between title
 * and sub-row; 8px between sub-row and body.
 */
export function Screen({
  crumbs,
  title,
  lede,
  actions,
  children,
  className,
}: ScreenProps): ReactNode {
  const hasSubRow = lede !== undefined || actions !== undefined
  return (
    <main className={cx(styles.shell, className)}>
      <header className={styles.header}>
        <Breadcrumb path={crumbs} />
        <h1 className={styles.title}>{title}</h1>
        {hasSubRow && (
          <div className={styles.subRow}>
            {lede !== undefined && <p className={styles.lede}>{lede}</p>}
            {actions !== undefined && (
              <nav className={styles.actions} aria-label="Page actions">
                {actions}
              </nav>
            )}
          </div>
        )}
      </header>
      {children}
    </main>
  )
}

export interface ScreenNavLinkProps {
  to: string
  children: ReactNode
}

/**
 * Plain-text link styled for the Screen header's action row. Reads
 * `--text-2`, hovers to `--text`. Pairs with `<Button
 * variant="primary">` for the primary CTA.
 */
export function ScreenNavLink({ to, children }: ScreenNavLinkProps): ReactNode {
  return (
    <Link to={to} className={styles.navLink}>
      {children}
    </Link>
  )
}
