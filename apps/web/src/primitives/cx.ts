/**
 * Tiny class-name composer. Filters out falsy values (`undefined`, `null`,
 * `false`, empty string) and joins the rest with spaces.
 *
 * Why a helper: CSS Module imports return `Readonly<Record<string, string>>`,
 * so any dynamic lookup (`styles[`v-${variant}`]`) is typed as
 * `string | undefined`. Template-literal interpolation of that type trips
 * `@typescript-eslint/restrict-template-expressions` ... `cx` sidesteps the
 * issue and reads cleaner than `[a, b].filter(Boolean).join(' ')` at every
 * call site.
 */
export function cx(...classes: (string | false | null | undefined)[]): string {
  return classes.filter((c): c is string => Boolean(c)).join(' ')
}
