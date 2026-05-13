import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react'
import { DEFAULT_THEME, isDarkTheme, isThemeId, STORAGE_KEY, type ThemeId } from './types'

interface ThemeContextValue {
  theme: ThemeId
  setTheme: (next: ThemeId) => void
  toggle: () => void
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined)

interface ThemeProviderProps {
  children: ReactNode
  /** Override initial detection (testing). When set, localStorage and prefers-color-scheme are ignored. */
  initialTheme?: ThemeId
}

/**
 * Storage access is wrapped in try/catch because user agents legitimately
 * raise on every operation in some configurations: Safari private mode
 * with quota=0, jsdom builds where localStorage methods are not full
 * Storage shapes, and any setting that disables site data. We treat
 * storage as best-effort ... a missed read just means the user gets the
 * prefers-color-scheme fallback; a missed write just means the choice
 * does not persist past the tab.
 */
function readStoredTheme(): ThemeId | null {
  if (typeof window === 'undefined') return null
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY)
    return isThemeId(stored) ? stored : null
  } catch {
    return null
  }
}

function writeStoredTheme(theme: ThemeId): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(STORAGE_KEY, theme)
  } catch {
    /* storage unavailable; the choice will not persist past this tab */
  }
}

function detectInitialTheme(): ThemeId {
  if (typeof window === 'undefined') return DEFAULT_THEME

  const stored = readStoredTheme()
  if (stored !== null) return stored

  if (typeof window.matchMedia === 'function') {
    const prefersLight = window.matchMedia('(prefers-color-scheme: light)').matches
    if (prefersLight) return 'default-light'
  }

  return DEFAULT_THEME
}

function applyThemeClass(theme: ThemeId): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  if (isDarkTheme(theme)) {
    root.classList.add('dark')
  } else {
    root.classList.remove('dark')
  }
}

export function ThemeProvider({ children, initialTheme }: ThemeProviderProps): ReactElement {
  const [theme, setThemeState] = useState<ThemeId>(() => initialTheme ?? detectInitialTheme())

  useEffect(() => {
    applyThemeClass(theme)
    writeStoredTheme(theme)
  }, [theme])

  const setTheme = useCallback((next: ThemeId) => {
    setThemeState(next)
  }, [])

  const toggle = useCallback(() => {
    setThemeState((current) => (current === 'default-dark' ? 'default-light' : 'default-dark'))
  }, [])

  const value = useMemo<ThemeContextValue>(
    () => ({ theme, setTheme, toggle }),
    [theme, setTheme, toggle],
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext)
  if (!ctx) {
    throw new Error('useTheme must be used inside a <ThemeProvider>')
  }
  return ctx
}
