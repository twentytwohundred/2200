/**
 * Tests for the migration orchestrator (Epic 5 Phase A PR C).
 *
 * Real Supervisor + real BrainStore + real notification writer + real
 * filesystem. SCUT identity provisioning is gated off (the real
 * provisioner makes HTTPS calls to register.openscut.ai which we do
 * not exercise here); the `provisionIdentity: false` path is the
 * happy path under test, and a separate test asserts the fall-back
 * behavior when provisioning is requested but not configured to
 * succeed.
 *
 * The fixtures cover:
 *   - source brain dir with one Hobby-style memory file (the
 *     migration's canonical input shape)
 *   - inline notes inside the handoff itself
 *   - the continuity-from-migration body landing as a brain note
 *     verbatim
 *   - the summary notification carrying expected extras
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Supervisor } from '../../../src/runtime/supervisor/supervisor.js'
import { migrateFromHandoff } from '../../../src/runtime/migration/orchestrator.js'
import { parseHandoffString } from '../../../src/runtime/migration/parser.js'
import { CONTINUITY_NOTE_SLUG } from '../../../src/runtime/migration/types.js'
import { BrainStore } from '../../../src/runtime/brain/store.js'
import { agentPaths, homePaths } from '../../../src/runtime/storage/layout.js'
import { listSchedules } from '../../../src/runtime/scheduler/schedule.js'

const FIXED_DATE = new Date('2026-04-29T12:00:00Z')

let home: string
let supervisor: Supervisor

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), '2200-migrate-'))
  supervisor = await Supervisor.create({ home })
})

afterEach(async () => {
  await supervisor.shutdown()
  await rm(home, { recursive: true, force: true })
})

function makeHandoff(opts: {
  agentName?: string
  brainSourceDir?: string | null
  inlineNotes?: { title: string; body: string; type?: string }[]
  body?: string
}) {
  const agentName = opts.agentName ?? 'hobby'
  const brainBlock =
    opts.brainSourceDir !== null && opts.brainSourceDir !== undefined
      ? `brain:\n  source_dir: ${opts.brainSourceDir}\n`
      : opts.inlineNotes !== undefined
        ? `brain:\n  inline_notes:\n${opts.inlineNotes
            .map(
              (n) =>
                `    - title: "${n.title}"\n      body: "${n.body}"${n.type !== undefined ? `\n      type: ${n.type}` : ''}`,
            )
            .join('\n')}\n`
        : ''
  const text = `---
handoff_schema_version: 1
agent_name: ${agentName}
agent_type: build_agent
identity:
  display_name: ${agentName}
${brainBlock}budget:
  daily_cap_usd: 50
provenance:
  source_system: claude_code
  source_host: doug-macbook-pro
---

${opts.body ?? `Continuity narrative for ${agentName}.\n\nWhat I was doing before this migration.`}
`
  return parseHandoffString(text, `/tmp/${agentName}.handoff.md`)
}

describe('migrateFromHandoff (Phase A happy path)', () => {
  it('migrates an Agent with a brain source dir', async () => {
    const sourceDir = await mkdtemp(join(tmpdir(), '2200-migrate-src-'))
    try {
      // Hobby-style feedback memory file
      await writeFile(
        join(sourceDir, 'feedback_decide_and_tell.md'),
        `---
name: Decide and tell in build phase
description: default to making implementation calls
type: feedback
---

Once we move into build, default to deciding and telling.
`,
      )

      const handoff = makeHandoff({ brainSourceDir: sourceDir })
      const result = await migrateFromHandoff({
        handoff,
        home,
        supervisor,
        today: FIXED_DATE,
        provisionIdentity: false,
      })

      expect(result.agent_name).toBe('hobby')
      expect(result.scut_uri).toBeNull()
      expect(result.brain_imported_count).toBe(1)
      expect(result.brain_skipped_count).toBe(0)
      expect(result.continuity_note_slug).toBe(CONTINUITY_NOTE_SLUG)
      expect(result.notification_id).toMatch(/^notif_/)

      // Identity file landed at the canonical path under <home>/agents/hobby/
      const canonicalIdentity = await readFile(agentPaths(home, 'hobby').identity, 'utf8')
      expect(canonicalIdentity).toContain('agent_name: hobby')

      // Imported brain note is on disk
      const brain = new BrainStore(home, 'hobby')
      const fb = await brain.read('feedback-decide-and-tell')
      expect(fb.frontmatter.type).toBe('feedback')

      // Continuity note carries the handoff body verbatim
      const continuity = await brain.read(CONTINUITY_NOTE_SLUG)
      expect(continuity.frontmatter.type).toBe('continuity')
      expect(continuity.frontmatter.tags).toContain('migration')
      expect(continuity.frontmatter.tags).toContain('build_agent')
      expect(continuity.body).toContain('Continuity narrative for hobby.')

      // Summary notification on disk with the right tier + kind
      const notifPath = join(homePaths(home).stateNotifications, `${result.notification_id}.md`)
      const notif = await readFile(notifPath, 'utf8')
      expect(notif).toContain('tier: passive')
      expect(notif).toContain('kind: agent.migrated')
      expect(notif).toContain('imported_count: 1')
    } finally {
      await rm(sourceDir, { recursive: true, force: true })
    }
  })

  it('migrates an Agent with inline notes (no source dir)', async () => {
    const handoff = makeHandoff({
      inlineNotes: [
        {
          title: 'First Inline Note',
          body: 'Body of the first inline note.',
          type: 'reference',
        },
        {
          title: 'Second Inline Note',
          body: 'Body of the second inline note.',
        },
      ],
    })
    const result = await migrateFromHandoff({
      handoff,
      home,
      supervisor,
      today: FIXED_DATE,
      provisionIdentity: false,
    })
    expect(result.brain_imported_count).toBe(2)

    const brain = new BrainStore(home, 'hobby')
    const first = await brain.read('first-inline-note')
    expect(first.frontmatter.type).toBe('reference')
    expect(first.body.trim()).toBe('Body of the first inline note.')
    const second = await brain.read('second-inline-note')
    expect(second.frontmatter.type).toBe('freeform')
  })

  it('preserves the handoff body verbatim in the continuity note', async () => {
    const customBody = `# Header\n\nSome content with **bold** and \`code\`.\n\nMultiple paragraphs.\n`
    const handoff = makeHandoff({ body: customBody })
    await migrateFromHandoff({
      handoff,
      home,
      supervisor,
      today: FIXED_DATE,
      provisionIdentity: false,
    })
    const brain = new BrainStore(home, 'hobby')
    const note = await brain.read(CONTINUITY_NOTE_SLUG)
    expect(note.body.trim()).toBe(customBody.trim())
  })

  it('rejects re-migrating an Agent that already exists', async () => {
    const handoff = makeHandoff({})
    await migrateFromHandoff({
      handoff,
      home,
      supervisor,
      today: FIXED_DATE,
      provisionIdentity: false,
    })
    await expect(
      migrateFromHandoff({
        handoff,
        home,
        supervisor,
        today: FIXED_DATE,
        provisionIdentity: false,
      }),
    ).rejects.toThrow(/Agent already exists/)
  })

  it('replaces the prior Agent with --force', async () => {
    const handoff = makeHandoff({})
    await migrateFromHandoff({
      handoff,
      home,
      supervisor,
      today: FIXED_DATE,
      provisionIdentity: false,
    })
    // Second migration with force succeeds
    const result = await migrateFromHandoff({
      handoff,
      home,
      supervisor,
      today: FIXED_DATE,
      provisionIdentity: false,
      force: true,
    })
    expect(result.agent_name).toBe('hobby')
  })

  it('records a non-fatal SCUT error when provisioning is requested but fails', async () => {
    // Point the register URL at an unresolvable host so the runner
    // surfaces a network error.
    const prev = process.env['OPENSCUT_REGISTER_URL']
    process.env['OPENSCUT_REGISTER_URL'] = 'http://127.0.0.1:1'
    try {
      const handoff = makeHandoff({})
      const result = await migrateFromHandoff({
        handoff,
        home,
        supervisor,
        today: FIXED_DATE,
        provisionIdentity: true,
      })
      // Migration completes, but SCUT URI is null and the summary
      // notification carries the failure body.
      expect(result.agent_name).toBe('hobby')
      expect(result.scut_uri).toBeNull()
      const notifPath = join(homePaths(home).stateNotifications, `${result.notification_id}.md`)
      const notif = await readFile(notifPath, 'utf8')
      expect(notif).toContain('provisioning failed')
    } finally {
      if (prev === undefined) {
        delete process.env['OPENSCUT_REGISTER_URL']
      } else {
        process.env['OPENSCUT_REGISTER_URL'] = prev
      }
    }
  })
})

describe('migrateFromHandoff (Phase B: schedules)', () => {
  it('imports cron + interval schedules; bad expressions are non-fatal and reported', async () => {
    const text = `---
handoff_schema_version: 1
agent_name: skedge
identity:
  display_name: skedge
budget:
  daily_cap_usd: 5
schedules:
  - expr: "0 7 * * *"
    tz: "America/Chicago"
    task: "morning brief"
  - expr: "300s"
    task: "heartbeat"
  - expr: "not a cron"
    task: "broken"
---
continuity
`
    const handoff = parseHandoffString(text, null)
    const result = await migrateFromHandoff({
      handoff,
      home,
      supervisor,
      today: FIXED_DATE,
      provisionIdentity: false,
    })
    // The Agent must land with its working schedules even when one
    // entry is malformed ... migration continuity beats all-or-nothing.
    expect(result.schedules_imported_count).toBe(2)
    expect(result.schedule_errors).toHaveLength(1)
    expect(result.schedule_errors[0]).toContain('not a cron')

    const entries = await listSchedules(home, 'skedge')
    expect(entries).toHaveLength(2)
    const cron = entries.find((e) => e.timing.kind === 'cron')
    expect(cron?.prompt).toBe('morning brief')
    expect(cron?.timing.kind === 'cron' && cron.timing.timezone).toBe('America/Chicago')
    const interval = entries.find((e) => e.timing.kind === 'interval')
    expect(interval?.timing.kind === 'interval' && interval.timing.interval_seconds).toBe(300)
  })
})
