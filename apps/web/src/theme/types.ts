/**
 * Theme identifiers shipped at v1.
 *
 * The third theme is deferred per the 2026-04-29 session call. When
 * additional themes ship, extend this union (and add the matching
 * generated CSS). The class swap maps `default-dark` to `theme-dark`
 * and `default-light` to `theme-light` to match the
 * design-system/component-contract.md surface.
 */
export type ThemeId = 'default-dark' | 'default-light'

export const DEFAULT_THEME: ThemeId = 'default-dark'

export const STORAGE_KEY = '2200.theme'

export function isThemeId(value: unknown): value is ThemeId {
  return value === 'default-dark' || value === 'default-light'
}

export const ALL_THEMES: readonly ThemeId[] = ['default-dark', 'default-light']

/**
 * Maps a theme id to the CSS class name used on the root element.
 * Per the component contract, the class is `theme-dark` or
 * `theme-light` ... not the full theme id. When more themes ship,
 * this mapping evolves (e.g. multiple dark themes layered as
 * `theme-dark.theme-high-contrast`).
 */
export function themeClass(theme: ThemeId): 'theme-dark' | 'theme-light' {
  return theme === 'default-dark' ? 'theme-dark' : 'theme-light'
}
