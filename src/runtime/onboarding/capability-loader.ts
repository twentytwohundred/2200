/**
 * Capability catalog loader (Phase F §12 step 4).
 *
 * Reads markdown files from two directories:
 *   1. First-party bundled catalog (`<install>/wiki/catalog/capabilities/`
 *      or operator-overridden via launch options).
 *   2. Optional local per-operator overrides (default
 *      `~/.2200/catalog/capabilities/` per `2200_HOME`).
 *
 * Each file is YAML frontmatter + markdown body. Frontmatter is parsed
 * + validated against `CapabilityFrontmatterSchema` from
 * `./capability-schema.js`; body is the walkthrough prose the
 * walkthrough-runner (Phase F §8) renders inline into chat at first-
 * chat-open after Capability provisioning.
 *
 * Merge semantics: local entries override first-party by `id`. A WARN
 * logs the override so the operator can audit at any time. Order in
 * the returned array is deterministic ... sorted by id ascending.
 *
 * Per-file errors are individual: a single malformed entry surfaces as
 * a WARN and gets skipped, but other entries continue to load. The
 * loader returning an empty array on a missing dir (rather than
 * throwing) means a fresh install with no catalog still boots cleanly.
 */
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { ZodError } from 'zod'
import { CapabilityFrontmatterSchema, type CapabilityFrontmatter } from './capability-schema.js'
import type { Logger } from '../util/logger.js'
import { createLogger } from '../util/logger.js'

/**
 * A loaded Capability record. `frontmatter` is the validated metadata;
 * `body` is the walkthrough prose; `source_path` + `source_kind` carry
 * provenance so the operator UI can show which catalog an entry came
 * from.
 */
export interface CapabilityRecord {
  frontmatter: CapabilityFrontmatter
  body: string
  source_path: string
  source_kind: 'first-party' | 'local'
}

/**
 * Thrown when a specific Capability file cannot be parsed or validated.
 * The loader catches these per-file and surfaces them as WARN logs
 * (not as a process-fatal); the type exists so individual callers can
 * inspect the underlying issue when they need to.
 */
export class CapabilityLoadError extends Error {
  readonly source_path: string
  override readonly cause: unknown
  constructor(message: string, source_path: string, cause?: unknown) {
    super(message)
    this.name = 'CapabilityLoadError'
    this.source_path = source_path
    this.cause = cause
  }
}

export interface CapabilityLoaderOptions {
  /** Bundled first-party catalog directory. */
  firstPartyDir: string
  /** Optional per-operator overrides directory. */
  localDir?: string
  /** Inject for tests. */
  logger?: Logger
}

/**
 * Load all Capabilities from the configured catalog directories.
 *
 * - First-party entries loaded first.
 * - Local entries layered on top; same-id local entry overrides first-
 *   party and emits a WARN.
 * - Per-file errors logged + skipped (not fatal).
 * - Missing dirs treated as empty (not fatal).
 * - Return sorted by id ascending for stable picker ordering.
 */
export async function loadCapabilities(opts: CapabilityLoaderOptions): Promise<CapabilityRecord[]> {
  const log = opts.logger ?? createLogger('capability-loader')
  const firstParty = await loadDir(opts.firstPartyDir, 'first-party', log)
  const local = opts.localDir ? await loadDir(opts.localDir, 'local', log) : []

  const byId = new Map<string, CapabilityRecord>()
  for (const rec of firstParty) {
    byId.set(rec.frontmatter.id, rec)
  }
  for (const rec of local) {
    const existing = byId.get(rec.frontmatter.id)
    if (existing) {
      log.warn('local capability overrides first-party entry', {
        id: rec.frontmatter.id,
        first_party_path: existing.source_path,
        local_path: rec.source_path,
      })
    }
    byId.set(rec.frontmatter.id, rec)
  }

  return Array.from(byId.values()).sort((a, b) => a.frontmatter.id.localeCompare(b.frontmatter.id))
}

async function loadDir(
  dir: string,
  source_kind: 'first-party' | 'local',
  log: Logger,
): Promise<CapabilityRecord[]> {
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      log.info('capability catalog dir missing; treating as empty', { dir })
      return []
    }
    throw err
  }

  const mdFiles = entries.filter((f) => f.endsWith('.md')).sort()
  const records: CapabilityRecord[] = []
  for (const file of mdFiles) {
    const path = join(dir, file)
    try {
      const rec = await loadFile(path, source_kind)
      records.push(rec)
    } catch (err) {
      log.warn('skipping malformed capability entry', {
        path,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return records
}

async function loadFile(
  path: string,
  source_kind: 'first-party' | 'local',
): Promise<CapabilityRecord> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (err) {
    throw new CapabilityLoadError(`could not read "${path}": ${(err as Error).message}`, path, err)
  }

  // Frontmatter must be the first block, opening with `---\n` and
  // closing with `\n---\n`. Body is everything after the closing fence.
  const fmMatch = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text)
  if (!fmMatch) {
    throw new CapabilityLoadError(`"${path}" has no YAML frontmatter block`, path)
  }

  let parsed: unknown
  try {
    parsed = parseYaml(fmMatch[1] ?? '')
  } catch (err) {
    throw new CapabilityLoadError(
      `"${path}" frontmatter YAML parse failed: ${(err as Error).message}`,
      path,
      err,
    )
  }

  let frontmatter: CapabilityFrontmatter
  try {
    frontmatter = CapabilityFrontmatterSchema.parse(parsed)
  } catch (err) {
    if (err instanceof ZodError) {
      const issues = err.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ')
      throw new CapabilityLoadError(
        `"${path}" frontmatter schema validation failed: ${issues}`,
        path,
        err,
      )
    }
    throw err
  }

  return {
    frontmatter,
    body: fmMatch[2] ?? '',
    source_path: path,
    source_kind,
  }
}
