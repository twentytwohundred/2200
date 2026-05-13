import type { InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from 'react'
import { cx } from './cx'
import styles from './Field.module.css'

interface CommonProps {
  /** Optional label rendered above the control. */
  label?: ReactNode
  /** Optional hint rendered below the control. */
  hint?: ReactNode
  /** Use monospace font for the input (paths, IDs, env vars). */
  mono?: boolean
  /** Label-element-wrapping className. */
  className?: string
}

type InputFieldProps = CommonProps & {
  textarea?: false
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'className'>

type TextareaFieldProps = CommonProps & {
  textarea: true
} & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'className'>

export type FieldProps = InputFieldProps | TextareaFieldProps

/**
 * Labeled input or textarea. Reads from --bg-sunk so the input is
 * visibly recessed from its surrounding card. Padding is fixed; the
 * Field always feels like a click-target.
 */
export function Field(props: FieldProps): ReactNode {
  const { label, hint, mono = false, className } = props
  const inputClass = cx(styles.control, mono && styles.mono)

  return (
    <label className={cx(styles.wrap, className)}>
      {label !== undefined && <span className={styles.label}>{label}</span>}
      {props.textarea === true ? (
        <textarea {...stripCommon(props)} className={cx(inputClass, styles.textarea)} />
      ) : (
        <input {...stripCommon(props)} className={inputClass} />
      )}
      {hint !== undefined && <span className={styles.hint}>{hint}</span>}
    </label>
  )
}

function stripCommon<T extends CommonProps>(p: T): Omit<T, keyof CommonProps | 'textarea'> {
  const {
    label: _l,
    hint: _h,
    mono: _m,
    className: _c,
    textarea: _t,
    ...rest
  } = p as T & {
    textarea?: boolean
  }
  void _l
  void _h
  void _m
  void _c
  void _t
  return rest
}
