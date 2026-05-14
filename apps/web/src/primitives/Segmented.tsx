import type { ReactNode } from 'react'
import { cx } from './cx'
import styles from './Segmented.module.css'

export interface SegmentedOption {
  /** Stable id used in `value` and `onChange`. */
  id: string
  /** Visible label. Lowercased by CSS. */
  label: ReactNode
}

export interface SegmentedProps {
  options: readonly SegmentedOption[]
  value: string
  onChange: (id: string) => void
  className?: string
}

/**
 * Pill-shaped mono segmented control per design-system-v1.1
 * ds-components.jsx Segmented. Used for compact single-select like a
 * filter row or a composer-mode toggle. Stateless ... caller owns
 * `value`.
 */
export function Segmented({ options, value, onChange, className }: SegmentedProps): ReactNode {
  return (
    <div role="tablist" className={cx(styles.segmented, className)}>
      {options.map((o) => {
        const active = o.id === value
        return (
          <button
            key={o.id}
            type="button"
            role="tab"
            aria-selected={active}
            className={cx(styles.option, active && styles.active)}
            onClick={() => {
              onChange(o.id)
            }}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}
