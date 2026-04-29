import type { HTMLAttributes, ReactNode } from 'react'
import { cx } from './cx'
import styles from './Card.module.css'

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  /** Padding in px or any CSS length. Default 16. */
  padding?: number | string
  /** Smaller radius (md vs lg) for dense lists. */
  flat?: boolean
  /** Adds --shadow-elevation-1. Use rarely. */
  elevated?: boolean
  children?: ReactNode
}

export function Card({
  padding = 16,
  flat = false,
  elevated = false,
  className,
  children,
  style,
  ...rest
}: CardProps): ReactNode {
  const classes = cx(styles.card, flat && styles.flat, elevated && styles.elevated, className)

  const paddingCss = typeof padding === 'number' ? `${String(padding)}px` : padding

  return (
    <div {...rest} className={classes} style={{ padding: paddingCss, ...style }}>
      {children}
    </div>
  )
}
