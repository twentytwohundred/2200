/**
 * Identity migrator: schema_version 0 -> 1.
 *
 * Stub. There is no real v0 of the Identity schema; this migrator exists
 * to validate the chain pattern (per [[upgrade-readiness]] discipline 1)
 * before any real migration is needed. When the first breaking change
 * lands, replace this body with the real transformation and add
 * `1-to-2.ts` for the next hop.
 *
 * Behavior: stamps `schema_version: 1` if missing or zero. Leaves all
 * other fields untouched. Validation against the v1 Zod schema happens
 * after all migrators run.
 */

export function migrate0To1(prev: unknown): unknown {
  if (typeof prev !== 'object' || prev === null) {
    return prev
  }
  const obj = prev as Record<string, unknown>
  return { ...obj, schema_version: 1 }
}
