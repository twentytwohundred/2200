/**
 * Theme identifiers.
 *
 * Light is the default theme (defined in `:root` in
 * `tokens.css`). Dark is applied by toggling the `dark` class on
 * `<html>` ... `html.dark { ... }` in `theme-default-dark.css`
 * overrides the color tokens.
 *
 * Theme ids stay namespaced (`default-dark`, `default-light`) so
 * additional themes can ship later (e.g. high-contrast variants
 * stacked on a base theme).
 */
export type ThemeId = 'default-dark' | 'default-light'

export const DEFAULT_THEME: ThemeId = 'default-dark'

export const STORAGE_KEY = '2200.theme'

export function isThemeId(value: unknown): value is ThemeId {
  return value === 'default-dark' || value === 'default-light'
}

export const ALL_THEMES: readonly ThemeId[] = ['default-dark', 'default-light']

/**
 * Whether a theme should set the `dark` class on the document root.
 * Light is the default (no class needed); dark overrides via
 * `html.dark { ... }`.
 */
export function isDarkTheme(theme: ThemeId): boolean {
  return theme === 'default-dark'
}
