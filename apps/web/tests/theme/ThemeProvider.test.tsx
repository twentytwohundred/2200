import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, renderHook, screen } from '@testing-library/react'
import { ThemeProvider, useTheme } from '../../src/theme/ThemeProvider'
import { STORAGE_KEY } from '../../src/theme/types'
import type { ReactNode } from 'react'

/**
 * jsdom in vitest 2.x ships with a localStorage that isn't a full Storage
 * implementation across all method shapes. Using vi.stubGlobal with a
 * hand-rolled in-memory store gives every test a fresh slate without
 * relying on the host implementation's quirks.
 */
function makeMockStorage(): Storage {
  let store = new Map<string, string>()
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v)
    },
    removeItem: (k: string) => {
      store.delete(k)
    },
    clear: () => {
      store = new Map()
    },
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() {
      return store.size
    },
  }
}

function makeMatchMedia(prefersLight: boolean) {
  return (query: string): MediaQueryList => ({
    matches: query === '(prefers-color-scheme: light)' ? prefersLight : false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(() => false),
  })
}

function wrap(children: ReactNode) {
  return <ThemeProvider>{children}</ThemeProvider>
}

function installMockStorage(): Storage {
  const mock = makeMockStorage()
  Object.defineProperty(window, 'localStorage', {
    value: mock,
    writable: true,
    configurable: true,
  })
  return mock
}

function installMatchMedia(prefersLight: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    value: makeMatchMedia(prefersLight),
    writable: true,
    configurable: true,
  })
}

beforeEach(() => {
  document.documentElement.classList.remove('dark')
  installMockStorage()
  installMatchMedia(false)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ThemeProvider initial detection', () => {
  it('reads the persisted theme from localStorage when present', () => {
    window.localStorage.setItem(STORAGE_KEY, 'default-light')

    render(wrap(<ProbeTheme />))

    expect(screen.getByTestId('theme')).toHaveTextContent('default-light')
    expect(document.documentElement.classList.contains('dark')).toBe(false)
  })

  it('falls back to prefers-color-scheme: light when no preference is stored', () => {
    installMatchMedia(true)

    render(wrap(<ProbeTheme />))

    expect(screen.getByTestId('theme')).toHaveTextContent('default-light')
  })

  it('defaults to default-dark when nothing else applies', () => {
    render(wrap(<ProbeTheme />))

    expect(screen.getByTestId('theme')).toHaveTextContent('default-dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })

  it('honours initialTheme prop, ignoring storage and prefers-color-scheme', () => {
    window.localStorage.setItem(STORAGE_KEY, 'default-light')
    installMatchMedia(true)

    render(
      <ThemeProvider initialTheme="default-dark">
        <ProbeTheme />
      </ThemeProvider>,
    )

    expect(screen.getByTestId('theme')).toHaveTextContent('default-dark')
  })
})

describe('ThemeProvider transitions', () => {
  it('setTheme toggles the dark class on <html> and persists to localStorage', () => {
    render(
      <ThemeProvider initialTheme="default-dark">
        <ProbeTheme />
      </ThemeProvider>,
    )

    expect(document.documentElement.classList.contains('dark')).toBe(true)

    fireEvent.click(screen.getByTestId('set-light'))

    expect(document.documentElement.classList.contains('dark')).toBe(false)
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('default-light')
  })

  it('toggle flips dark <-> light', () => {
    render(
      <ThemeProvider initialTheme="default-dark">
        <ProbeTheme />
      </ThemeProvider>,
    )

    fireEvent.click(screen.getByTestId('toggle'))
    expect(screen.getByTestId('theme')).toHaveTextContent('default-light')
    expect(document.documentElement.classList.contains('dark')).toBe(false)

    fireEvent.click(screen.getByTestId('toggle'))
    expect(screen.getByTestId('theme')).toHaveTextContent('default-dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })
})

describe('useTheme outside a provider', () => {
  it('throws a clear error when called without a ThemeProvider', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {
      /* swallow React's expected throw log */
    })

    expect(() => {
      renderHook(() => useTheme())
    }).toThrow('useTheme must be used inside a <ThemeProvider>')

    errorSpy.mockRestore()
  })
})

function ProbeTheme() {
  const { theme, setTheme, toggle } = useTheme()
  return (
    <div>
      <span data-testid="theme">{theme}</span>
      <button
        type="button"
        data-testid="set-light"
        onClick={() => {
          setTheme('default-light')
        }}
      >
        light
      </button>
      <button type="button" data-testid="toggle" onClick={toggle}>
        toggle
      </button>
    </div>
  )
}
