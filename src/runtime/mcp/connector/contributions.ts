/**
 * Contribution write helpers for the MCP connector (Phase 1 / PR 2).
 *
 * Grok (or any other MCP client) hands structured research material
 * into the fleet through `contribute_to_thread`. This module is the
 * write side: the tool layer validates input and calls into here.
 *
 * Two destinations, one write surface:
 *
 *   1. **Per-Agent** ... a private contribution into one Agent's brain.
 *      Becomes a standalone Brain note at
 *      `<agent>/brain/grok-contribution-<compact-ts>-<hash>.md` with
 *      the `grok-contribution` tag. Fully indexed; the Agent finds it
 *      via the same `brain_search` / `brain_read` tools they use for
 *      their own notes.
 *
 *   2. **Per-thread** ... a contribution to a shared research thread.
 *      A single Brain note at `<shared>/brain/research-<thread>.md`
 *      accumulates contributions chronologically as `## <ISO ts>`
 *      sections. The note is tagged `research-thread`; PR 3 owns the
 *      standing-brief layer on top of this.
 *
 * Subdirectory organization (`<agent>/brain/contributions/...`) was
 * the preferred layout in early review but trips the existing
 * `BrainStore.list()` and FTS5 indexer (both flat-only). Doug's
 * 2026-05-23 decision: ship PR 2 with flat-slug-with-prefix; a
 * separate follow-up PR extends BrainStore.list() to recurse, then a
 * future migration can move these into a subdir without changing the
 * tool surface.
 */
import { createHash } from 'node:crypto'
import { BrainStore } from '../../brain/store.js'

/**
 * Slug rule for research thread names.
 *
 * Stricter than the pub-name rule in `storage/layout.ts`
 * (`/^[a-z0-9][a-z0-9-]*$/`, which allows a leading digit): threads
 * are "named context" rather than technical identifiers, so we
 * require a leading letter. Numbers in the middle are fine.
 *
 * Operators who type free-form thread names (e.g., "Tesla Grok MCP
 * spike") are normalized in `sluggifyThreadName` below.
 */
export const THREAD_SLUG_RULE = /^[a-z][a-z0-9-]{0,63}$/

/** Sanitize a free-form thread name into the canonical slug shape. */
export function sluggifyThreadName(input: string): string {
  const lowered = input.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  const dashed = lowered.trim().replace(/[\s_]+/g, '-')
  const cleaned = dashed.replace(/[^a-z0-9-]+/g, '')
  const collapsed = cleaned.replace(/-+/g, '-').replace(/^-+|-+$/g, '')
  // Drop any leading digit run: `2200-foo` -> `foo`. Threads must
  // start with a letter per the rule above. Empty result is the
  // caller's signal that the input had no usable letters.
  const noLeadingDigit = collapsed.replace(/^[0-9]+/, '').replace(/^-+/, '')
  return noLeadingDigit.slice(0, 64).replace(/-+$/, '')
}

/** Return the canonical slug or null if the input cannot be sluggified. */
export function validateThreadSlug(
  input: string,
): { ok: true; slug: string } | { ok: false; reason: string } {
  const slug = sluggifyThreadName(input)
  if (slug.length === 0) {
    return {
      ok: false,
      reason: `thread name "${input}" has no usable letters (must contain at least one a-z character)`,
    }
  }
  if (!THREAD_SLUG_RULE.test(slug)) {
    return {
      ok: false,
      reason: `thread name "${input}" normalizes to "${slug}", which does not match ${String(THREAD_SLUG_RULE)}`,
    }
  }
  return { ok: true, slug }
}

/** Mint a slug for a per-Agent contribution: `grok-contribution-<ts>-<hash>`. */
export function mintContributionSlug(now: Date, payloadForHash: string): string {
  const compact = now
    .toISOString()
    .replace(/[^0-9]/g, '') // 20260522T161234.567Z → 20260522161234567
    .slice(0, 17)
  const hash = createHash('sha256').update(payloadForHash).digest('hex').slice(0, 6)
  return `grok-contribution-${compact}-${hash}`
}

/**
 * Structured contribution payload, as accepted by the tool layer and
 * passed in here. The Zod schema lives at the tool layer; this
 * interface mirrors it for the write side.
 */
export interface ContributionPayload {
  /** Headline finding(s); one to a few paragraphs. */
  research_findings: string
  /** The thinking that produced the finding. Required (this is the point). */
  reasoning: string
  /** Source citations. Empty array allowed. */
  sources: { url?: string; title?: string; note?: string }[]
  /** Questions the contribution leaves open for the fleet. */
  open_questions: string[]
  /** Optional next-step recommendation. */
  proposed_direction?: string
  /** Cross-references to other threads (display only; not validated). */
  related_threads?: string[]
}

export interface WriteAgentContributionArgs {
  home: string
  agentName: string
  payload: ContributionPayload
  /** Optional thread context for cross-reference in the note frontmatter / body. */
  threadContextSlug?: string
  /** Injected clock (tests). */
  now?: () => Date
}

export interface WriteAgentContributionResult {
  slug: string
  path: string
}

/**
 * Write a per-Agent contribution as a standalone Brain note.
 *
 * The Agent finds it the same way it finds its own notes: through
 * `brain_search` ranked over the tag `grok-contribution`, or by
 * listing the brain. The frontmatter records origin (`mcp-connector`)
 * and any thread-context reference Grok provided.
 */
export async function writeAgentContribution(
  args: WriteAgentContributionArgs,
): Promise<WriteAgentContributionResult> {
  const now = args.now?.() ?? new Date()
  const store = BrainStore.forAgent(args.home, args.agentName)
  const body = renderContributionBody(args.payload, now)
  const slug = mintContributionSlug(now, body)
  const title = deriveContributionTitle(args.payload)
  const tags = ['grok-contribution']
  if (args.threadContextSlug !== undefined) tags.push(`thread:${args.threadContextSlug}`)
  const extras: Record<string, unknown> = {
    contributor: 'mcp-connector',
    received_at: now.toISOString(),
  }
  if (args.threadContextSlug !== undefined) extras['thread_context'] = args.threadContextSlug
  if (args.payload.related_threads && args.payload.related_threads.length > 0) {
    extras['related_threads'] = args.payload.related_threads
  }
  const result = await store.write({
    slug,
    title,
    body,
    type: 'contribution',
    tags,
    extras,
    now: () => now,
  })
  return { slug: result.slug, path: result.path }
}

export interface WriteThreadContributionArgs {
  home: string
  threadSlug: string
  /**
   * Optional display name. If the caller normalized "Tesla Grok MCP
   * Spike" → `tesla-grok-mcp-spike`, the display name keeps the
   * pretty form so the thread note's title reads naturally.
   */
  displayName?: string
  /** Primary Agent (set on first write only). */
  primaryAgent?: string
  payload: ContributionPayload
  /** Injected clock (tests). */
  now?: () => Date
}

export interface WriteThreadContributionResult {
  /** Thread slug as stored. */
  slug: string
  /** Absolute path to the thread note. */
  path: string
  /** True on the first contribution (thread file was created). */
  created: boolean
  /** Total contribution count after this write. */
  contributionCount: number
}

/**
 * Append a contribution to a research thread. One Brain note per
 * thread at `<shared>/brain/research-<slug>.md`. Each contribution
 * becomes a `## <ISO ts>` section in the body; frontmatter tracks
 * `last_contribution_at`, `contribution_count`, and the
 * (set-on-first-write) `primary_agent`.
 *
 * The thread anchor is tagged `research-thread` so PR 3's
 * standing-brief loop can enumerate threads it owns by tag query.
 */
export async function writeThreadContribution(
  args: WriteThreadContributionArgs,
): Promise<WriteThreadContributionResult> {
  const now = args.now?.() ?? new Date()
  const store = BrainStore.forShared(args.home)
  const slug = `research-${args.threadSlug}`
  const existing = await store.tryRead(slug)
  const created = existing === null
  const contributionCount = (existing?.extras['contribution_count'] as number | undefined) ?? 0
  const primaryAgent =
    (existing?.extras['primary_agent'] as string | undefined) ?? args.primaryAgent ?? null
  const displayName =
    (existing?.extras['display_name'] as string | undefined) ?? args.displayName ?? args.threadSlug
  const title = `Research thread: ${displayName}`

  const newSection = renderThreadSection(args.payload, now)
  let newBody: string
  if (existing === null) {
    newBody = renderThreadHead(displayName, primaryAgent ?? undefined, now) + '\n\n' + newSection
  } else {
    newBody = existing.body + '\n\n' + newSection
  }

  const extras: Record<string, unknown> = {
    thread_schema_version: 1,
    contribution_count: contributionCount + 1,
    last_contribution_at: now.toISOString(),
    display_name: displayName,
  }
  if (primaryAgent !== null) extras['primary_agent'] = primaryAgent

  const result = await store.write({
    slug,
    title,
    body: newBody,
    type: 'research-thread',
    tags: ['research-thread'],
    extras,
    now: () => now,
  })

  return {
    slug: result.slug,
    path: result.path,
    created,
    contributionCount: contributionCount + 1,
  }
}

function deriveContributionTitle(payload: ContributionPayload): string {
  const firstLine = payload.research_findings.split('\n')[0]?.trim() ?? ''
  if (firstLine.length === 0) return 'Grok contribution'
  return firstLine.length > 80 ? firstLine.slice(0, 77) + '...' : firstLine
}

/** Render the structured-section body for a per-Agent contribution note. */
function renderContributionBody(payload: ContributionPayload, now: Date): string {
  const parts: string[] = []
  parts.push(`_Contributed via MCP connector at ${now.toISOString()}._`)
  parts.push('')
  parts.push('## Research findings')
  parts.push('')
  parts.push(payload.research_findings.trim())
  parts.push('')
  parts.push('## Reasoning')
  parts.push('')
  parts.push(payload.reasoning.trim())
  if (payload.sources.length > 0) {
    parts.push('')
    parts.push('## Sources')
    parts.push('')
    for (const src of payload.sources) {
      const label = src.title ?? src.url ?? '(no label)'
      const url = src.url ? `[${label}](${src.url})` : label
      const note = src.note ? ` — ${src.note}` : ''
      parts.push(`- ${url}${note}`)
    }
  }
  if (payload.open_questions.length > 0) {
    parts.push('')
    parts.push('## Open questions')
    parts.push('')
    for (const q of payload.open_questions) parts.push(`- ${q.trim()}`)
  }
  if (payload.proposed_direction !== undefined && payload.proposed_direction.trim().length > 0) {
    parts.push('')
    parts.push('## Proposed direction')
    parts.push('')
    parts.push(payload.proposed_direction.trim())
  }
  if (payload.related_threads && payload.related_threads.length > 0) {
    parts.push('')
    parts.push('## Related threads')
    parts.push('')
    for (const t of payload.related_threads) parts.push(`- [[research-${t}]]`)
  }
  return parts.join('\n')
}

/** Render the `## <timestamp>` section for a thread contribution append. */
function renderThreadSection(payload: ContributionPayload, now: Date): string {
  const parts: string[] = []
  parts.push(`## ${now.toISOString()}`)
  parts.push('')
  parts.push('### Research findings')
  parts.push('')
  parts.push(payload.research_findings.trim())
  parts.push('')
  parts.push('### Reasoning')
  parts.push('')
  parts.push(payload.reasoning.trim())
  if (payload.sources.length > 0) {
    parts.push('')
    parts.push('### Sources')
    parts.push('')
    for (const src of payload.sources) {
      const label = src.title ?? src.url ?? '(no label)'
      const url = src.url ? `[${label}](${src.url})` : label
      const note = src.note ? ` — ${src.note}` : ''
      parts.push(`- ${url}${note}`)
    }
  }
  if (payload.open_questions.length > 0) {
    parts.push('')
    parts.push('### Open questions')
    parts.push('')
    for (const q of payload.open_questions) parts.push(`- ${q.trim()}`)
  }
  if (payload.proposed_direction !== undefined && payload.proposed_direction.trim().length > 0) {
    parts.push('')
    parts.push('### Proposed direction')
    parts.push('')
    parts.push(payload.proposed_direction.trim())
  }
  if (payload.related_threads && payload.related_threads.length > 0) {
    parts.push('')
    parts.push('### Related threads')
    parts.push('')
    for (const t of payload.related_threads) parts.push(`- [[research-${t}]]`)
  }
  return parts.join('\n')
}

/** Render the head matter for a newly created thread anchor note. */
function renderThreadHead(
  displayName: string,
  primaryAgent: string | undefined,
  now: Date,
): string {
  const parts: string[] = []
  parts.push(`# Research thread: ${displayName}`)
  parts.push('')
  parts.push(`_Created via MCP connector at ${now.toISOString()}._`)
  if (primaryAgent !== undefined) {
    parts.push(`_Primary agent: ${primaryAgent}._`)
  }
  parts.push('')
  parts.push(
    '_The standing brief layer (PR 3) maintains a synthesized current state of the thread on top of these chronological contributions._',
  )
  return parts.join('\n')
}
