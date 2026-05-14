/**
 * Agent archive helpers.
 *
 * Doug's design call (2026-05-14): archive renames the agent's
 * directory tree to `<name>-archived-<YYYY-MM-DD>` so a future agent
 * can take the original name without colliding on disk. The frontmatter
 * gets an `archived` block (timestamp + optional reason) for UI display
 * but the rename is the source of truth.
 *
 * Per-agent state lives in many places (agents/, state/agents/,
 * state/brain/, state/budget/, state/credentials/, state/identities/,
 * state/telemetry/). We move them all so freeing the original name
 * frees it everywhere; otherwise a new agent of the original name
 * would inherit the archived agent's budget tally, telemetry, etc.
 */

import { rename, stat, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { existsSync } from 'node:fs'
import {
  agentBrainIndexPath,
  agentBudgetDir,
  agentCredentialsDir,
  agentIdentityDir,
  agentPaths,
  agentSchedulesDir,
  agentTelemetryDir,
} from '../storage/layout.js'

/**
 * Compute a non-colliding archive name. Default is
 * `<name>-archived-<YYYY-MM-DD>`. If that directory already exists
 * under `<home>/agents/`, suffix `-2`, `-3`, ... until free.
 */
export function pickArchiveName(home: string, name: string, today: string): string {
  const base = `${name}-archived-${today}`
  if (!existsSync(join(home, 'agents', base))) return base
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}-${String(n)}`
    if (!existsSync(join(home, 'agents', candidate))) return candidate
  }
  throw new Error(`could not pick a non-colliding archive name for ${name} on ${today}`)
}

/**
 * Per-agent on-disk subtrees. Listed once so archive + unarchive stay
 * in lockstep. Each entry is `(home, name) => absolute path`.
 */
const AGENT_TREE_RESOLVERS: ((home: string, name: string) => string)[] = [
  (home, name) => agentPaths(home, name).root,
  (home, name) => dirname(agentSchedulesDir(home, name)), // <home>/state/agents/<name>/
  (home, name) => agentTelemetryDir(home, name),
  (home, name) => agentCredentialsDir(home, name),
  (home, name) => agentBudgetDir(home, name),
  (home, name) => dirname(agentBrainIndexPath(home, name)), // <home>/state/brain/<name>/
  (home, name) => agentIdentityDir(home, name),
]

/**
 * Move every per-agent subtree from `from` to `to`. Subtrees that
 * don't exist (e.g. an agent that never ran a scheduled task has no
 * state/agents/ entry) are silently skipped. The destination's parent
 * directory is mkdir'd as needed so cross-tree moves work on first
 * archive.
 */
export async function renameAgentTrees(home: string, from: string, to: string): Promise<void> {
  for (const resolve of AGENT_TREE_RESOLVERS) {
    const src = resolve(home, from)
    const dst = resolve(home, to)
    if (src === dst) continue
    try {
      await stat(src)
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw err
    }
    await mkdir(dirname(dst), { recursive: true })
    await rename(src, dst)
  }
}

/**
 * Replace (or insert / remove) the top-level `archived:` block in the
 * Identity frontmatter, and rewrite `agent_name:` to match the new
 * archive name. `clear: true` removes the archived block (used by
 * unarchive) and resets `agent_name` to the supplied `agent_name`.
 */
export interface ApplyArchiveEditArgs {
  /** New value for the top-level `agent_name:` field. */
  agent_name: string
  /** Archive block contents. Pass `null` to remove the block. */
  archived: { at: string; reason?: string } | null
}

export function applyArchiveEdit(raw: string, args: ApplyArchiveEditArgs): string {
  const fmStart = raw.indexOf('---')
  if (fmStart === -1) {
    throw new Error('Identity has no frontmatter')
  }
  const fmEnd = raw.indexOf('\n---', fmStart + 3)
  if (fmEnd === -1) {
    throw new Error('Identity frontmatter is not closed')
  }
  const head = raw.slice(0, fmStart + 3)
  const fm = raw.slice(fmStart + 3, fmEnd + 1)
  const tail = raw.slice(fmEnd + 1)

  const lines = fm.split('\n')

  // Rewrite agent_name in place.
  let agentNameSeen = false
  for (let i = 0; i < lines.length; i++) {
    if (/^agent_name:\s*/.test(lines[i] ?? '')) {
      lines[i] = `agent_name: ${args.agent_name}`
      agentNameSeen = true
      break
    }
  }
  if (!agentNameSeen) {
    // Identity without an agent_name shouldn't happen for a registered
    // agent, but be tolerant: insert near the top.
    lines.splice(1, 0, `agent_name: ${args.agent_name}`)
  }

  // Strip any existing archived block (header + indented children).
  const stripped: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i] ?? ''
    if (/^archived:\s*$/.test(line)) {
      i++
      while (i < lines.length) {
        const child = lines[i] ?? ''
        if (child !== '' && !/^\s/.test(child)) break
        i++
      }
      continue
    }
    stripped.push(line)
    i++
  }

  // Insert a fresh block when archiving.
  if (args.archived) {
    const block: string[] = ['archived:', `  at: '${args.archived.at}'`]
    if (args.archived.reason !== undefined) {
      const escaped = args.archived.reason.replace(/'/g, "''")
      block.push(`  reason: '${escaped}'`)
    }
    // Insert right before the trailing blank line (if any) so the block
    // sits at the bottom of the frontmatter, near other rarely-edited
    // metadata. Falls back to appending if no trailing blank line.
    const insertAt =
      stripped.length > 0 && stripped[stripped.length - 1] === ''
        ? stripped.length - 1
        : stripped.length
    stripped.splice(insertAt, 0, ...block)
  }

  return head + stripped.join('\n') + tail
}

/**
 * UTC date in YYYY-MM-DD form. Pulled out so tests can stub it without
 * monkey-patching `Date`.
 */
export function todayUtc(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10)
}
