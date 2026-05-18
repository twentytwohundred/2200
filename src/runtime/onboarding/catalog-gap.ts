/**
 * Catalog-gap tracker (Phase F §0a-2 follow-up).
 *
 * When an operator describes a capability or integration the catalog
 * doesn't cover yet, we record a "gap" entry so tier 2 (and beyond)
 * batch lifts are prioritized by real demand, not by guess.
 *
 * Storage model: one markdown file per gap, with YAML frontmatter.
 * Mirrors the Capability Catalog convention deliberately ... gaps
 * are demand signals for future Capability entries, so they belong
 * in the same shape so a future `2200 catalog gap promote <id>`
 * step can scaffold a Capability entry from a gap.
 *
 * Storage location (v1):
 *   - `_2200_GAPS_DIR` env var (operator override, e.g. tests).
 *   - `~/.2200/catalog/gaps/` (default operator-local store).
 *   - `<process.cwd()>/../wiki/catalog/gaps/` (dev fallback so
 *     `pnpm tsx scripts/...` can list dev-mode entries without
 *     touching $HOME).
 *
 * Writes always target the FIRST resolved dir; reads scan the same
 * dir. Cross-dir merge is deferred until there's a real need (e.g.
 * a shipped "common gaps" set that operators inherit, the same way
 * the Capability Catalog has a first-party + local-overrides split).
 * v1 is single-dir; the resolution priority above is enough.
 *
 * Schema fields:
 *   - id: kebab-case slug, derived from the description or supplied
 *     directly. Used as the filename (`<id>.md`).
 *   - recorded_at: ISO timestamp. Set automatically; the operator
 *     doesn't pass it.
 *   - operator_description: free-text. What the operator asked for,
 *     in their own words. Load-bearing ... this is what gets read
 *     during tier-2 prioritization.
 *   - context: where the gap surfaced. `onboarding` (during the
 *     wizard), `runtime` (an Agent hit a missing tool), or
 *     `manual` (operator filed it after the fact). Optional;
 *     defaults to `manual`.
 *   - agent_name: when context is `onboarding` or `runtime`, the
 *     Agent that surfaced the gap. Optional.
 *   - related_intent_tags: tags from the interview transcript that
 *     didn't match any catalog entry. Optional; populated by the
 *     wizard auto-file flow when it lands.
 *   - status: `open` | `in_progress` | `resolved` | `dropped`.
 *     Defaults to `open`. Operator-editable post-hoc.
 *   - resolution_note: free-text. When status flips off `open`,
 *     a one-line note explaining the resolution (the capability
 *     id that subsumed the ask, the reason for dropping, etc.).
 *     Optional; not enforced by status.
 *
 * Body: an optional markdown body for longer context the operator
 * wants to attach. Empty body is fine.
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { z } from 'zod'
import { createLogger, type Logger } from '../util/logger.js'

const GAP_ID_RE = /^[a-z][a-z0-9-]*$/

export const GAP_CONTEXT = ['onboarding', 'runtime', 'manual'] as const
export const GAP_STATUS = ['open', 'in_progress', 'resolved', 'dropped'] as const

export const CatalogGapFrontmatterSchema = z.object({
  id: z.string().min(1).regex(GAP_ID_RE, {
    message:
      'gap id must start with a lowercase letter, then lowercase letters / digits / dashes only',
  }),
  recorded_at: z.iso.datetime(),
  operator_description: z.string().min(1).max(2000),
  context: z.enum(GAP_CONTEXT).default('manual'),
  agent_name: z.string().min(1).optional(),
  related_intent_tags: z.array(z.string().min(1)).default([]),
  status: z.enum(GAP_STATUS).default('open'),
  resolution_note: z.string().min(1).max(500).optional(),
})
export type CatalogGapFrontmatter = z.infer<typeof CatalogGapFrontmatterSchema>

export interface CatalogGapRecord {
  frontmatter: CatalogGapFrontmatter
  body: string
  source_path: string
}

export interface RecordGapArgs {
  operator_description: string
  /** Optional explicit id; otherwise derived from operator_description. */
  id?: string
  context?: (typeof GAP_CONTEXT)[number]
  agent_name?: string
  related_intent_tags?: readonly string[]
  /** Optional longer body to attach. */
  body?: string
  /** Override the gaps dir (tests, scripts). */
  dir?: string
  /** Test injection. Defaults to () => new Date(). */
  now?: () => Date
}

export interface ListGapsArgs {
  /** Override the gaps dir (tests, scripts). */
  dir?: string
  /** Filter by status. */
  status?: (typeof GAP_STATUS)[number]
}

/**
 * Resolve the gaps directory.
 *
 * Priority: `_2200_GAPS_DIR` env > `~/.2200/catalog/gaps/` > dev
 * fallback at `<cwd>/../wiki/catalog/gaps/`. Returns the first
 * existing dir for READ paths; for WRITE paths the caller should
 * pass through `ensureGapsDir` to create the local default if it
 * doesn't exist yet.
 */
export function resolveGapsDir(): string | null {
  const env = process.env['_2200_GAPS_DIR']
  if (env && existsSync(env)) return env
  const local = join(homedir(), '.2200', 'catalog', 'gaps')
  if (existsSync(local)) return local
  const dev = resolve(process.cwd(), '..', 'wiki', 'catalog', 'gaps')
  if (existsSync(dev)) return dev
  return null
}

/**
 * Return the gaps dir that the WRITE side should target. Creates
 * the dir if it doesn't exist. Priority for the write target:
 *   1. `_2200_GAPS_DIR` env (always honored, created if missing).
 *   2. `~/.2200/catalog/gaps/` (default operator-local store).
 *
 * The dev-fallback path (`<cwd>/../wiki/catalog/gaps/`) is read-
 * only ... committing gap entries straight into the wiki bypasses
 * the operator-local sandbox, so writes go to $HOME by default
 * and an explicit `--dir` (or env override) is needed to land
 * elsewhere.
 */
export async function ensureGapsDir(): Promise<string> {
  const env = process.env['_2200_GAPS_DIR']
  const target = env ?? join(homedir(), '.2200', 'catalog', 'gaps')
  await mkdir(target, { recursive: true })
  return target
}

/**
 * Slugify a free-form description into a kebab-case id. Caps length
 * at 60 chars so filenames stay manageable. If the description is
 * empty after slugify, returns a timestamp-based fallback id.
 */
export function slugifyGapId(description: string, now: Date = new Date()): string {
  const slug = description
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '')
  if (slug.length === 0 || !/^[a-z]/.test(slug)) {
    return `gap-${now.toISOString().slice(0, 10)}-${now.getTime().toString(36)}`
  }
  return slug
}

/**
 * Record a new gap. Writes `<id>.md` into the resolved write dir.
 *
 * Idempotency: if a file already exists at the target path, the
 * write FAILS rather than overwriting. The operator picks a new id
 * (or edits the existing gap directly). This is a deliberate choice
 * ... gaps are append-only signals; we want collision visibility.
 */
export async function recordCatalogGap(args: RecordGapArgs): Promise<CatalogGapRecord> {
  const nowFn = args.now ?? ((): Date => new Date())
  const now = nowFn()
  const dir = args.dir ?? (await ensureGapsDir())

  const id = args.id ?? slugifyGapId(args.operator_description, now)
  const frontmatter: CatalogGapFrontmatter = CatalogGapFrontmatterSchema.parse({
    id,
    recorded_at: now.toISOString(),
    operator_description: args.operator_description,
    context: args.context ?? 'manual',
    ...(args.agent_name !== undefined ? { agent_name: args.agent_name } : {}),
    related_intent_tags: args.related_intent_tags ?? [],
    status: 'open',
  })

  const body = args.body ?? ''
  const path = join(dir, `${id}.md`)
  if (existsSync(path)) {
    throw new Error(
      `catalog gap "${id}" already exists at ${path}; pass a different --id or edit the file directly`,
    )
  }
  const content = `---\n${stringifyYaml(frontmatter)}---\n${body.length > 0 ? `\n${body}\n` : ''}`
  await writeFile(path, content, 'utf-8')
  return { frontmatter, body, source_path: path }
}

/**
 * List all gaps in the resolved dir. Filters by status when given.
 * Returns [] when the dir doesn't resolve (fresh install, no gaps
 * filed yet). Per-file parse errors are logged + skipped, NOT
 * propagated ... we never want a single malformed gap to make
 * `2200 catalog gap list` unusable.
 */
export async function listCatalogGaps(args: ListGapsArgs = {}): Promise<CatalogGapRecord[]> {
  const log: Logger = createLogger('catalog-gap')
  const dir = args.dir ?? resolveGapsDir()
  if (!dir) return []
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return []
  }
  const records: CatalogGapRecord[] = []
  for (const name of entries) {
    if (!name.endsWith('.md')) continue
    if (name === 'README.md') continue
    const path = join(dir, name)
    try {
      const text = await readFile(path, 'utf-8')
      const parsed = parseGapFile(text, path)
      if (args.status && parsed.frontmatter.status !== args.status) continue
      records.push(parsed)
    } catch (err) {
      log.warn('catalog-gap parse failed', {
        path,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  records.sort((a, b) => {
    if (a.frontmatter.recorded_at !== b.frontmatter.recorded_at) {
      return b.frontmatter.recorded_at.localeCompare(a.frontmatter.recorded_at)
    }
    return a.frontmatter.id.localeCompare(b.frontmatter.id)
  })
  return records
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/

function parseGapFile(text: string, source_path: string): CatalogGapRecord {
  const m = FRONTMATTER_RE.exec(text)
  if (!m) {
    throw new Error(`gap file ${source_path} is missing YAML frontmatter`)
  }
  const fmRaw = parseYaml(m[1] ?? '') as unknown
  const frontmatter = CatalogGapFrontmatterSchema.parse(fmRaw)
  return { frontmatter, body: (m[2] ?? '').trim(), source_path }
}
