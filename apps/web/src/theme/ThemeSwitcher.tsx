import type { ReactElement } from 'react'
import { useTheme } from './ThemeProvider'
import styles from './ThemeSwitcher.module.css'

/**
 * Compact lightbulb icon-button for switching between dark and
 * light themes. Replaces the older "SWITCH → default-light" text
 * widget that ate too much header real estate. The bulb is filled
 * (lit) when the next-click would bring you to dark, outline (off)
 * when the next click brings you to light.
 *
 * Tooltip + aria-label describe the action so screen readers and
 * hover affordances stay clear.
 */
export function ThemeSwitcher(): ReactElement {
  const { theme, toggle } = useTheme()
  const next = theme === 'default-dark' ? 'light' : 'dark'
  // In light mode, the bulb is "on" (filled) ... clicking turns the
  // lights off (back to dark). In dark mode, the bulb is "off"
  // (outline) ... clicking turns it on.
  const filled = theme === 'default-light'
  return (
    <button
      type="button"
      className={styles.switcher}
      onClick={toggle}
      aria-label={`Switch to ${next} mode`}
      title={`Switch to ${next} mode`}
    >
      <Lightbulb filled={filled} />
    </button>
  )
}

/** Inline SVG lightbulb. Filled or outline based on `filled`. */
function Lightbulb({ filled }: { filled: boolean }): ReactElement {
  return (
    <svg
      className={styles.icon}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path
        d="M12 3a7 7 0 0 0-4 12.7V18a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1v-2.3A7 7 0 0 0 12 3z"
        fill={filled ? 'currentColor' : 'none'}
        opacity={filled ? 0.85 : 1}
      />
      <path d="M9 21h6" />
    </svg>
  )
}
