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
import { getOrOpenBrain } from '../../brain/registry.js'

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
  name: 'brain.write',
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
  name: 'brain.read',
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
  name: 'brain.search',
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
  name: 'brain.list',
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
  name: 'brain.delete',
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

export const brainTools: ToolDefinition[] = [
  brainWrite,
  brainRead,
  brainSearch,
  brainList,
  brainDelete,
]
