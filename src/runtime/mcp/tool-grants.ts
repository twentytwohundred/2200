/**
 * Identity tool-grant expansion (Epic 9 Phase A PR C).
 *
 * The Identity's `tools:` array carries two shapes (per the Phase A
 * locked decisions):
 *
 *   - Exact names: `github.list_issues`, `slack.send`
 *   - Namespace wildcards: `github.*`
 *
 * The dispatcher consumes a Set<string> of exact tool names. This
 * module bridges the two: given the raw grant list and the registry's
 * known tool names, produce the expanded Set.
 *
 * Pure function. The expansion is computed once at Agent boot, after
 * all MCP servers are registered with the ToolRegistry. Wildcards
 * that match no registered tools are dropped silently ... it is not
 * an error to declare `github.*` on an Identity whose `mcp_servers`
 * does not include the github server (the operator may be staging
 * the grant before adding the server). Future polish can surface a
 * Passive notification on dropped wildcards if it becomes a footgun.
 */

/**
 * Expand a list of tool grants (mix of exact names + wildcards) into
 * the concrete Set<string> the dispatcher's `allowedToolNames` and
 * the AgentLoop's `availableToolNames` consume.
 *
 * `allKnownTools` is typically `registry.toolNames()` after baseline
 * + MCP server registration.
 */
export function expandToolGrants(
  grants: readonly string[],
  allKnownTools: readonly string[],
): Set<string> {
  const expanded = new Set<string>()
  for (const grant of grants) {
    if (grant.endsWith('.*')) {
      const prefix = grant.slice(0, -1) // keep the dot, drop the star
      for (const name of allKnownTools) {
        if (name.startsWith(prefix)) expanded.add(name)
      }
    } else {
      expanded.add(grant)
    }
  }
  return expanded
}
