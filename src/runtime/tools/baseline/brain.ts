/**
 * brain.* baseline tools — Epic 8 Phase A PR C.
 *
 * Slug-based, frontmatter-aware. Each tool routes through the
 * per-Agent BrainStore (markdown files) and BrainIndex (SQLite
 * FTS5 over those files). The BrainIndex registry caches one
 * open DB handle per Agent for the life of the process.
 *
 * Phase A scope: own brain only. The dispatcher already resolves
 * the calling Agent via ToolContext.callingAgent, so each tool
 * targets that Agent's brain dir / index unambiguously. No path
 * args, no pub-style scope arg.
 *
 * Idempotency:
 *   brain.read, brain.search, brain.list   → pure
 *   brain.write                            → checkpointed (re-runs are safe)
 *   brain.delete                           → destructive
 */
import { z } from 'zod'
import { defineTool, type ToolDefinition } from '../../mcp/tool.js'
import { getOrOpenBrain, getOrOpenSharedBrain } from '../../brain/registry.js'
import { BrainIndex, BrainIndexNotFoundError } from '../../brain/index-db.js'
import { BrainStore } from '../../brain/store.js'
import { BrainPermissionDeniedError, canReadBrain } from '../../brain/permissions.js'
import { agentBrainIndexPath } from '../../storage/layout.js'

// ---------------------------------------------------------------------------
// brain.write
// ---------------------------------------------------------------------------

const BrainWriteArgsSchema = z.object({
  title: z.string().min(1),
  body: z.string(),
  /** Free-form note type. See [[08-agent-brain]] for conventional values. */
  type: z.string().optional(),
  tags: z.array(z.string()).optional(),
  /** Pin the slug. Otherwise derived from title with collision suffix. */
  slug: z.string().optional(),
})

export const brainWrite = defineTool({
  name: 'brain_write',
  description: 'Write a brain note (slug-based; frontmatter+body). Upsert-style.',
  idempotency: 'checkpointed',
  argsSchema: BrainWriteArgsSchema,
  execute: async (args, ctx) => {
    const { store } = await getOrOpenBrain(ctx.home, ctx.callingAgent)
    const result = await store.write({
      title: args.title,
      body: args.body,
      ...(args.type !== undefined ? { type: args.type } : {}),
      ...(args.tags !== undefined ? { tags: args.tags } : {}),
      ...(args.slug !== undefined ? { slug: args.slug } : {}),
    })
    // Re-read to get the canonical frontmatter (created/updated/links).
    const note = await store.read(result.slug)
    const { index } = await getOrOpenBrain(ctx.home, ctx.callingAgent)
    index.upsert(note)
    return {
      slug: result.slug,
      created_or_updated: result.created ? 'created' : 'updated',
      path: result.path,
    }
  },
})

// ---------------------------------------------------------------------------
// brain.read
// ---------------------------------------------------------------------------

const BrainReadArgsSchema = z.object({
  slug: z.string().min(1),
})

export const brainRead = defineTool({
  name: 'brain_read',
  description: 'Read a brain note by slug. Returns frontmatter + body.',
  idempotency: 'pure',
  argsSchema: BrainReadArgsSchema,
  execute: async (args, ctx) => {
    const { store } = await getOrOpenBrain(ctx.home, ctx.callingAgent)
    const note = await store.read(args.slug)
    return {
      slug: note.slug,
      title: note.frontmatter.title,
      type: note.frontmatter.type,
      tags: note.frontmatter.tags,
      created: note.frontmatter.created,
      updated: note.frontmatter.updated,
      links: note.frontmatter.links,
      body: note.body,
    }
  },
})

// ---------------------------------------------------------------------------
// brain.search
// ---------------------------------------------------------------------------

const BrainSearchArgsSchema = z.object({
  query: z.string().min(1),
  /** Cap on results. Default 20, max 100. */
  limit: z.number().int().positive().max(100).default(20),
  /** Optional filter: only these note types. */
  types: z.array(z.string()).optional(),
  /** Optional filter: results must include at least one of these tags. */
  any_tag: z.array(z.string()).optional(),
})

export const brainSearch = defineTool({
  name: 'brain_search',
  description: "Full-text search this Agent's brain via SQLite FTS5.",
  idempotency: 'pure',
  argsSchema: BrainSearchArgsSchema,
  execute: async (args, ctx) => {
    const { index } = await getOrOpenBrain(ctx.home, ctx.callingAgent)
    const hits = index.search(args.query, {
      limit: args.limit,
      ...(args.types !== undefined ? { types: args.types } : {}),
      ...(args.any_tag !== undefined ? { anyTag: args.any_tag } : {}),
    })
    return { query: args.query, hits }
  },
})

// ---------------------------------------------------------------------------
// brain.list
// ---------------------------------------------------------------------------

const BrainListArgsSchema = z.object({
  type: z.string().optional(),
  tag: z.string().optional(),
  limit: z.number().int().positive().max(500).default(50),
})

export const brainList = defineTool({
  name: 'brain_list',
  description: "Enumerate this Agent's brain notes, sorted by updated descending.",
  idempotency: 'pure',
  argsSchema: BrainListArgsSchema,
  execute: async (args, ctx) => {
    const { store } = await getOrOpenBrain(ctx.home, ctx.callingAgent)
    const notes = await store.list({
      limit: args.limit,
      ...(args.type !== undefined ? { type: args.type } : {}),
      ...(args.tag !== undefined ? { tag: args.tag } : {}),
    })
    return {
      notes: notes.map((n) => ({
        slug: n.slug,
        title: n.frontmatter.title,
        type: n.frontmatter.type,
        tags: n.frontmatter.tags,
        updated: n.frontmatter.updated,
      })),
    }
  },
})

// ---------------------------------------------------------------------------
// brain.delete
// ---------------------------------------------------------------------------

const BrainDeleteArgsSchema = z.object({
  slug: z.string().min(1),
})

export const brainDelete = defineTool({
  name: 'brain_delete',
  description: 'Delete a brain note by slug. Idempotent on missing.',
  idempotency: 'destructive',
  argsSchema: BrainDeleteArgsSchema,
  execute: async (args, ctx) => {
    const { store, index } = await getOrOpenBrain(ctx.home, ctx.callingAgent)
    await store.delete(args.slug)
    index.delete(args.slug)
    return { slug: args.slug, deleted: true }
  },
})

// ---------------------------------------------------------------------------
// brain.search_agent (Epic 8 Phase C)
// ---------------------------------------------------------------------------

const BrainSearchAgentArgsSchema = z.object({
  agent: z.string().min(1),
  query: z.string().min(1),
  limit: z.number().int().positive().max(100).default(20),
  types: z.array(z.string()).optional(),
  any_tag: z.array(z.string()).optional(),
})

export const brainSearchAgent = defineTool({
  name: 'brain_search_agent',
  description:
    "Full-text search another Agent's brain via SQLite FTS5. Requires the owner to have granted read permission via `2200 brain permissions <owner> --add <caller>`.",
  idempotency: 'pure',
  argsSchema: BrainSearchAgentArgsSchema,
  execute: async (args, ctx) => {
    const allowed = await canReadBrain(ctx.home, args.agent, ctx.callingAgent)
    if (!allowed) {
      throw new BrainPermissionDeniedError(args.agent, ctx.callingAgent)
    }
    if (args.agent === ctx.callingAgent) {
      // Self-read: route through the warm registry handle.
      const { index } = await getOrOpenBrain(ctx.home, ctx.callingAgent)
      const hits = index.search(args.query, {
        limit: args.limit,
        ...(args.types !== undefined ? { types: args.types } : {}),
        ...(args.any_tag !== undefined ? { anyTag: args.any_tag } : {}),
      })
      return { agent: args.agent, query: args.query, hits }
    }
    const path = agentBrainIndexPath(ctx.home, args.agent)
    let index: BrainIndex
    try {
      index = BrainIndex.openReadOnlyAtPath(path)
    } catch (err) {
      if (err instanceof BrainIndexNotFoundError) {
        return { agent: args.agent, query: args.query, hits: [] }
      }
      throw err
    }
    try {
      const hits = index.search(args.query, {
        limit: args.limit,
        ...(args.types !== undefined ? { types: args.types } : {}),
        ...(args.any_tag !== undefined ? { anyTag: args.any_tag } : {}),
      })
      return { agent: args.agent, query: args.query, hits }
    } finally {
      index.close()
    }
  },
})

// ---------------------------------------------------------------------------
// brain.list_agent (Epic 8 Phase C)
// ---------------------------------------------------------------------------

const BrainListAgentArgsSchema = z.object({
  agent: z.string().min(1),
  type: z.string().optional(),
  tag: z.string().optional(),
  limit: z.number().int().positive().max(500).default(50),
})

export const brainListAgent = defineTool({
  name: 'brain_list_agent',
  description:
    "Enumerate another Agent's brain notes (no body), sorted by updated descending. Requires permission as for brain.search_agent.",
  idempotency: 'pure',
  argsSchema: BrainListAgentArgsSchema,
  execute: async (args, ctx) => {
    const allowed = await canReadBrain(ctx.home, args.agent, ctx.callingAgent)
    if (!allowed) {
      throw new BrainPermissionDeniedError(args.agent, ctx.callingAgent)
    }
    const store = new BrainStore(ctx.home, args.agent)
    const notes = await store.list({
      limit: args.limit,
      ...(args.type !== undefined ? { type: args.type } : {}),
      ...(args.tag !== undefined ? { tag: args.tag } : {}),
    })
    return {
      agent: args.agent,
      notes: notes.map((n) => ({
        slug: n.slug,
        title: n.frontmatter.title,
        type: n.frontmatter.type,
        tags: n.frontmatter.tags,
        updated: n.frontmatter.updated,
      })),
    }
  },
})

// ---------------------------------------------------------------------------
// brain.{read,search,list,write}_shared — shared brain at <home>/shared/brain
// ---------------------------------------------------------------------------
//
// One shared note pool every Agent on this instance can read and write.
// Used for instance-level context the whole fleet should see: platform
// overview, team roster, operator profile, conventions. Markdown files
// on disk; humans can edit them too.

const BrainReadSharedArgsSchema = z.object({
  slug: z.string().min(1),
})

export const brainReadShared = defineTool({
  name: 'brain_read_shared',
  description:
    "Read a shared brain note by slug from <home>/shared/brain/. The shared brain is one note pool every Agent on this instance can read and write; it's the place to look for the platform overview, team roster, operator profile, and shared conventions.",
  idempotency: 'pure',
  argsSchema: BrainReadSharedArgsSchema,
  execute: async (args, ctx) => {
    const { store } = await getOrOpenSharedBrain(ctx.home)
    const note = await store.read(args.slug)
    return {
      slug: note.slug,
      title: note.frontmatter.title,
      type: note.frontmatter.type,
      tags: note.frontmatter.tags,
      created: note.frontmatter.created,
      updated: note.frontmatter.updated,
      links: note.frontmatter.links,
      body: note.body,
    }
  },
})

const BrainSearchSharedArgsSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().positive().max(100).default(20),
  types: z.array(z.string()).optional(),
  any_tag: z.array(z.string()).optional(),
})

export const brainSearchShared = defineTool({
  name: 'brain_search_shared',
  description:
    "Full-text search the shared brain at <home>/shared/brain/ via SQLite FTS5. Returns hits sorted by relevance. Start any orientation pass here ('platform', 'team', 'operator') ... the shared brain holds instance-level context every Agent should know about.",
  idempotency: 'pure',
  argsSchema: BrainSearchSharedArgsSchema,
  execute: async (args, ctx) => {
    const { index } = await getOrOpenSharedBrain(ctx.home)
    const hits = index.search(args.query, {
      limit: args.limit,
      ...(args.types !== undefined ? { types: args.types } : {}),
      ...(args.any_tag !== undefined ? { anyTag: args.any_tag } : {}),
    })
    return { query: args.query, hits }
  },
})

const BrainListSharedArgsSchema = z.object({
  type: z.string().optional(),
  tag: z.string().optional(),
  limit: z.number().int().positive().max(500).default(50),
})

export const brainListShared = defineTool({
  name: 'brain_list_shared',
  description:
    'Enumerate shared brain notes at <home>/shared/brain/ (no body), sorted by updated descending. Filter by type or tag.',
  idempotency: 'pure',
  argsSchema: BrainListSharedArgsSchema,
  execute: async (args, ctx) => {
    const { store } = await getOrOpenSharedBrain(ctx.home)
    const notes = await store.list({
      limit: args.limit,
      ...(args.type !== undefined ? { type: args.type } : {}),
      ...(args.tag !== undefined ? { tag: args.tag } : {}),
    })
    return {
      items: notes.map((n) => ({
        slug: n.slug,
        title: n.frontmatter.title,
        type: n.frontmatter.type,
        tags: n.frontmatter.tags,
        updated: n.frontmatter.updated,
      })),
    }
  },
})

const BrainWriteSharedArgsSchema = z.object({
  title: z.string().min(1),
  body: z.string(),
  type: z.string().optional(),
  tags: z.array(z.string()).optional(),
  slug: z.string().optional(),
})

export const brainWriteShared = defineTool({
  name: 'brain_write_shared',
  description:
    'Write a note into the shared brain at <home>/shared/brain/. Upsert-style. The shared brain is community-writable at v1; reserve it for instance-level context everyone benefits from (conventions, decisions, runbooks). Per-Agent state should live in your own brain via brain.write.',
  idempotency: 'checkpointed',
  argsSchema: BrainWriteSharedArgsSchema,
  execute: async (args, ctx) => {
    const { store, index } = await getOrOpenSharedBrain(ctx.home)
    const result = await store.write({
      title: args.title,
      body: args.body,
      ...(args.type !== undefined ? { type: args.type } : {}),
      ...(args.tags !== undefined ? { tags: args.tags } : {}),
      ...(args.slug !== undefined ? { slug: args.slug } : {}),
    })
    const note = await store.read(result.slug)
    index.upsert(note)
    return {
      slug: result.slug,
      created_or_updated: result.created ? 'created' : 'updated',
      path: result.path,
    }
  },
})

// ---------------------------------------------------------------------------
// brain.write_research_brief (PR 3 / Phase 1 standing-brief mechanism)
//
// The synthesis-as-Agent-task path produces a standing brief for a
// research thread. This tool is the write surface for that brief:
// the Agent runs its normal task loop, generates the brief body via
// its own LLM, then calls this tool to persist it.
//
// The tool computes provenance from the thread's current state
// (contribution_count, first/last contribution timestamps, contributor
// sources) and writes it as frontmatter on the brief note. Provenance
// is therefore always machine-readable even if the Agent's body
// doesn't cite cleanly.
//
// On success, the thread anchor's frontmatter is patched:
//   - `synthesized_through` = the `pending_synthesis_at` snapshot the
//     tool read at the start of the call (later contributions may
//     have arrived since; the reconciler picks those up on the next
//     tick).
//   - `synthesis_failure_count` reset to 0.
// ---------------------------------------------------------------------------

const BrainWriteResearchBriefArgsSchema = z.object({
  /** Bare thread slug (no `research-` prefix). */
  thread_slug: z.string().min(1),
  /** Markdown body of the synthesized brief. */
  brief_body: z.string().min(1),
  /** Optional: pass through token usage so it lands in the audit event. */
  token_usage: z
    .object({
      input: z.number().optional(),
      output: z.number().optional(),
      total: z.number().optional(),
    })
    .optional(),
  /** Optional: synthesis duration. */
  duration_ms: z.number().optional(),
})

export const brainWriteResearchBrief = defineTool({
  name: 'brain_write_research_brief',
  description:
    "Write the synthesized standing brief for a research thread. Reads the thread's chronological log to compute provenance (contribution count + timestamp range + contributor sources), then writes the brief as a sibling note at `<shared>/brain/research-<slug>-brief.md` and resets the thread's synthesis-failure counter. The calling Agent should typically be the thread's primary agent.",
  idempotency: 'checkpointed',
  argsSchema: BrainWriteResearchBriefArgsSchema,
  execute: async (args, ctx) => {
    const sharedStore = BrainStore.forShared(ctx.home)
    const anchorSlug = `research-${args.thread_slug}`
    const anchor = await sharedStore.tryRead(anchorSlug)
    if (anchor === null) {
      throw new Error(
        `no research thread "${args.thread_slug}" (expected shared brain note ${anchorSlug}.md)`,
      )
    }
    const contributionCount =
      typeof anchor.extras['contribution_count'] === 'number'
        ? anchor.extras['contribution_count']
        : 0
    const pendingSynthesisAt =
      typeof anchor.extras['pending_synthesis_at'] === 'string'
        ? anchor.extras['pending_synthesis_at']
        : null
    const lastContributionAt =
      typeof anchor.extras['last_contribution_at'] === 'string'
        ? anchor.extras['last_contribution_at']
        : null
    // Walk the contribution log body for the first `## <ISO ts>`
    // section's timestamp. The thread anchor doesn't track
    // first-contribution explicitly, so we parse it back out.
    const firstTimestamp = extractFirstContributionTimestamp(anchor.body)

    const { writeBrief, updateAnchorFrontmatter } = await import('../../mcp/connector/synthesis.js')

    const now = new Date()
    const briefResult = await writeBrief({
      home: ctx.home,
      threadSlug: args.thread_slug,
      briefBody: args.brief_body,
      provenance: {
        brief_schema_version: 1,
        source_thread: args.thread_slug,
        synthesized_through: pendingSynthesisAt ?? lastContributionAt ?? now.toISOString(),
        contribution_count: contributionCount,
        contribution_first_at: firstTimestamp,
        contribution_last_at: lastContributionAt,
        // For Phase 1 the connector is the only contribution source.
        // When Claude / OpenAI / others start contributing, the writer
        // path will set additional source markers in the contribution
        // notes; this aggregation will start reading them.
        contributor_sources: ['mcp-connector'],
        synthesizing_agent: ctx.callingAgent,
        ...(args.token_usage !== undefined ? { token_usage: args.token_usage } : {}),
        ...(args.duration_ms !== undefined ? { duration_ms: args.duration_ms } : {}),
        brief_written_at: now.toISOString(),
      },
    })

    await updateAnchorFrontmatter({
      home: ctx.home,
      threadSlug: args.thread_slug,
      updates: {
        synthesized_through: pendingSynthesisAt ?? lastContributionAt ?? now.toISOString(),
        synthesis_failure_count: 0,
      },
    })

    return {
      thread_slug: args.thread_slug,
      brief_slug: briefResult.slug,
      brief_path: briefResult.path,
      brief_created: briefResult.created,
      contribution_count: contributionCount,
    }
  },
})

function extractFirstContributionTimestamp(body: string): string | null {
  const match = /^##\s+(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/m.exec(body)
  return match?.[1] ?? null
}

export const brainTools: ToolDefinition[] = [
  brainWrite,
  brainRead,
  brainSearch,
  brainList,
  brainDelete,
  brainSearchAgent,
  brainListAgent,
  brainReadShared,
  brainSearchShared,
  brainListShared,
  brainWriteShared,
  brainWriteResearchBrief,
]
