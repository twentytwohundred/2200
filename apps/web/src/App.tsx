import type { ReactElement } from 'react'
import styles from './App.module.css'
import { ThemeSwitcher } from './theme/ThemeSwitcher'
import { useTheme } from './theme/ThemeProvider'
import { Pill } from './primitives'

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
          <Pill variant="running">RUNNING</Pill>
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
        <div className={styles.tile}>
          <span className={styles.label}>DEV</span>
          <a className={styles.value} href="/dev/components">
            /dev/components →
          </a>
        </div>
      </section>
    </main>
  )
}
