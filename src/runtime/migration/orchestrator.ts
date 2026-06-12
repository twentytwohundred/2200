/**
 * Migration orchestrator (Epic 5 Phase A PR C).
 *
 * Wires the pieces shipped in PRs A and B into a single function that
 * takes a parsed handoff document and produces a fully-provisioned
 * Agent inside 2200:
 *
 *   1. Validate the Agent does not already exist (or take over with
 *      `force: true`).
 *   2. Build the Identity (PR B) and write it to disk.
 *   3. Register the Agent with the supervisor (calls Supervisor.createAgent
 *      directly; the CLI wrapper in PR D handles the daemon-vs-direct
 *      shape).
 *   4. Optionally provision the SCUT identity (gated by
 *      `provisionIdentity: true`; calls the same runner that
 *      `agent create` uses today).
 *   5. Bulk-import the brain source dir (Epic 8 importFromDir) if the
 *      handoff names one.
 *   6. Write each inline note to the brain.
 *   7. Write the handoff body as a brain note titled
 *      `continuity-from-migration` so the Agent's first context is a
 *      written explanation of where it came from.
 *   8. Emit a Passive notification summarizing what landed.
 *   9. Return a MigrateResult with the agent_name, identity path, SCUT
 *      URI (if provisioned), counts, and notification id.
 *
 * Phase A intentionally does not implement checkpoint/resume. The
 * orchestrator is mostly idempotent (Identity write is overwrite,
 * brain import is upsert-on-slug, provisioning is idempotent at the
 * OpenSCUT side once registered). The only step that fails loud on
 * re-run is `Supervisor.createAgent` ("Agent already exists"); the
 * caller resolves that with `force: true` (which deletes first) or by
 * picking a different name. A later PR adds a state-file-backed
 * resume path if the operator workflow ever needs it.
 */
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { homedir } from 'node:os'
import type { Supervisor } from '../supervisor/supervisor.js'
import { writeIdentity } from '../identity/loader.js'
import { runIdentityProvisionFromConfig } from '../identity/provision-runner.js'
import { BrainStore } from '../brain/store.js'
import { BrainIndex } from '../brain/index-db.js'
import { importFromDir, type ImportResult } from '../brain/import.js'
import { emitNotification } from '../notifications/writer.js'
import { buildIdentityFromHandoff } from './identity-from-handoff.js'
import { CONTINUITY_NOTE_SLUG, type HandoffDocument, type HandoffSchedule } from './types.js'
import { createSchedule, type ScheduleTiming } from '../scheduler/schedule.js'
import { TaskStore } from '../agent/task/store.js'
import { newPendingTask } from '../agent/task/types.js'
import { newTaskId } from '../util/id.js'
import { buildOrientationTaskBody } from '../onboarding/starter-pack.js'
import {
  loadCapabilities,
  resolveCatalogDir,
  type CapabilityRecord,
} from '../onboarding/capability-loader.js'
import {
  computeWalkthroughPlan,
  renderWalkthroughIntro,
  renderCapabilityWalkthrough,
} from '../onboarding/walkthrough-runner.js'

export interface MigrateArgs {
  handoff: HandoffDocument
  home: string
  /**
   * Supervisor instance. The orchestrator calls supervisor.createAgent
   * directly. The CLI wrapper (PR D) instantiates a Supervisor (no-
   * daemon path) or talks to a running daemon via RPC.
   */
  supervisor: Supervisor
  /**
   * Today's date. Injected so tests are deterministic; production
   * callers pass `new Date()`.
   */
  today: Date
  /**
   * When true, run the SCUT identity provisioning pipeline after
   * Agent registration. Subject to OpenSCUT's per-displayName-per-day
   * rate limit. Defaults false; the caller (CLI flag, test) opts in.
   */
  provisionIdentity?: boolean
  /**
   * When true, replace any existing Agent of the same name. The
   * orchestrator deletes the prior agent's directory under
   * `<home>/agents/<name>/` and removes any in-memory registration
   * before re-creating. Destructive; the CLI surface gates this
   * behind an explicit --force flag.
   */
  force?: boolean
  /**
   * When true, seed an orientation task on the new Agent so its
   * first wake reads the shared brain (platform overview, team
   * roster), reads its own continuity note, and chat.send's a brief
   * back to the operator. The onboarding flow opts in; the
   * `agent migrate` flow does not (migrating Agents bring their
   * own continuity).
   */
  seedFirstTask?: boolean
  /**
   * How to address the operator in the orientation task body.
   * Defaults to "the operator". Onboarding can pass a name or
   * "@handle" if it captured the operator's preferred addressing.
   */
  operatorAddressing?: string
}

export interface MigrateResult {
  agent_name: string
  /** Path to the source Identity file the orchestrator wrote. */
  identity_path: string
  /** Resolved SCUT URI, or null when provisioning was skipped or failed. */
  scut_uri: string | null
  /** Number of brain notes successfully imported (dir + inline). */
  brain_imported_count: number
  /** Number of source files the brain importer skipped. */
  brain_skipped_count: number
  /** Slug of the continuity-from-migration brain note. Always present. */
  continuity_note_slug: string
  /** Id of the summary notification that the orchestrator emitted. */
  notification_id: string
  /** Number of handoff schedules successfully created. */
  schedules_imported_count: number
  /** Per-entry schedule import failures ("<expr>: <reason>"). Non-fatal. */
  schedule_errors: string[]
}

/**
 * Run a migration. Returns a MigrateResult on success; throws on any
 * step that cannot proceed.
 *
 * Identity provisioning failure is intentionally non-fatal when
 * `provisionIdentity: true`: the Agent is still registered, the brain
 * is still imported, and the orchestrator surfaces the SCUT failure
 * via the summary notification + a `null` scut_uri in the result. The
 * operator recovers with `2200 agent identity retry <name>`.
 */
export async function migrateFromHandoff(args: MigrateArgs): Promise<MigrateResult> {
  const fm = args.handoff.frontmatter
  const agentName = fm.agent_name

  // Optional take-over: clean state for a previously-created Agent of
  // the same name. Supervisor.removeAgent stops the running process
  // (if any), clears the in-memory record, persists the state change,
  // and deletes the per-Agent directory tree.
  if (args.force === true) {
    await args.supervisor.removeAgent(agentName)
  }

  // Build + write the Identity.
  const built = buildIdentityFromHandoff({
    handoff: args.handoff,
    home: args.home,
    today: args.today,
  })
  await mkdir(dirname(built.source_path), { recursive: true })
  await writeIdentity(built.source_path, built.frontmatter, built.body)

  // Register the Agent with the supervisor. This validates the
  // Identity at the source path, copies it into the canonical
  // <home>/agents/<name>/ tree, and records the registration. If the
  // Identity has a pub: block (the migration handoff doesn't write
  // one in v1), the supervisor handles pub identity provisioning
  // here too.
  await args.supervisor.createAgent(agentName, built.source_path)

  // Optional SCUT identity provisioning. Failure is surfaced via the
  // summary notification but does not abort the rest of the migration.
  let scutUri: string | null = null
  let scutError: string | null = null
  if (args.provisionIdentity === true) {
    try {
      const result = await runIdentityProvisionFromConfig({
        home: args.home,
        agentName,
      })
      scutUri = result.uri
    } catch (err) {
      scutError = err instanceof Error ? err.message : String(err)
    }
  }

  // Brain import: bulk-import from a source dir if the handoff names
  // one, then write any inline notes. Both pass through BrainStore so
  // the SQLite FTS5 index is updated alongside the markdown files.
  let importedCount = 0
  let skippedCount = 0
  if (fm.brain.source_dir !== undefined) {
    const sourceDir = expandHomeTilde(fm.brain.source_dir)
    const result: ImportResult = await importFromDir({
      home: args.home,
      agentName,
      sourceDir,
    })
    importedCount += result.imported.length
    skippedCount += result.skipped.length
  }
  if (fm.brain.inline_notes !== undefined) {
    const store = new BrainStore(args.home, agentName)
    const index = BrainIndex.open(args.home, agentName)
    try {
      for (const note of fm.brain.inline_notes) {
        const writeArgs: Parameters<typeof store.write>[0] = {
          title: note.title,
          body: note.body,
          ...(note.slug !== undefined ? { slug: note.slug } : {}),
          ...(note.type !== undefined ? { type: note.type } : {}),
          ...(note.tags !== undefined ? { tags: note.tags } : {}),
        }
        const w = await store.write(writeArgs)
        const fullNote = await store.read(w.slug)
        index.upsert(fullNote)
        importedCount += 1
      }
    } finally {
      index.close()
    }
  }

  // Write the continuity-from-migration brain note. Slug is locked
  // via CONTINUITY_NOTE_SLUG so resume + future inspection can find
  // it deterministically. The handoff body becomes the note body
  // verbatim; provenance fields land in the note's frontmatter for
  // round-trip traceability.
  const continuityStore = new BrainStore(args.home, agentName)
  const continuityIndex = BrainIndex.open(args.home, agentName)
  try {
    const w = await continuityStore.write({
      title: 'Continuity from migration',
      slug: CONTINUITY_NOTE_SLUG,
      type: 'continuity',
      tags: ['migration', fm.agent_type],
      body: args.handoff.body,
      extras: {
        source_handoff_path: args.handoff.source_path,
        provenance_source_system: fm.provenance.source_system,
        provenance_source_host: fm.provenance.source_host,
        provenance_exported_at: fm.provenance.exported_at,
      },
    })
    const fullNote = await continuityStore.read(w.slug)
    continuityIndex.upsert(fullNote)
  } finally {
    continuityIndex.close()
  }

  // Schedule import (Phase B). Per-entry failures are non-fatal,
  // matching the SCUT posture: the Agent still lands with brain +
  // continuity; the operator fixes a bad expression with
  // `2200 schedule add` guided by the notification detail.
  let schedulesImported = 0
  const scheduleErrors: string[] = []
  for (const entry of fm.schedules) {
    try {
      await createSchedule({
        home: args.home,
        agentName,
        description: 'imported by migration',
        prompt: entry.task,
        timing: timingFromHandoffSchedule(entry),
        ...(entry.id !== undefined ? { id: entry.id } : {}),
      })
      schedulesImported += 1
    } catch (err) {
      scheduleErrors.push(`${entry.expr}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // Summary notification. Always Passive (the migration is itself a
  // calm event; it does not need to interrupt). Content describes what
  // landed plus, when applicable, the SCUT failure detail.
  const summary = renderSummary({
    agentName,
    importedCount,
    skippedCount,
    scutUri,
    scutError,
    provisionAttempted: args.provisionIdentity === true,
    schedulesImported,
    scheduleErrors,
  })
  const note = await emitNotification({
    home: args.home,
    agentName,
    tier: 'passive',
    kind: 'agent.migrated',
    body: summary,
    extras: {
      imported_count: importedCount,
      skipped_count: skippedCount,
      ...(scutUri !== null ? { scut_uri: scutUri } : {}),
      ...(scutError !== null ? { scut_error: scutError } : {}),
    },
  })

  // Seed the orientation task if the caller opted in (onboarding
  // path). The task tells the new Agent to read the shared brain
  // and chat.send a brief back; it lands in pending state so the
  // first time the operator runs `2200 agent start <name>` (or the
  // supervisor auto-starts), the wake immediately picks it up.
  if (args.seedFirstTask === true) {
    try {
      const role = built.frontmatter.agent_role
      const taskStore = new TaskStore(args.home, agentName)
      // Pre-render the walkthrough script if the Agent has
      // capabilities[] declared in Identity AND we can find the
      // catalog. Skip gracefully on either missing.
      const walkthroughRender = await renderWalkthroughForOrientation({
        agentName,
        capabilityIds: built.frontmatter.capabilities,
      })
      const taskBody = buildOrientationTaskBody({
        agentName,
        agentRole: role,
        operatorAddressing: args.operatorAddressing ?? 'the operator',
        ...(walkthroughRender ? { walkthroughRender } : {}),
      })
      const orientationTask = newPendingTask({
        id: newTaskId(),
        agent: agentName,
        title: 'Orientation: read the shared brain and brief the operator',
        body: taskBody,
        priority: 0,
        // Orientation includes brain.write_shared (note-taking) and
        // chat.send (delivering the brief), both of which fall under
        // checkpointed/destructive. Mark the task destructive so the
        // perm matrix doesn't block any baseline tool the Agent
        // legitimately needs to complete it.
        idempotency: 'destructive',
      })
      await taskStore.save(orientationTask)
    } catch (err) {
      // Non-fatal: the Agent exists; the operator can submit a task
      // by hand if the seed failed.
      // (We don't have a logger handle here; emit through the
      // notification path instead.)
      await emitNotification({
        home: args.home,
        agentName,
        tier: 'passive',
        kind: 'agent.orientation_task_seed_failed',
        body: `# Orientation task seed failed\n\nThe orchestrator created \`${agentName}\` but could not seed its first orientation task: ${err instanceof Error ? err.message : String(err)}\n\nYou can submit it manually with \`2200 task submit ${agentName} ...\` or just talk to the Agent directly via the web UI.`,
      })
    }
  }

  return {
    agent_name: agentName,
    identity_path: built.source_path,
    scut_uri: scutUri,
    brain_imported_count: importedCount,
    brain_skipped_count: skippedCount,
    continuity_note_slug: CONTINUITY_NOTE_SLUG,
    notification_id: note.id,
    schedules_imported_count: schedulesImported,
    schedule_errors: scheduleErrors,
  }
}

/**
 * Map a handoff schedule entry to the scheduler's timing union.
 * `expr` of the form `"<N>s"` is an interval; anything else is a
 * 5-field cron expression validated by `createSchedule` itself.
 */
function timingFromHandoffSchedule(entry: HandoffSchedule): ScheduleTiming {
  const intervalMatch = /^(\d+)s$/.exec(entry.expr.trim())
  if (intervalMatch) {
    return { kind: 'interval', interval_seconds: Number(intervalMatch[1]) }
  }
  return { kind: 'cron', expression: entry.expr, timezone: entry.tz ?? 'UTC' }
}

interface SummaryArgs {
  agentName: string
  importedCount: number
  skippedCount: number
  scutUri: string | null
  scutError: string | null
  provisionAttempted: boolean
  schedulesImported: number
  scheduleErrors: string[]
}

function renderSummary(args: SummaryArgs): string {
  const lines: string[] = [
    `# Agent migrated: ${args.agentName}`,
    '',
    `- Brain notes imported: **${String(args.importedCount)}**`,
  ]
  if (args.skippedCount > 0) {
    lines.push(`- Brain notes skipped: ${String(args.skippedCount)} (see import logs)`)
  }
  if (args.schedulesImported > 0) {
    lines.push(`- Schedules imported: **${String(args.schedulesImported)}**`)
  }
  for (const e of args.scheduleErrors) {
    lines.push(`- Schedule import failed: ${e} ... re-add with \`2200 schedule add\`.`)
  }
  if (args.provisionAttempted) {
    if (args.scutUri !== null) {
      lines.push(`- SCUT identity: \`${args.scutUri}\``)
    } else if (args.scutError !== null) {
      lines.push(
        `- SCUT identity: provisioning failed (${args.scutError}). Recover with \`2200 agent identity retry ${args.agentName}\`.`,
      )
    }
  } else {
    lines.push(
      '- SCUT identity: provisioning skipped (run `2200 agent identity provision` to mint).',
    )
  }
  lines.push(
    '',
    `Continuity note: \`${CONTINUITY_NOTE_SLUG}\` (read it via \`2200 brain show ${args.agentName} ${CONTINUITY_NOTE_SLUG}\`).`,
  )
  return lines.join('\n')
}

/**
 * Expand a leading `~/` in a path string to the operator's home dir.
 * Anything else is returned unchanged. The handoff parser leaves
 * `~`-prefixed paths intact so the orchestrator (which has the
 * ambient OS context) is the single point of expansion.
 */
function expandHomeTilde(path: string): string {
  if (path.startsWith('~/')) {
    return `${homedir()}/${path.slice(2)}`
  }
  if (path === '~') {
    return homedir()
  }
  return path
}

/**
 * Compose the pre-rendered walkthrough script for the orientation
 * task body. Loads the catalog, looks up each declared capability
 * id, renders an introduction paragraph plus one section per
 * Capability (separated by `---`).
 *
 * At build time the vault is empty (no credentials sealed yet), so
 * the "compute" step is degenerate: every declared Capability needs
 * a walkthrough. We synthesize the plan directly from the catalog
 * lookups instead of round-tripping through `computeWalkthroughPlan`
 * with a stub vault; the result is the same shape.
 *
 * Returns `null` when:
 *   - The Agent has no declared capabilities (nothing to walk).
 *   - The catalog dir cannot be resolved.
 *   - Zero of the declared capability ids resolve to catalog entries.
 *
 * Returns the rendered string when at least one Capability resolves.
 * Unknown ids are dropped silently (the Agent's task body would have
 * nothing useful to show for them).
 */
async function renderWalkthroughForOrientation(args: {
  agentName: string
  capabilityIds: string[]
}): Promise<string | null> {
  if (args.capabilityIds.length === 0) return null
  const dir = resolveCatalogDir()
  if (!dir) return null

  let catalog: CapabilityRecord[]
  try {
    catalog = await loadCapabilities({ firstPartyDir: dir })
  } catch {
    return null
  }
  if (catalog.length === 0) return null

  // At build time, the vault is empty. Synthesize an "always unsealed"
  // checker so every declared Capability lands in needs_walkthrough.
  const plan = await computeWalkthroughPlan({
    agentName: args.agentName,
    capabilityIds: args.capabilityIds,
    catalog,
    vault: { has: () => Promise.resolve(false) },
  })

  if (plan.needs_walkthrough.length === 0) return null

  const intro = renderWalkthroughIntro(plan)
  const slots = plan.needs_walkthrough
    .map((s) => renderCapabilityWalkthrough(s))
    .join('\n\n---\n\n')
  return `${intro}\n\n---\n\n${slots}`
}
