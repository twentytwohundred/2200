/**
 * Tests for the OpenClaw migration adapter (Epic 5 Phase B).
 *
 * The fixture OC home mirrors the shapes surveyed from a live
 * OpenClaw 2026.4.11 instance on 2026-06-12 (see the Phase B spec).
 * The contract being pinned:
 *
 *   - SOUL.md becomes the Identity body verbatim (the Agent keeps
 *     its voice); IDENTITY.md drives names
 *   - enabled cron+agentTurn jobs map to schedules; disabled and
 *     unmappable jobs are REPORTED, never silently dropped
 *   - channel tokens never enter the handoff; the report tells the
 *     operator how to reconnect
 *   - collectOpenClawLlmEnv reads ONLY provider-shaped env keys
 *     (Doug's 2026-06-12 call: LLM keys migrate; channel tokens don't
 *     ride this path)
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  surveyOpenClawHome,
  openclawToHandoff,
  collectOpenClawLlmEnv,
  looksLikeOpenClawHome,
  parseIdentityMd,
  OpenClawSurveyError,
} from '../../../src/runtime/migration/openclaw.js'

let ocHome: string

const FIXED_NOW = () => new Date('2026-06-12T22:00:00.000Z')

async function writeFixture(opts: { withSoul?: boolean; withCron?: boolean } = {}): Promise<void> {
  const ws = join(ocHome, 'workspace')
  await mkdir(join(ws, 'memory'), { recursive: true })
  await mkdir(join(ws, 'skills', 'moltbook-skill'), { recursive: true })
  await mkdir(join(ocHome, 'cron'), { recursive: true })
  await mkdir(join(ocHome, 'agents', 'main', 'sessions'), { recursive: true })

  await writeFile(
    join(ocHome, 'openclaw.json'),
    JSON.stringify({
      agents: { defaults: { model: { primary: 'xai/grok-4.3' }, workspace: ws } },
      channels: { discord: { token: 'discord-secret-DO-NOT-MIGRATE' } },
      env: {
        XAI_API_KEY: 'xai-secret-123',
        MINIMAX_API_KEY: 'mm-secret-456',
        DISCORD_BOT_TOKEN: 'discord-secret-789',
        SOME_FLAG: 'true',
      },
    }),
  )

  if (opts.withSoul !== false) {
    await writeFile(
      join(ws, 'SOUL.md'),
      '# SOUL.md — Skippy\n\nSnarky, brilliant, trapped in a beer can.\n',
    )
  }
  await writeFile(
    join(ws, 'IDENTITY.md'),
    '# IDENTITY.md - Who Am I?\n\n- **Name:** Skippy\n- **Creature:** AI assistant with opinions\n- **Emoji:** 🦾\n- **Avatar:** _(not set)_\n',
  )
  await writeFile(join(ws, 'USER.md'), '# USER.md — About the operator\n')
  await writeFile(join(ws, 'memory', '2026-06-10.md'), 'remembered a thing\n')
  await writeFile(join(ws, 'memory', '2026-06-11.md'), 'remembered another\n')
  await writeFile(
    join(ocHome, 'agents', 'main', 'sessions', 'abc.jsonl'),
    '{"type":"session","version":3}\n',
  )

  if (opts.withCron !== false) {
    await writeFile(
      join(ocHome, 'cron', 'jobs.json'),
      JSON.stringify({
        jobs: [
          {
            name: 'Morning Brief',
            enabled: true,
            schedule: { kind: 'cron', expr: '0 7 * * *', tz: 'America/Chicago' },
            payload: { kind: 'agentTurn', message: 'Run the morning brief.' },
          },
          {
            name: 'Disabled Job',
            enabled: false,
            schedule: { kind: 'cron', expr: '0 9 * * *' },
            payload: { kind: 'agentTurn', message: 'never runs' },
          },
          {
            name: 'Weird Job',
            enabled: true,
            schedule: { kind: 'at', whenMs: 1 },
            payload: { kind: 'systemEvent' },
          },
        ],
      }),
    )
  }
}

beforeEach(async () => {
  ocHome = await mkdtemp(join(tmpdir(), '2200-oc-fixture-'))
})

afterEach(async () => {
  await rm(ocHome, { recursive: true, force: true })
})

describe('surveyOpenClawHome', () => {
  it('falls back to the in-home workspace when the configured absolute path dangles (rsync case)', async () => {
    await writeFixture()
    // Simulate an rsync'd copy: config points at the SOURCE host's
    // absolute workspace path, which does not exist here.
    await writeFile(
      join(ocHome, 'openclaw.json'),
      JSON.stringify({
        agents: {
          defaults: {
            model: { primary: 'xai/grok-4.3' },
            workspace: '/home/skippy/.openclaw/workspace',
          },
        },
        channels: {},
        env: {},
      }),
    )
    const survey = await surveyOpenClawHome(ocHome)
    expect(survey.soulMd).toContain('beer can')
    expect(survey.memoryFileCount).toBe(2)
  })

  it('rejects directories without openclaw.json with a pointed message', async () => {
    expect(await looksLikeOpenClawHome(ocHome)).toBe(false)
    await expect(surveyOpenClawHome(ocHome)).rejects.toThrow(OpenClawSurveyError)
    await expect(surveyOpenClawHome(ocHome)).rejects.toThrow(/openclaw\.json/)
  })

  it('surveys the fixture: identity, soul, memory count, cron, channels, env NAMES only', async () => {
    await writeFixture()
    const survey = await surveyOpenClawHome(ocHome)
    expect(survey.identity?.name).toBe('Skippy')
    expect(survey.identity?.emoji).toBe('🦾')
    expect(survey.soulMd).toContain('beer can')
    expect(survey.memoryFileCount).toBe(2)
    expect(survey.cronJobs).toHaveLength(3)
    expect(survey.primaryModel).toBe('xai/grok-4.3')
    expect(survey.channels).toEqual(['discord'])
    expect(survey.skills).toEqual(['moltbook-skill'])
    expect(survey.sessionCount).toBe(1)
    expect(survey.envKeyNames).toContain('XAI_API_KEY')
    // The survey object must never contain a secret VALUE.
    expect(JSON.stringify(survey)).not.toContain('secret')
  })
})

describe('openclawToHandoff', () => {
  it('produces a valid handoff: persona, brain dir, schedules, model, provenance', async () => {
    await writeFixture()
    const survey = await surveyOpenClawHome(ocHome)
    const { handoff, report, warnings } = openclawToHandoff(survey, {
      sourceHost: 'valkyrie',
      now: FIXED_NOW,
    })

    expect(handoff.frontmatter.agent_name).toBe('skippy')
    expect(handoff.frontmatter.identity.display_name).toBe('Skippy')
    expect(handoff.frontmatter.persona_body).toContain('beer can')
    expect(handoff.frontmatter.brain.source_dir).toBe(join(ocHome, 'workspace', 'memory'))
    expect(handoff.frontmatter.model).toEqual({
      tier: 'frontier',
      provider: 'xai',
      model_id: 'grok-4.3',
    })
    expect(handoff.frontmatter.provenance.source_system).toBe('openclaw')
    expect(handoff.frontmatter.provenance.source_host).toBe('valkyrie')

    // Only the enabled+mappable job becomes a schedule.
    expect(handoff.frontmatter.schedules).toHaveLength(1)
    expect(handoff.frontmatter.schedules[0]).toEqual({
      expr: '0 7 * * *',
      tz: 'America/Chicago',
      task: 'Run the morning brief.',
    })

    // The other two jobs are reported, not dropped silently.
    expect(report).toContain('Disabled Job')
    expect(report).toContain('Weird Job')
    // Channel guidance present; no token anywhere in the handoff.
    expect(report).toContain('discord')
    expect(JSON.stringify(handoff)).not.toContain('secret')
    expect(warnings).toEqual([])
  })

  it('unknown provider falls back with a warning instead of a broken binding', async () => {
    await writeFixture()
    const survey = await surveyOpenClawHome(ocHome)
    survey.primaryModel = 'minimax/MiniMax-M2.7'
    const { handoff, warnings } = openclawToHandoff(survey, { now: FIXED_NOW })
    expect(handoff.frontmatter.model).toBeUndefined()
    expect(warnings.some((w) => w.includes('minimax/MiniMax-M2.7'))).toBe(true)
  })

  it('derives a safe agent name and allows --name override', async () => {
    await writeFixture()
    const survey = await surveyOpenClawHome(ocHome)
    survey.identity = { name: 'Skippy The Magnificent', creature: null, emoji: null }
    const auto = openclawToHandoff(survey, { now: FIXED_NOW })
    expect(auto.handoff.frontmatter.agent_name).toBe('skippy-the-magnificent')
    const named = openclawToHandoff(survey, { name: 'skippy', now: FIXED_NOW })
    expect(named.handoff.frontmatter.agent_name).toBe('skippy')
  })

  it('operating docs become review-tagged inline notes', async () => {
    await writeFixture()
    const survey = await surveyOpenClawHome(ocHome)
    const { handoff } = openclawToHandoff(survey, { now: FIXED_NOW })
    const notes = handoff.frontmatter.brain.inline_notes ?? []
    expect(notes.some((n) => n.slug === 'openclaw-user')).toBe(true)
    expect(notes.every((n) => n.tags?.includes('openclaw-import'))).toBe(true)
  })
})

describe('collectOpenClawLlmEnv', () => {
  it('collects provider keys and refuses channel tokens + non-secrets', async () => {
    await writeFixture()
    const env = await collectOpenClawLlmEnv(ocHome)
    expect(env['XAI_API_KEY']).toBe('xai-secret-123')
    expect(env['MINIMAX_API_KEY']).toBe('mm-secret-456')
    expect(env['DISCORD_BOT_TOKEN']).toBeUndefined()
    expect(env['SOME_FLAG']).toBeUndefined()
  })
})

describe('parseIdentityMd', () => {
  it('tolerates plain KV without bold markers', () => {
    const parsed = parseIdentityMd('- Name: Plain\n- Creature: thing\n')
    expect(parsed.name).toBe('Plain')
    expect(parsed.creature).toBe('thing')
  })

  it('treats placeholder values as absent', () => {
    const parsed = parseIdentityMd('- **Name:** Skippy\n- **Avatar:** _(not set)_\n')
    expect(parsed.name).toBe('Skippy')
  })
})
