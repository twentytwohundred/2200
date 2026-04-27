/**
 * Per-pub Agent roster (Epic 3.6 PR K).
 *
 * The router (`router.ts`) needs each Agent's `display_name` and a
 * one-line `role_blurb` so it can decide who to wake. The display
 * name comes from the live pub-server room state; the role_blurb
 * doesn't... it lives in each Agent's local Identity file.
 *
 * Wake sources run inside an Agent process and don't have access to
 * other Agents' Identity files directly, so we materialise a small
 * sidecar `roster.json` per pub at agent-create time. Every Agent
 * created against a pub appends/upserts its own entry. At wake time,
 * the source reads the roster and joins it with the live room state
 * to build router input.
 *
 * Layout:
 *   <home>/state/openpub/<pub_name>/roster.json
 *
 *   {
 *     "schema_version": 1,
 *     "agents": [
 *       { "agent_id": "...", "agent_name": "hobby",
 *         "display_name": "hobby",
 *         "role_blurb": "primary build agent..." },
 *       ...
 *     ]
 *   }
 *
 * The file is small and we rewrite it whole on upsert. No locking;
 * `agent create` is one-at-a-time and the wake source only reads.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const ROSTER_SCHEMA_VERSION = 1

export interface RosterEntry {
  agent_id: string
  /** Local Agent name (`agent_name` in Identity); display_name may differ. */
  agent_name: string
  display_name: string
  /** One-line role from Identity.agent_role. Trimmed and bounded. */
  role_blurb: string
}

export interface RosterFile {
  schema_version: typeof ROSTER_SCHEMA_VERSION
  agents: RosterEntry[]
}

const MAX_ROLE_BLURB_LEN = 240

export function rosterPath(home: string, pubName: string): string {
  return join(home, 'state', 'openpub', pubName, 'roster.json')
}

/** Read the roster for a pub. Returns an empty roster if the file does not exist. */
export async function readRoster(home: string, pubName: string): Promise<RosterFile> {
  const path = rosterPath(home, pubName)
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { schema_version: ROSTER_SCHEMA_VERSION, agents: [] }
    }
    throw err
  }
  const parsed: unknown = JSON.parse(raw)
  if (!isRosterFile(parsed)) {
    throw new Error(`roster file at ${path} is malformed`)
  }
  return parsed
}

/**
 * Add or replace an Agent in the pub's roster. Identified by
 * `agent_id` (the pub-issued one). Idempotent.
 */
export async function upsertRosterEntry(
  home: string,
  pubName: string,
  entry: RosterEntry,
): Promise<RosterFile> {
  const trimmed: RosterEntry = {
    agent_id: entry.agent_id,
    agent_name: entry.agent_name,
    display_name: entry.display_name,
    role_blurb: entry.role_blurb.trim().slice(0, MAX_ROLE_BLURB_LEN),
  }
  const file = await readRoster(home, pubName)
  const idx = file.agents.findIndex((a) => a.agent_id === trimmed.agent_id)
  if (idx === -1) file.agents.push(trimmed)
  else file.agents[idx] = trimmed

  const path = rosterPath(home, pubName)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(file, null, 2)}\n`, 'utf8')
  return file
}

function isRosterFile(value: unknown): value is RosterFile {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  if (v['schema_version'] !== ROSTER_SCHEMA_VERSION) return false
  if (!Array.isArray(v['agents'])) return false
  for (const entry of v['agents']) {
    if (typeof entry !== 'object' || entry === null) return false
    const e = entry as Record<string, unknown>
    if (typeof e['agent_id'] !== 'string') return false
    if (typeof e['agent_name'] !== 'string') return false
    if (typeof e['display_name'] !== 'string') return false
    if (typeof e['role_blurb'] !== 'string') return false
  }
  return true
}
