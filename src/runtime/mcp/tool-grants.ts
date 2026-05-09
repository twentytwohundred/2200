/**
 * Identity tool-grant expansion (Epic 9 Phase A PR C).
 *
 * The Identity's `tools:` array carries two shapes (per the Phase A
 * locked decisions):
 *
 *   - Exact names: `github_list_issues`, `slack_send`
 *   - Namespace wildcards: `github_*` (or legacy `github.*`)
 *
 * The dispatcher consumes a Set<string> of exact tool names. This
 * module bridges the two: given the raw grant list and the registry's
 * known tool names, produce the expanded Set.
 *
 * Pure function. The expansion is computed once at Agent boot, after
 * all MCP servers are registered with the ToolRegistry. Wildcards
 * that match no registered tools are dropped silently ... it is not
 * an error to declare `github_*` on an Identity whose `mcp_servers`
 * does not include the github server (the operator may be staging
 * the grant before adding the server). Future polish can surface a
 * Passive notification on dropped wildcards if it becomes a footgun.
 *
 * Tool names are underscored throughout the runtime as of session 13.
 * Existing Identity files with legacy dotted wildcards (`github.*`)
 * still expand correctly: the wildcard logic strips the trailing `.*`
 * or `_*` and uses the prefix without the separator. Mixed grants
 * (`github.read` next to `github_*`) work the same way, since exact
 * grants pass through and the wildcard expansion looks up the registry.
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
    // Accept both modern (`github_*`) and legacy (`github.*`) wildcard
    // forms. The prefix kept includes the separator so we don't match
    // partial namespaces (`github_*` should not match `git_status`).
    const wildcardSuffix = grant.endsWith('_*') ? '_*' : grant.endsWith('.*') ? '.*' : null
    if (wildcardSuffix !== null) {
      const baseNamespace = grant.slice(0, -wildcardSuffix.length)
      const underscorePrefix = `${baseNamespace}_`
      const dotPrefix = `${baseNamespace}.`
      for (const name of allKnownTools) {
        if (name.startsWith(underscorePrefix) || name.startsWith(dotPrefix)) {
          expanded.add(name)
        }
      }
    } else {
      expanded.add(grant)
    }
  }
  return expanded
}
