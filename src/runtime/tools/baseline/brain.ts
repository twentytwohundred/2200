/**
 * brain.* baseline tools (read, write, search, links).
 *
 * Per the Epic 2 spec yellow flag: "v1 behavior is the Brain's
 * behavior until Epic 8. Consumers should treat the v1 API as stable;
 * the implementation underneath swaps in Epic 8 (FTS5 index, real
 * graph store, semantic embedding option) without breaking the
 * contract."
 *
 * Idempotency:
 *   brain.read, brain.search, brain.links -> pure
 *   brain.write                            -> checkpointed
 *
 * Files live under <home>/agents/<name>/brain/, accessed via the
 * /brain/ virtual prefix the dispatcher resolves before calling
 * execute(). Each note is markdown with optional YAML frontmatter; we
 * preserve user-friendly extraction of `[[wiki-style]]` backlinks.
 */
import { mkdir, readdir, readFile, stat } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { z } from 'zod'
import { atomicWriteFile } from '../../util/atomic-write.js'
import { defineTool, type ToolDefinition } from '../../mcp/tool.js'

// ---------------------------------------------------------------------------
// brain.read
// ---------------------------------------------------------------------------

const BrainReadArgsSchema = z.object({
  path: z.string().min(1),
})

export const brainRead = defineTool({
  name: 'brain.read',
  description: 'Read a Brain note. Returns its UTF-8 contents.',
  idempotency: 'pure',
  argsSchema: BrainReadArgsSchema,
  pathArgs: [{ argName: 'path', operation: 'read' }],
  execute: async (args) => {
    const content = await readFile(args.path, 'utf8')
    return { content }
  },
})

// ---------------------------------------------------------------------------
// brain.write
// ---------------------------------------------------------------------------

const BrainWriteArgsSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
})

export const brainWrite = defineTool({
  name: 'brain.write',
  description: 'Write a Brain note. Atomic via temp+rename. Creates parent dirs.',
  idempotency: 'checkpointed',
  argsSchema: BrainWriteArgsSchema,
  pathArgs: [{ argName: 'path', operation: 'write' }],
  execute: async (args) => {
    await mkdir(dirname(args.path), { recursive: true })
    await atomicWriteFile(args.path, args.content)
    return { bytes_written: Buffer.byteLength(args.content, 'utf8') }
  },
})

// ---------------------------------------------------------------------------
// brain.search (grep-based at v1; FTS5 lands in Epic 8)
// ---------------------------------------------------------------------------

const BrainSearchArgsSchema = z.object({
  query: z.string().min(1),
  /** Where to search. Defaults to the Agent's brain root. */
  scope: z.string().default('/brain'),
  max_results: z.number().int().positive().max(100).default(20),
  case_sensitive: z.boolean().default(false),
})

export const brainSearch = defineTool({
  name: 'brain.search',
  description: 'Full-text search Brain notes (v1: grep-style; Epic 8 swaps in FTS5).',
  idempotency: 'pure',
  argsSchema: BrainSearchArgsSchema,
  pathArgs: [{ argName: 'scope', operation: 'read' }],
  execute: async (args) => {
    const results = await grepDirectory({
      root: args.scope,
      query: args.query,
      caseSensitive: args.case_sensitive,
      maxResults: args.max_results,
    })
    return { results, query: args.query }
  },
})

interface GrepArgs {
  root: string
  query: string
  caseSensitive: boolean
  maxResults: number
}

interface GrepHit {
  path: string
  line: number
  preview: string
}

async function grepDirectory(args: GrepArgs): Promise<GrepHit[]> {
  const hits: GrepHit[] = []
  const needle = args.caseSensitive ? args.query : args.query.toLowerCase()
  const visit = async (dir: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (hits.length >= args.maxResults) return
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.')) continue
        await visit(full)
        continue
      }
      if (!entry.isFile()) continue
      let text: string
      try {
        text = await readFile(full, 'utf8')
      } catch {
        continue
      }
      const lines = text.split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (hits.length >= args.maxResults) return
        const haystack = args.caseSensitive ? (lines[i] ?? '') : (lines[i] ?? '').toLowerCase()
        if (haystack.includes(needle)) {
          hits.push({
            path: relative(args.root, full),
            line: i + 1,
            preview: (lines[i] ?? '').slice(0, 200),
          })
        }
      }
    }
  }

  const rootStat = await stat(args.root).catch(() => null)
  if (!rootStat) return []
  if (rootStat.isFile()) {
    // Single-file scope: grep that file directly.
    const text = await readFile(args.root, 'utf8')
    const lines = text.split('\n')
    for (let i = 0; i < lines.length && hits.length < args.maxResults; i++) {
      const haystack = args.caseSensitive ? (lines[i] ?? '') : (lines[i] ?? '').toLowerCase()
      if (haystack.includes(needle)) {
        hits.push({
          path: '',
          line: i + 1,
          preview: (lines[i] ?? '').slice(0, 200),
        })
      }
    }
    return hits
  }
  await visit(args.root)
  return hits
}

// ---------------------------------------------------------------------------
// brain.links
// ---------------------------------------------------------------------------

const BrainLinksArgsSchema = z.object({
  path: z.string().min(1),
})

export const brainLinks = defineTool({
  name: 'brain.links',
  description: 'Extract `[[wiki-style]]` backlinks from a Brain note.',
  idempotency: 'pure',
  argsSchema: BrainLinksArgsSchema,
  pathArgs: [{ argName: 'path', operation: 'read' }],
  execute: async (args) => {
    const content = await readFile(args.path, 'utf8')
    const matches = content.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)
    const links = new Set<string>()
    for (const m of matches) {
      if (m[1]) links.add(m[1].trim())
    }
    return { links: Array.from(links).sort() }
  },
})

export const brainTools: ToolDefinition[] = [brainRead, brainWrite, brainSearch, brainLinks]
