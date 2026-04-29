import type { InputHTMLAttributes, ReactNode } from 'react'
import { cx } from './cx'
import styles from './Input.module.css'

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  /** Render hint icon (e.g. magnifier) inside the input gutter. */
  leadingSlot?: ReactNode
}

export function Input({ leadingSlot, className, ...rest }: InputProps): ReactNode {
  if (leadingSlot) {
    return (
      <span className={cx(styles.shell, className)}>
        <span className={styles.leading}>{leadingSlot}</span>
        <input {...rest} className={styles.input} />
      </span>
    )
  }

  return <input {...rest} className={cx(styles.input, className)} />
}
