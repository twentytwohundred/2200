/**
 * Apply an operator's capability-selection override to a preview's
 * handoff. Used by the HTTP confirm endpoint (Phase F §12 step 5) so
 * the web wizard's checkbox picker can swap the auto-applied
 * default_on set for an operator-curated one.
 *
 * Subset semantics: the operator can only pick from the ids the
 * session's `suggestCapabilities` already surfaced (`preview.capabilities`).
 * Arbitrary ids from the wire are rejected. The runtime is the
 * security boundary, not the UI ... a future malicious/buggy client
 * cannot inject capabilities the session never proposed.
 *
 * Empty override (`[]`) is meaningful: it means the operator
 * deselected every suggestion. The resulting handoff has
 * `capabilities: []` and the orientation pre-renderer skips the
 * walkthrough entirely. That's a legitimate operator choice (e.g.
 * "I'll wire credentials by hand later").
 */
import type { HandoffDocument } from '../migration/types.js'
import type { CapabilitySuggestion } from './capability-suggest.js'

export type ApplyCapabilityOverrideResult =
  | { ok: true; handoff: HandoffDocument }
  | { ok: false; invalid_ids: string[] }

export interface ApplyCapabilityOverrideArgs {
  /** The session preview's auto-built handoff. */
  handoff: HandoffDocument
  /** The session preview's full suggestion list (subset gate). */
  suggestions: readonly CapabilitySuggestion[]
  /**
   * Operator-selected ids to write into `handoff.frontmatter.capabilities`.
   * Empty array is meaningful ... see module docstring.
   */
  selected_ids: readonly string[]
}

export function applyCapabilityOverride(
  args: ApplyCapabilityOverrideArgs,
): ApplyCapabilityOverrideResult {
  const suggested = new Set(args.suggestions.map((s) => s.capability.frontmatter.id))
  const invalid = args.selected_ids.filter((id) => !suggested.has(id))
  if (invalid.length > 0) {
    return { ok: false, invalid_ids: invalid }
  }
  return {
    ok: true,
    handoff: {
      ...args.handoff,
      frontmatter: {
        ...args.handoff.frontmatter,
        capabilities: [...args.selected_ids],
      },
    },
  }
}
