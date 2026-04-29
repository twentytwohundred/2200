import { forwardRef, type InputHTMLAttributes, type ReactNode } from 'react'
import { cx } from './cx'
import styles from './Input.module.css'

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  /** Render hint icon (e.g. magnifier) inside the input gutter. */
  leadingSlot?: ReactNode
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { leadingSlot, className, ...rest },
  ref,
) {
  if (leadingSlot) {
    return (
      <span className={cx(styles.shell, className)}>
        <span className={styles.leading}>{leadingSlot}</span>
        <input ref={ref} {...rest} className={styles.input} />
      </span>
    )
  }

  return <input ref={ref} {...rest} className={cx(styles.input, className)} />
})
