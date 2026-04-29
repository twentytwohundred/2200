import type { ReactElement } from 'react'
import styles from './App.module.css'
import { ThemeSwitcher } from './theme/ThemeSwitcher'
import { useTheme } from './theme/ThemeProvider'

function cx(...classes: (string | undefined)[]): string {
  return classes.filter(Boolean).join(' ')
}

export function App(): ReactElement {
  const { theme } = useTheme()

  return (
    <main className={styles.shell}>
      <header className={styles.header}>
        <span className={styles.eyebrow}>2200 · WEB · SCAFFOLD</span>
        <h1 className={styles.title}>Hello, fleet.</h1>
        <p className={styles.subtitle}>
          The runtime is headless. This surface is theme-aware from v1.
        </p>
      </header>
      <section className={styles.grid}>
        <div className={styles.tile}>
          <span className={styles.label}>STATUS</span>
          <span className={cx(styles.pill, styles.pillRunning)}>
            <span className={styles.pillDot} />
            RUNNING
          </span>
        </div>
        <div className={styles.tile}>
          <span className={styles.label}>THEME</span>
          <span className={styles.value}>{theme}</span>
          <ThemeSwitcher />
        </div>
        <div className={styles.tile}>
          <span className={styles.label}>API</span>
          <span className={styles.value}>not yet wired</span>
        </div>
      </section>
    </main>
  )
}
