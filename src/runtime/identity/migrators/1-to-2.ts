/**
 * Identity migrator: schema_version 1 -> 2.
 *
 * v2 (Epic 4.5) introduced the `cost_caps` block. The migrator just
 * stamps the version; the Zod schema's `cost_caps` default fills the
 * field with `daily_usd: DEFAULT_DAILY_USD_CAP` for any v1 file that
 * lacks the block.
 *
 * Defaulting in the schema rather than in the migrator keeps "what is
 * the current default cost cap" answerable in one place per
 * [[upgrade-readiness]] discipline 1.
 */

export function migrate1To2(prev: unknown): unknown {
  if (typeof prev !== 'object' || prev === null) {
    return prev
  }
  const obj = prev as Record<string, unknown>
  return { ...obj, schema_version: 2 }
}
