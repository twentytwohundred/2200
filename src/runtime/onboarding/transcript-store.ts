/**
 * Onboarding transcript persistence (Epic 14 Phase A: persistence + replay).
 *
 * Every successful `2200 build` saves the full interview transcript
 * to disk for two reasons:
 *
 *   1. **Audit.** Operators can read back why a given Agent was
 *      created the way it was. The continuity-from-onboarding brain
 *      note carries the LLM-produced summary; the transcript carries
 *      the raw Q&A that produced the summary. The summary is what
 *      the Agent reads on first run; the transcript is what the
 *      operator reads when they wonder how the Agent got its shape.
 *
 *   2. **Replay.** `2200 build --replay <path>` reads a saved
 *      transcript, skips the interview entirely, and feeds the
 *      transcript through the existing Identity / tool / schedule
 *      generators to reproduce the build. Used for testing
 *      onboarding-script changes against deterministic input and for
 *      reproducing a destroyed Agent without re-walking the
 *      conversation.
 *
 * Storage shape:
 *
 *   <home>/state/onboarding/transcripts/<agent_name>-<iso>.json
 *
 * One file per saved transcript. The filename carries the agent name
 * and ISO timestamp so multiple builds of the same agent are
 * distinguishable (the second build that replaces the first via
 * --force gets its own transcript file). Mode 0644; the transcript
 * does not contain secrets (the interview surfaces tool names and
 * placeholders, not credentials).
 */
import { mkdir, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { atomicWriteJson } from '../util/atomic-write.js'
import { onboardingTranscriptsDir } from '../storage/layout.js'
import { InterviewTranscriptSchema, type InterviewTranscript } from './types.js'

export const SAVED_TRANSCRIPT_SCHEMA_VERSION = 1 as const

export const SavedTranscriptSchema = z.object({
  schema_version: z.literal(SAVED_TRANSCRIPT_SCHEMA_VERSION),
  /** When the transcript was persisted to disk (post-build). */
  saved_at: z.string().min(1),
  /** Final agent name the build flow committed to. */
  agent_name: z.string().min(1),
  /**
   * The raw transcript object. Carries its own
   * `interview_schema_version` so the transcript format can evolve
   * independently of this saved-record envelope.
   */
  transcript: InterviewTranscriptSchema,
})
export type SavedTranscript = z.infer<typeof SavedTranscriptSchema>

export class TranscriptStoreError extends Error {
  constructor(
    public readonly path: string,
    message: string,
  ) {
    super(`Onboarding transcript at ${path}: ${message}`)
    this.name = 'TranscriptStoreError'
  }
}

/**
 * Filename-safe ISO: YYYY-MM-DDTHH-MM-SS.sssZ (colons → dashes). Keeps
 * sortable order and avoids OS-specific filename headaches without
 * needing a separate sort key.
 */
function fileSafeIso(d: Date): string {
  return d.toISOString().replace(/:/g, '-')
}

export interface SaveTranscriptArgs {
  home: string
  agentName: string
  transcript: InterviewTranscript
  /** Override (testing). Defaults to () => new Date(). */
  now?: () => Date
}

/**
 * Persist a transcript to the canonical location. Returns the
 * absolute path of the written file. Creates the parent directory
 * lazily.
 */
export async function saveTranscript(args: SaveTranscriptArgs): Promise<string> {
  const now = args.now ?? (() => new Date())
  const dir = onboardingTranscriptsDir(args.home)
  await mkdir(dir, { recursive: true })
  const ts = fileSafeIso(now())
  const path = join(dir, `${args.agentName}-${ts}.json`)
  const record: SavedTranscript = {
    schema_version: SAVED_TRANSCRIPT_SCHEMA_VERSION,
    saved_at: now().toISOString(),
    agent_name: args.agentName,
    transcript: args.transcript,
  }
  await atomicWriteJson(path, record)
  return path
}

/**
 * Read + validate a saved transcript. Throws TranscriptStoreError on
 * missing files, malformed JSON, or schema mismatch.
 */
export async function loadTranscript(path: string): Promise<SavedTranscript> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new TranscriptStoreError(path, 'file does not exist')
    }
    throw err
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new TranscriptStoreError(
      path,
      `invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  const result = SavedTranscriptSchema.safeParse(parsed)
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n')
    throw new TranscriptStoreError(path, `\n${issues}`)
  }
  return result.data
}

/**
 * List the canonical-location transcripts for an Agent (or all
 * Agents when `agentName` is omitted). Sorted oldest-first so the
 * most recent is at the end. Tolerates a missing directory.
 */
export async function listTranscripts(
  home: string,
  agentName?: string,
): Promise<{ path: string; agent_name: string; saved_at: string }[]> {
  const dir = onboardingTranscriptsDir(home)
  let names: string[]
  try {
    names = await readdir(dir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  const out: { path: string; agent_name: string; saved_at: string }[] = []
  for (const n of names) {
    if (!n.endsWith('.json')) continue
    const path = join(dir, n)
    try {
      const r = await loadTranscript(path)
      if (agentName && r.agent_name !== agentName) continue
      out.push({ path, agent_name: r.agent_name, saved_at: r.saved_at })
    } catch {
      // Skip malformed entries; the build flow is the authoritative
      // writer and the only realistic source of these files, so a
      // bad entry is a hand-edit case the lister doesn't need to
      // surface to callers.
    }
  }
  out.sort((a, b) => a.saved_at.localeCompare(b.saved_at))
  return out
}
