/**
 * Identity migrator: schema_version 4 -> 5.
 *
 * v5 (Epic 9 Phase A) introduces the `mcp_servers` block ... per-Agent
 * declarations of external MCP servers the supervisor spawns alongside
 * the Agent process at start. The migrator just stamps the version;
 * the Zod schema's `mcp_servers` default ([]) fills the field for any
 * v4 file that lacks the block.
 *
 * v5 also relaxes the `tools` array to admit wildcard tool names
 * (`github.*`) ... v4 files that already validated under the strict
 * `<namespace>.<verb>` regex continue to validate cleanly under v5
 * since the wildcard form is purely additive.
 */

export function migrate4To5(prev: unknown): unknown {
  if (typeof prev !== 'object' || prev === null) {
    return prev
  }
  const obj = prev as Record<string, unknown>
  return { ...obj, schema_version: 5 }
}
