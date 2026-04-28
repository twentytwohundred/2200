/**
 * Identity migrator: schema_version 3 -> 4.
 *
 * v4 (Epic 7) introduced the `notification_policy` block. The
 * migrator just stamps the version; the Zod schema's
 * `notification_policy` default fills the field with the standard
 * tiers_allowed list (`passive`, `normal`, `important`) for any
 * v3 file that lacks the block.
 *
 * The default deliberately omits `critical`. Per CLAUDE.md
 * "Notification tier gating": Agents cannot escalate their own
 * priority. The user opts in to critical for a specific Agent by
 * editing the Identity file.
 */

export function migrate3To4(prev: unknown): unknown {
  if (typeof prev !== 'object' || prev === null) {
    return prev
  }
  const obj = prev as Record<string, unknown>
  return { ...obj, schema_version: 4 }
}
