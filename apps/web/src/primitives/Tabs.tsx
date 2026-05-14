import type { ReactNode } from 'react'
import { cx } from './cx'
import styles from './Tabs.module.css'

export interface TabsItem {
  /** Stable id used in `value` and `onChange`. */
  id: string
  /** Visible label. */
  label: ReactNode
}

export interface TabsProps {
  items: readonly TabsItem[]
  value: string
  onChange: (id: string) => void
  className?: string
}

/**
 * Tab strip per design-system-v1.1 ds-components.jsx Tabs. Sans
 * 13px, bg-sunk container, active item lifts to bg-elev with a
 * single-pixel shadow. Stateless ... caller owns `value`.
 */
export function Tabs({ items, value, onChange, className }: TabsProps): ReactNode {
  return (
    <div role="tablist" className={cx(styles.tabs, className)}>
      {items.map((it) => {
        const active = it.id === value
        return (
          <button
            key={it.id}
            type="button"
            role="tab"
            aria-selected={active}
            className={cx(styles.tab, active && styles.active)}
            onClick={() => {
              onChange(it.id)
            }}
          >
            {it.label}
          </button>
        )
      })}
    </div>
  )
}
