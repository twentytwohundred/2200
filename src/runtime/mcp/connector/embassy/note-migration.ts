/**
 * One-time migration of pre-embassy connector notes (Phase 2 / PR-B3).
 *
 * Per the locked 2026-05-26 decision, when the first conduit is
 * registered the existing ownerless notes that the connector tools
 * wrote in Phase 1 get claimed by the new embassy. This module is
 * the migration engine; it runs from `Supervisor.registerEmbassy`
 * exactly once per home (a sentinel file marks completion).
 *
 * What gets migrated:
 *   - `<shared>/brain/research-<slug>.md` (research threads) and the
 *     paired `research-<slug>-brief.md` (standing briefs from PR 3).
 *     Both move into the embassy's brain with a `relationship-history`
 *     tag added (briefs additionally retain `standing-brief`).
 *   - Per-Agent contributions tagged `grok-contribution` in every
 *     Agent's brain. Each moves into the embassy's brain; the
 *     original target Agent is recorded as `target_agent` extras.
 *
 * Mechanics:
 *   - Each note is COPIED into the embassy's brain via BrainStore.write
 *     (preserving all extras + tags, adding `relationship-history`).
 *   - The original is then DELETED.
 *   - Crash-safe: if migration fails partway, the sentinel is not
 *     written; re-running picks up where it left off (idempotent
 *     because the destination is overwritten and the source delete
 *     fails harmlessly when re-run).
 *
 * Idempotency sentinel:
 *   `<home>/state/connector/note-migration-complete.json`
 *
 * Operator can force a re-run by deleting the sentinel. Useful if
 * the migration ran with the wrong embassy and the operator needs
 * to retire + re-register before retrying.
 */
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { BrainStore } from '../../../brain/store.js'
import { homePaths, agentPaths } from '../../../storage/layout.js'

const SENTINEL_FILENAME = 'note-migration-complete.json'

function sentinelPath(home: string): string {
  return join(homePaths(home).state, 'connector', SENTINEL_FILENAME)
}

export interface MigrationSummary {
  migrated_threads: number
  migrated_briefs: number
  migrated_agent_contributions: number
  skipped_already_complete: boolean
}

export async function isMigrationComplete(home: string): Promise<boolean> {
  try {
    await readFile(sentinelPath(home))
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw err
  }
}

async function writeSentinel(home: string, summary: MigrationSummary): Promise<void> {
  const path = sentinelPath(home)
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(
    path,
    JSON.stringify({ completed_at: new Date().toISOString(), ...summary }, null, 2),
  )
}

/**
 * Run the one-time migration. Idempotent: if the sentinel exists,
 * returns a `skipped_already_complete: true` summary without
 * touching disk. Otherwise migrates everything, writes the
 * sentinel, returns counts.
 */
export async function migrateOwnerlessNotesToEmbassy(
  home: string,
  embassyAgent: string,
): Promise<MigrationSummary> {
  if (await isMigrationComplete(home)) {
    return {
      migrated_threads: 0,
      migrated_briefs: 0,
      migrated_agent_contributions: 0,
      skipped_already_complete: true,
    }
  }
  const summary: MigrationSummary = {
    migrated_threads: 0,
    migrated_briefs: 0,
    migrated_agent_contributions: 0,
    skipped_already_complete: false,
  }
  const sharedStore = BrainStore.forShared(home)
  const embassyStore = BrainStore.forAgent(home, embassyAgent)

  // Standing briefs (PR 3) carry BOTH `standing-brief` AND
  // `research-thread` tags, so we union the two queries by slug and
  // classify by whether `standing-brief` is present. Briefs increment
  // `migrated_briefs`; everything else increments `migrated_threads`.
  const threadsRaw = await sharedStore.list({ tag: 'research-thread' })
  const briefsRaw = await sharedStore.list({ tag: 'standing-brief' })
  const bySlug = new Map<string, (typeof threadsRaw)[number]>()
  for (const n of threadsRaw) bySlug.set(n.slug, n)
  for (const n of briefsRaw) bySlug.set(n.slug, n)
  for (const note of bySlug.values()) {
    const isBrief = note.frontmatter.tags.includes('standing-brief')
    await embassyStore.write({
      slug: note.slug,
      title: note.frontmatter.title,
      body: note.body,
      type: note.frontmatter.type,
      tags: dedupe([...note.frontmatter.tags, 'relationship-history']),
      extras: {
        ...note.extras,
        migrated_from: 'shared/brain',
        migrated_at: new Date().toISOString(),
      },
    })
    await sharedStore.delete(note.slug).catch(() => undefined)
    if (isBrief) summary.migrated_briefs += 1
    else summary.migrated_threads += 1
  }

  // Migrate per-Agent grok-contributions from every Agent's brain.
  const { readdir } = await import('node:fs/promises')
  let agentNames: string[] = []
  try {
    agentNames = await readdir(join(home, 'agents'))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  for (const name of agentNames) {
    if (name === embassyAgent) continue // skip the embassy itself
    // Confirm this is actually an Agent dir (has identity.md).
    try {
      await readFile(agentPaths(home, name).identity)
    } catch {
      continue
    }
    const agentStore = BrainStore.forAgent(home, name)
    const contributions = await agentStore.list({ tag: 'grok-contribution' }).catch(() => [])
    for (const note of contributions) {
      await embassyStore.write({
        slug: note.slug,
        title: note.frontmatter.title,
        body: note.body,
        type: note.frontmatter.type,
        tags: dedupe([...note.frontmatter.tags, 'relationship-history']),
        extras: {
          ...note.extras,
          target_agent: name,
          migrated_from: `agents/${name}/brain`,
          migrated_at: new Date().toISOString(),
        },
      })
      await agentStore.delete(note.slug).catch(() => undefined)
      summary.migrated_agent_contributions += 1
    }
  }

  await writeSentinel(home, summary)
  return summary
}

function dedupe(arr: string[]): string[] {
  return Array.from(new Set(arr))
}

/** Test / operator helper: remove the sentinel so the migration runs again. */
export async function clearMigrationSentinel(home: string): Promise<void> {
  try {
    await unlink(sentinelPath(home))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
}
