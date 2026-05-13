/**
 * Per-Agent pub-membership file (`<home>/agents/<name>/pubs.md`).
 *
 * Doug's design call (2026-05-13): pub membership is operational
 * state, not identity. Keep it in its own file the Agent consults at
 * boot rather than baking it into identity.md, so a "studio created"
 * flow can update one Agent without touching its core Identity.
 *
 * Format ... markdown with a YAML frontmatter block listing pub
 * names:
 *
 *     ---
 *     pubs:
 *       - studio
 *       - deploy
 *     ---
 *
 *     {prose body explaining what the file is}
 *
 * When the file is absent (or its frontmatter unparseable), callers
 * fall back to identity.md's `pub.member_of` so the seed-team
 * Agents that predate this file keep working unchanged.
 */

import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Parsed pubs.md document. `null` means the file is absent. */
export interface AgentPubsFile {
  pubs: string[]
}

/**
 * Read the Agent's pubs.md. Returns `null` if the file is absent;
 * throws on a frontmatter parse error so callers can surface it
 * instead of silently swallowing.
 */
export async function readAgentPubsFile(path: string): Promise<AgentPubsFile | null> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
  return parseAgentPubsFile(raw)
}

/**
 * Parse the markdown body. Frontmatter only ... `pubs` must be a
 * YAML list of plain strings. Anything else throws.
 */
export function parseAgentPubsFile(raw: string): AgentPubsFile {
  const fmStart = raw.indexOf('---')
  if (fmStart === -1) {
    throw new Error('pubs.md: missing frontmatter')
  }
  const fmEnd = raw.indexOf('\n---', fmStart + 3)
  if (fmEnd === -1) {
    throw new Error('pubs.md: frontmatter is not closed')
  }
  const fm = raw.slice(fmStart + 3, fmEnd + 1)
  const lines = fm.split('\n')
  const pubs: string[] = []
  let inPubsBlock = false
  for (const line of lines) {
    if (/^pubs:\s*$/.test(line)) {
      inPubsBlock = true
      continue
    }
    if (inPubsBlock) {
      const m = /^\s*-\s+(\S.*)$/.exec(line)
      if (m?.[1]) {
        pubs.push(m[1].trim().replace(/^['"]|['"]$/g, ''))
        continue
      }
      // any non-indented, non-empty line ends the block
      if (line.trim().length > 0 && !/^\s/.test(line)) {
        inPubsBlock = false
      }
    }
  }
  return { pubs }
}

/**
 * Atomically write `pubs.md` with the given list of pub names.
 * `agentName` is embedded in the body for operator legibility.
 */
export async function writeAgentPubsFile(
  path: string,
  agentName: string,
  pubs: readonly string[],
): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const body = renderAgentPubsFile(agentName, pubs)
  const tmp = `${path}.tmp`
  try {
    await writeFile(tmp, body, 'utf8')
    await rename(tmp, path)
  } catch (err) {
    try {
      await rm(tmp, { force: true })
    } catch {
      /* ignore */
    }
    throw err
  }
}

/**
 * Add `pubName` to an Agent's pubs.md (creating the file if absent).
 * No-op if the pub is already listed. Returns the resulting list.
 *
 * `seedIfMissing` is the Agent's *current effective* membership list
 * (resolved from identity.md fallback / running-pubs default). When
 * pubs.md does not yet exist we seed it with that set so the explicit
 * file doesn't accidentally drop a pub the Agent was already
 * implicitly attached to.
 */
export async function addPubToAgentFile(
  path: string,
  agentName: string,
  pubName: string,
  options: { seedIfMissing?: readonly string[] } = {},
): Promise<string[]> {
  const existing = await readAgentPubsFile(path)
  let base: string[]
  if (existing === null) {
    base = [...(options.seedIfMissing ?? [])]
  } else {
    base = [...existing.pubs]
  }
  const next = base.includes(pubName) ? base : [...base, pubName]
  await writeAgentPubsFile(path, agentName, next)
  return next
}

/**
 * Remove `pubName` from an Agent's pubs.md. No-op if the file is
 * absent or the pub isn't listed. Returns the resulting list (or
 * `null` if the file was absent).
 */
export async function removePubFromAgentFile(
  path: string,
  agentName: string,
  pubName: string,
): Promise<string[] | null> {
  const existing = await readAgentPubsFile(path)
  if (existing === null) return null
  if (!existing.pubs.includes(pubName)) return existing.pubs
  const next = existing.pubs.filter((p) => p !== pubName)
  await writeAgentPubsFile(path, agentName, next)
  return next
}

function renderAgentPubsFile(agentName: string, pubs: readonly string[]): string {
  const list = pubs.length > 0 ? pubs.map((p) => `  - ${p}`).join('\n') : '  []'
  const fmBlock = pubs.length > 0 ? `---\npubs:\n${list}\n---\n` : `---\npubs: ${list}\n---\n`
  const prose = `
Active pub memberships for **${agentName}**.

This Agent attaches a wake source to each pub listed above on boot.
Edit the list (or use the web app's "+ New Studio" flow) to change
membership; the Agent must restart to pick up changes.

When this file is absent the runtime falls back to identity.md's
\`pub.member_of\` block.
`
  return fmBlock + prose
}
