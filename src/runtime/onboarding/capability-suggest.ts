/**
 * Capability suggestion logic (Phase F §2 + §7).
 *
 * Given an interview transcript's accumulated intent tags and the
 * loaded catalog, return a ranked list of suggested Capabilities for
 * the onboarding preview card stack.
 *
 * Algorithm at v1: simple tag overlap.
 *   - For each Capability, count tags in common with the interview.
 *   - Filter: overlap >= `minimum_overlap` (default 1).
 *   - Confidence: `high` if overlap >= `high_confidence_threshold`
 *     (default 2), else `speculative`.
 *   - `default_on`: true iff confidence is `high`. The preview UI
 *     uses this to decide which checkboxes start ticked.
 *   - Sort by overlap_count desc, then by id asc for deterministic
 *     tiebreakers (same input always produces same order).
 *
 * No LLM-driven enrichment at v1 per [[../decisions/2026-05-18-capability-security-model]]
 * §0a-2 (locked: "strict catalog-only at v1; off-catalog asks
 * render 'we can add a walkthrough for that later... want me to
 * file a gap?'"). LLM-augmented suggestion is post-v1 polish.
 *
 * Tags are matched case-insensitively to forgive operator-side
 * variations in the interview transcript ("Email" vs "email").
 */
import type { CapabilityRecord } from './capability-loader.js'

export type SuggestionConfidence = 'high' | 'speculative'

export interface CapabilitySuggestion {
  /** The matched Capability record. */
  capability: CapabilityRecord
  /** Tags from the Capability's `tags[]` that overlapped the interview tags. */
  matched_tags: string[]
  /** Count of overlapping tags. */
  overlap_count: number
  /** `high` (overlap >= threshold) or `speculative` (overlap below). */
  confidence: SuggestionConfidence
  /** Whether the preview UI should default this Capability's checkbox on. */
  default_on: boolean
}

export interface SuggestCapabilitiesOptions {
  /** Tags accumulated from the interview transcript's intent_tags. */
  interview_tags: string[]
  /** All loaded Capabilities (from `loadCapabilities`). */
  capabilities: CapabilityRecord[]
  /** Minimum tag overlap to surface a suggestion at all. Default 1. */
  minimum_overlap?: number
  /** Overlap threshold for high-confidence (default_on) suggestions. Default 2. */
  high_confidence_threshold?: number
}

const DEFAULT_MIN_OVERLAP = 1
const DEFAULT_HIGH_THRESHOLD = 2

/**
 * Rank Capabilities by tag overlap with the interview's intent_tags.
 *
 * Returns an array sorted by overlap_count descending, with id-
 * ascending as a deterministic tiebreaker. Suggestions below the
 * minimum_overlap threshold are filtered out entirely (not just
 * marked low-confidence).
 *
 * Empty interview_tags or empty capabilities → empty array.
 */
export function suggestCapabilities(opts: SuggestCapabilitiesOptions): CapabilitySuggestion[] {
  const minOverlap = opts.minimum_overlap ?? DEFAULT_MIN_OVERLAP
  const highThreshold = opts.high_confidence_threshold ?? DEFAULT_HIGH_THRESHOLD

  if (opts.interview_tags.length === 0 || opts.capabilities.length === 0) {
    return []
  }

  const interviewLower = new Set(opts.interview_tags.map((t) => t.toLowerCase()))

  const suggestions: CapabilitySuggestion[] = []
  for (const cap of opts.capabilities) {
    const matched = cap.frontmatter.tags.filter((t) => interviewLower.has(t.toLowerCase()))
    if (matched.length < minOverlap) continue
    const confidence: SuggestionConfidence =
      matched.length >= highThreshold ? 'high' : 'speculative'
    suggestions.push({
      capability: cap,
      matched_tags: matched,
      overlap_count: matched.length,
      confidence,
      default_on: confidence === 'high',
    })
  }

  suggestions.sort((a, b) => {
    if (b.overlap_count !== a.overlap_count) return b.overlap_count - a.overlap_count
    return a.capability.frontmatter.id.localeCompare(b.capability.frontmatter.id)
  })

  return suggestions
}
