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
  collectOpenClawSearchEnv,
  collectOpenClawSecrets,
  discoverOpenClawSecretPaths,
  looksLikeOpenClawHome,
  detectOpenClawHome,
  disableOpenClaw,
  parseIdentityMd,
  OpenClawSurveyError,
} from '../../../src/runtime/migration/openclaw.js'
import { CREDENTIAL_NAME_RE } from '../../../src/runtime/credentials/types.js'

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
        // Non-LLM secrets that a suffix heuristic would wrongly sweep up.
        GITHUB_TOKEN: 'ghp-secret-DO-NOT-MIGRATE',
        AWS_SECRET_ACCESS_KEY: 'aws-secret-DO-NOT-MIGRATE',
        STRIPE_API_KEY: 'sk-live-DO-NOT-MIGRATE',
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
  it('copies only allowlisted LLM keys; refuses channel tokens, non-LLM secrets, and flags', async () => {
    await writeFixture()
    const env = await collectOpenClawLlmEnv(ocHome)
    // LLM provider keys 2200 understands → copied.
    expect(env['XAI_API_KEY']).toBe('xai-secret-123')
    expect(env['MINIMAX_API_KEY']).toBe('mm-secret-456')
    // Channel tokens → never.
    expect(env['DISCORD_BOT_TOKEN']).toBeUndefined()
    // Non-LLM secrets that a `_KEY$`/`_TOKEN$` suffix heuristic would
    // have wrongly swept up → must stay behind (the security fix).
    expect(env['GITHUB_TOKEN']).toBeUndefined()
    expect(env['AWS_SECRET_ACCESS_KEY']).toBeUndefined()
    expect(env['STRIPE_API_KEY']).toBeUndefined()
    // Non-secret config → never.
    expect(env['SOME_FLAG']).toBeUndefined()
  })
})

describe('collectOpenClawSearchEnv (OpenClaw web-search parity)', () => {
  // Write just an openclaw.json with the given config into the temp ocHome.
  const writeConfig = async (config: unknown): Promise<void> => {
    await writeFile(join(ocHome, 'openclaw.json'), JSON.stringify(config))
  }

  it("carries a gemini key from OpenClaw's real plugin path (Doug's valkyrie shape)", async () => {
    // This is the exact shape on the live box: provider "gemini", key under
    // plugins.entries.google.config.webSearch.apiKey, NO cx. The old code
    // looked at env.* and mis-mapped gemini→google; this pins the fix.
    await writeConfig({
      tools: { web: { search: { enabled: true, provider: 'gemini' } } },
      plugins: { entries: { google: { config: { webSearch: { apiKey: 'AIzaSyTEST-gemini' } } } } },
    })
    const env = await collectOpenClawSearchEnv(ocHome)
    expect(env['GEMINI_SEARCH_API_KEY']).toBe('AIzaSyTEST-gemini')
    expect(env['WEB_SEARCH_PROVIDER']).toBe('gemini')
    // NOT mapped to the Custom Search (google) slot, and no bogus cx.
    expect(env['GOOGLE_SEARCH_API_KEY']).toBeUndefined()
    expect(env['GOOGLE_SEARCH_CX']).toBeUndefined()
  })

  it('carries a brave key from the plugin path and pins brave', async () => {
    await writeConfig({
      tools: { web: { search: { enabled: true, provider: 'brave' } } },
      plugins: { entries: { brave: { config: { webSearch: { apiKey: 'BSA-test' } } } } },
    })
    const env = await collectOpenClawSearchEnv(ocHome)
    expect(env['BRAVE_API_KEY']).toBe('BSA-test')
    expect(env['WEB_SEARCH_PROVIDER']).toBe('brave')
  })

  it('reads brave from the mirrored top-level apiKey when the plugin entry is absent', async () => {
    await writeConfig({
      tools: { web: { search: { enabled: true, provider: 'brave', apiKey: 'BSA-toplevel' } } },
    })
    const env = await collectOpenClawSearchEnv(ocHome)
    expect(env['BRAVE_API_KEY']).toBe('BSA-toplevel')
  })

  it('carries nothing for a provider 2200 does not support yet (e.g. grok/perplexity)', async () => {
    await writeConfig({
      tools: { web: { search: { enabled: true, provider: 'grok' } } },
      plugins: { entries: { xai: { config: { webSearch: { apiKey: 'xai-key' } } } } },
    })
    // The grok key must NOT be swept into any 2200 search slot ... the report
    // names it instead. (Pin: no silent pin to a dead provider.)
    expect(await collectOpenClawSearchEnv(ocHome)).toEqual({})
  })

  // Minimal buildable OC home (workspace + IDENTITY) plus the given config,
  // for exercising the migration report's web-search line end to end.
  const writeReportFixture = async (extra: Record<string, unknown>): Promise<void> => {
    const ws = join(ocHome, 'workspace')
    await mkdir(ws, { recursive: true })
    await writeFile(join(ws, 'IDENTITY.md'), '- **Name:** Searcher\n')
    await writeConfig({
      agents: { defaults: { model: { primary: 'xai/grok-4.3' }, workspace: ws } },
      channels: {},
      env: {},
      ...extra,
    })
  }

  it('carries nothing AND the report does not claim a carry when the provider is named but keyless', async () => {
    // Fail-loud: an OC home that names a supported provider but has no key
    // must not write a false "your key carried" into the Agent's continuity
    // note. It carries nothing and the report sends the operator to Settings.
    await writeReportFixture({ tools: { web: { search: { enabled: true, provider: 'brave' } } } })
    expect(await collectOpenClawSearchEnv(ocHome)).toEqual({})
    const survey = await surveyOpenClawHome(ocHome)
    expect(survey.searchProvider).toBe('brave')
    expect(survey.searchKeyPresent).toBe(false)
    const { report } = openclawToHandoff(survey, { sourceHost: 'valkyrie', now: FIXED_NOW })
    expect(report).toMatch(/no key set, so nothing carried/)
    expect(report).not.toMatch(/your key carried/)
  })

  it('the report confirms a carry only when a key was actually present', async () => {
    await writeReportFixture({
      tools: { web: { search: { enabled: true, provider: 'gemini' } } },
      plugins: { entries: { google: { config: { webSearch: { apiKey: 'AIzaSyTEST' } } } } },
    })
    const survey = await surveyOpenClawHome(ocHome)
    expect(survey.searchKeyPresent).toBe(true)
    const { report } = openclawToHandoff(survey, { sourceHost: 'valkyrie', now: FIXED_NOW })
    expect(report).toMatch(/your key carried into 2200/)
  })

  it('returns {} when search is disabled or unconfigured', async () => {
    await writeConfig({ tools: { web: { search: { enabled: false, provider: 'gemini' } } } })
    expect(await collectOpenClawSearchEnv(ocHome)).toEqual({})
    await writeConfig({})
    expect(await collectOpenClawSearchEnv(ocHome)).toEqual({})
  })

  it('auto-detects brave from a key-only config (no explicit provider)', async () => {
    await writeConfig({
      tools: { web: { search: { enabled: true } } },
      plugins: { entries: { brave: { config: { webSearch: { apiKey: 'BSA-auto' } } } } },
    })
    const env = await collectOpenClawSearchEnv(ocHome)
    expect(env['WEB_SEARCH_PROVIDER']).toBe('brave')
    expect(env['BRAVE_API_KEY']).toBe('BSA-auto')
  })
})

describe('collectOpenClawSecrets (vault-everything migration)', () => {
  // Mirrors the real shape surveyed on valkyrie: secrets live in env, models,
  // channels, gateway, skills, and plugins ... not just the LLM env block.
  const secretConfig = {
    env: { XAI_API_KEY: 'xai-1', SOME_FLAG: 'true' },
    models: {
      providers: { xai: { apiKey: 'xai-2', models: [{ id: 'grok-4.3', maxTokens: 1000 }] } },
    },
    channels: { discord: { token: 'discord-tok' } },
    gateway: { auth: { token: 'gw-tok' } },
    skills: { entries: { goplaces: { apiKey: 'gp-key' } } },
    plugins: { entries: { google: { config: { webSearch: { apiKey: 'gem-key' } } } } },
  }

  const writeSecretConfig = async (config: unknown): Promise<void> => {
    await writeFile(join(ocHome, 'openclaw.json'), JSON.stringify(config))
  }

  it('discovers the whole env block + every secret-named leaf, excluding non-secrets', () => {
    const paths = discoverOpenClawSecretPaths(secretConfig)
      .map((r) => r.sourcePath)
      .sort()
    expect(paths).toEqual([
      'channels.discord.token',
      'env.SOME_FLAG', // whole env block ... "every key, no matter what"
      'env.XAI_API_KEY',
      'gateway.auth.token',
      'models.providers.xai.apiKey',
      'plugins.entries.google.config.webSearch.apiKey',
      'skills.entries.goplaces.apiKey',
    ])
    // maxTokens / model id must NOT be swept (exact secret-name match, not substring)
    expect(paths.some((p) => p.includes('maxTokens') || p.endsWith('.id'))).toBe(false)
  })

  it('names every secret as a valid vault credential slug', () => {
    for (const ref of discoverOpenClawSecretPaths(secretConfig)) {
      expect(ref.name).toMatch(CREDENTIAL_NAME_RE)
    }
    const byPath = Object.fromEntries(
      discoverOpenClawSecretPaths(secretConfig).map((r) => [r.sourcePath, r.name]),
    )
    expect(byPath['channels.discord.token']).toBe('oc-channels-discord-token')
    expect(byPath['plugins.entries.google.config.webSearch.apiKey']).toBe(
      'oc-plugins-entries-google-config-websearch-apikey',
    )
  })

  it('reads the values at migrate time (the vault payload)', async () => {
    await writeSecretConfig(secretConfig)
    const secrets = await collectOpenClawSecrets(ocHome)
    const byName = Object.fromEntries(secrets.map((s) => [s.name, s.value]))
    expect(byName['oc-env-xai-api-key']).toBe('xai-1')
    expect(byName['oc-models-providers-xai-apikey']).toBe('xai-2')
    expect(byName['oc-channels-discord-token']).toBe('discord-tok')
    expect(byName['oc-gateway-auth-token']).toBe('gw-tok')
    expect(byName['oc-skills-entries-goplaces-apikey']).toBe('gp-key')
    expect(secrets).toHaveLength(7)
  })

  it('skips empty values and returns [] for a config with no secrets', async () => {
    await writeSecretConfig({ models: { providers: { xai: { apiKey: '' } } }, env: {} })
    expect(await collectOpenClawSecrets(ocHome)).toEqual([])
  })

  it("skips ${ENV_VAR} interpolation references (found in Skippy's real config)", () => {
    // OpenClaw's models.providers.*.apiKey hold `${XAI_API_KEY}` references, not
    // literal keys ... the real value lives in env. Vaulting the reference is noise.
    const config = {
      env: { XAI_API_KEY: 'xai-real-value' },
      models: { providers: { xai: { apiKey: '${XAI_API_KEY}' } } },
    }
    const paths = discoverOpenClawSecretPaths(config).map((r) => r.sourcePath)
    expect(paths).toContain('env.XAI_API_KEY')
    expect(paths).not.toContain('models.providers.xai.apiKey')
  })

  it('survey.credentialCount + report tell the operator what got vaulted', async () => {
    const ws = join(ocHome, 'workspace')
    await mkdir(ws, { recursive: true })
    await writeFile(join(ws, 'IDENTITY.md'), '- **Name:** Vaulted\n')
    await writeSecretConfig({
      agents: { defaults: { model: { primary: 'xai/grok-4.3' }, workspace: ws } },
      ...secretConfig,
    })
    const survey = await surveyOpenClawHome(ocHome)
    expect(survey.credentialCount).toBe(7)
    // the survey must never carry the credential VALUES
    expect(JSON.stringify(survey)).not.toContain('discord-tok')
    const { report } = openclawToHandoff(survey, { sourceHost: 'valkyrie', now: FIXED_NOW })
    expect(report).toMatch(/7 OpenClaw credentials .* sealed in your Agent's vault/)
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

describe('disableOpenClaw (never deletes; best-effort, non-fatal)', () => {
  it('reports failure cleanly when no systemd service and no openclaw CLI exist', async () => {
    // CI has neither an `openclaw` systemd user service nor the
    // `openclaw` CLI on PATH, so the executor must return a graceful
    // ok:false with a useful detail ... never throw, never delete.
    const result = await disableOpenClaw()
    expect(result.ok).toBe(false)
    expect(result.detail).toMatch(/could not stop/i)
  })
})

describe('detectOpenClawHome (the "only offer when present" gate)', () => {
  it('returns null when there is no ~/.openclaw under the base dir (blank user)', async () => {
    // The first-run wizard must NOT prompt a fresh user. Detection over
    // a base dir with no .openclaw is the guarantee.
    expect(await detectOpenClawHome(ocHome)).toBeNull()
  })

  it('returns the .openclaw path when an OpenClaw home is present', async () => {
    const base = join(ocHome, 'fakehome')
    await mkdir(join(base, '.openclaw'), { recursive: true })
    await writeFile(join(base, '.openclaw', 'openclaw.json'), '{}')
    expect(await detectOpenClawHome(base)).toBe(join(base, '.openclaw'))
  })

  it('returns null when ~/.openclaw exists but has no openclaw.json (not a real OC home)', async () => {
    const base = join(ocHome, 'partial')
    await mkdir(join(base, '.openclaw'), { recursive: true })
    expect(await detectOpenClawHome(base)).toBeNull()
  })
})

describe('minimal OpenClaw home (identity + one cron only)', () => {
  it('converts cleanly with a generated-stub persona and a post-migration checklist', async () => {
    // Barest viable OC home: a config with one model, IDENTITY.md, and
    // a single enabled cron job. No SOUL, no memory dir, no operating
    // docs, no channels. The adapter must still produce a valid handoff
    // and a useful report rather than throwing on the absences.
    const ws = join(ocHome, 'workspace')
    await mkdir(join(ocHome, 'cron'), { recursive: true })
    await mkdir(ws, { recursive: true })
    await writeFile(
      join(ocHome, 'openclaw.json'),
      JSON.stringify({
        agents: { defaults: { model: { primary: 'anthropic/claude-opus-4-7' }, workspace: ws } },
        channels: {},
        env: {},
      }),
    )
    await writeFile(join(ws, 'IDENTITY.md'), '- **Name:** Lonely\n')
    await writeFile(
      join(ocHome, 'cron', 'jobs.json'),
      JSON.stringify({
        jobs: [
          {
            name: 'Solo',
            enabled: true,
            schedule: { kind: 'cron', expr: '0 6 * * *' },
            payload: { kind: 'agentTurn', message: 'wake up' },
          },
        ],
      }),
    )

    const survey = await surveyOpenClawHome(ocHome)
    expect(survey.soulMd).toBeNull()
    expect(survey.memoryFileCount).toBe(0)
    expect(survey.operatingDocs).toEqual([])

    const { handoff, report } = openclawToHandoff(survey, {
      sourceHost: 'tiny',
      now: FIXED_NOW,
    })
    expect(handoff.frontmatter.agent_name).toBe('lonely')
    // No persona => generated stub (persona_body absent on the handoff).
    expect(handoff.frontmatter.persona_body).toBeUndefined()
    // No memory dir => no brain source_dir; no inline notes either.
    expect(handoff.frontmatter.brain.source_dir).toBeUndefined()
    expect(handoff.frontmatter.brain.inline_notes ?? []).toEqual([])
    // The one enabled job still maps.
    expect(handoff.frontmatter.schedules).toHaveLength(1)
    expect(handoff.frontmatter.schedules[0]?.expr).toBe('0 6 * * *')
    // The checklist must always be present and name the new Agent.
    expect(report).toContain('Next steps (checklist)')
    expect(report).toContain('2200 agent start lonely')
    expect(report).toContain('disable the source OpenClaw instance')
  })
})
