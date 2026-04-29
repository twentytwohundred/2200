import type { ReactElement } from 'react'
import { useTheme } from './ThemeProvider'
import styles from './ThemeSwitcher.module.css'

/**
 * Minimal switcher used by the scaffold smoke page. PR C replaces
 * this with the proper Button primitive from the component contract,
 * routed through the command palette (⌘K → "Switch theme").
 */
export function ThemeSwitcher(): ReactElement {
  const { theme, toggle } = useTheme()
  const next = theme === 'default-dark' ? 'default-light' : 'default-dark'

  return (
    <button
      type="button"
      className={styles.switcher}
      onClick={toggle}
      aria-label={`Switch theme to ${next}`}
    >
      <span className={styles.label}>SWITCH</span>
      <span className={styles.arrow} aria-hidden="true">
        →
      </span>
      <span className={styles.target}>{next}</span>
    </button>
  )
}
