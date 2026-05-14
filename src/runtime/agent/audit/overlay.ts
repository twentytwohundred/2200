/**
 * Per-Identity audit tool-class overlay.
 *
 * When a skill is installed it can declare a `tool_classes` map in
 * its frontmatter mapping each tool name to an audit class
 * (file_create / file_read / external_send / tool_invoke /
 * process_count). The runtime merges these declarations into the
 * verifier's class lookups via this overlay, per-Agent, without
 * mutating the locked `*_CLASS_TOOLS` constants in `verifiers.ts`.
 *
 * On-disk shape (single JSON file per Agent):
 *
 *   <home>/state/identities/<agent>/identity-audit-overlay.json
 *
 *   {
 *     "schema_version": 1,
 *     "entries": [
 *       { "tool": "openpub.check_in", "class": "external_send",
 *         "skill": "openpub", "installed_at": "2026-05-14T..." },
 *       ...
 *     ]
 *   }
 *
 * The entry-list shape lets uninstall scrub per-skill contributions
 * without disturbing entries contributed by other skills. The runtime
 * collapses entries into a `Record<tool, class>` at load time; later
 * contributions for the same tool win over earlier ones (last-write).
 */
import { mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { agentIdentityDir } from '../../storage/layout.js'
import { atomicWriteFile } from '../../util/atomic-write.js'
import { TOOL_CLASS_VALUES, type ToolClass } from '../../skills/analyze.js'

const OVERLAY_SCHEMA_VERSION = 1 as const

const OverlayEntrySchema = z.object({
  tool: z.string().min(1),
  class: z.enum(TOOL_CLASS_VALUES),
  skill: z.string().min(1),
  installed_at: z.string().min(1),
})
export type AuditOverlayEntry = z.infer<typeof OverlayEntrySchema>

const OverlayFileSchema = z.object({
  schema_version: z.literal(OVERLAY_SCHEMA_VERSION),
  entries: z.array(OverlayEntrySchema).default([]),
})

function overlayPath(home: string, agentName: string): string {
  return join(agentIdentityDir(home, agentName), 'identity-audit-overlay.json')
}

/**
 * Read the overlay file. Returns the parsed entries on success and
 * an empty list when the file does not exist. Malformed files surface
 * as a thrown error so the operator notices, since silent fallthrough
 * could mask a corrupted audit substrate.
 */
export async function readOverlayEntries(
  home: string,
  agentName: string,
): Promise<AuditOverlayEntry[]> {
  const path = overlayPath(home, agentName)
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  const parsed: unknown = JSON.parse(raw)
  return OverlayFileSchema.parse(parsed).entries
}

/**
 * Read the overlay and collapse entries into a tool→class lookup. The
 * hot path for the audit pass; one read per audit-per-agent.
 */
export async function loadAuditOverlay(
  home: string,
  agentName: string,
): Promise<Record<string, ToolClass>> {
  const entries = await readOverlayEntries(home, agentName)
  const map: Record<string, ToolClass> = {}
  for (const entry of entries) {
    map[entry.tool] = entry.class
  }
  return map
}

async function writeOverlayEntries(
  home: string,
  agentName: string,
  entries: AuditOverlayEntry[],
): Promise<void> {
  const path = overlayPath(home, agentName)
  await mkdir(agentIdentityDir(home, agentName), { recursive: true })
  if (entries.length === 0) {
    try {
      await rm(path, { force: true })
    } catch {
      // best-effort cleanup
    }
    return
  }
  const payload = OverlayFileSchema.parse({ schema_version: OVERLAY_SCHEMA_VERSION, entries })
  await atomicWriteFile(path, JSON.stringify(payload, null, 2))
}

export interface AddOverlayEntriesArgs {
  home: string
  agentName: string
  skillSlug: string
  /** Map of tool name → class. */
  toolClasses: Record<string, ToolClass>
}

/**
 * Merge a skill's tool_classes into the per-Agent overlay. Any
 * existing entries for the same skill are replaced (so reinstall
 * cleanly updates). Entries from OTHER skills are preserved.
 */
export async function addOverlayEntries(args: AddOverlayEntriesArgs): Promise<void> {
  const installedAt = new Date().toISOString()
  const existing = await readOverlayEntries(args.home, args.agentName)
  const kept = existing.filter((e) => e.skill !== args.skillSlug)
  const additions: AuditOverlayEntry[] = Object.entries(args.toolClasses).map(([tool, klass]) => ({
    tool,
    class: klass,
    skill: args.skillSlug,
    installed_at: installedAt,
  }))
  await writeOverlayEntries(args.home, args.agentName, [...kept, ...additions])
}

export interface RemoveOverlayEntriesArgs {
  home: string
  agentName: string
  skillSlug: string
}

/**
 * Remove every overlay entry contributed by the named skill. Other
 * skills' entries are preserved.
 */
export async function removeOverlayEntries(args: RemoveOverlayEntriesArgs): Promise<void> {
  const existing = await readOverlayEntries(args.home, args.agentName)
  const kept = existing.filter((e) => e.skill !== args.skillSlug)
  if (kept.length === existing.length) return
  await writeOverlayEntries(args.home, args.agentName, kept)
}
