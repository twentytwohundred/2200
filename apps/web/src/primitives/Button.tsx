import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { cx } from './cx'
import styles from './Button.module.css'

export type ButtonVariant = 'default' | 'primary' | 'ghost' | 'destructive'
export type ButtonSize = 'sm' | 'md' | 'lg'

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'> {
  variant?: ButtonVariant
  size?: ButtonSize
  /** Square icon-only button (28x28 / sm 24x24). */
  icon?: boolean
  /** Inline keyboard hint (e.g. "↵", "⌘ K"). */
  kbd?: string
  /** Defaults to type="button" so a Button inside a form does not submit by accident. */
  type?: 'button' | 'submit' | 'reset'
  children?: ReactNode
}

export function Button({
  variant = 'default',
  size = 'md',
  icon = false,
  kbd,
  disabled = false,
  type = 'button',
  children,
  className,
  ...rest
}: ButtonProps): ReactNode {
  const classes = cx(
    styles.btn,
    styles[`v-${variant}`],
    styles[`s-${size}`],
    icon && styles.icon,
    className,
  )

  return (
    <button {...rest} type={type} disabled={disabled} className={classes}>
      <span className={styles.body}>{children}</span>
      {kbd ? <span className={styles.kbd}>{kbd}</span> : null}
    </button>
  )
}
