/**
 * OpenClaw migration adapter (Epic 5 Phase B).
 *
 * Reads an OpenClaw home directory (default `~/.openclaw`) and
 * produces a 2200 migration handoff the existing Phase A orchestrator
 * consumes unchanged. Spec: [[05-phase-b-openclaw-adapter]], written
 * against a live survey of OpenClaw 2026.4.11.
 *
 * Three deliberate layers:
 *
 *   - `surveyOpenClawHome` ... tolerant reader. Collects structure +
 *     content needed for conversion. Reads secret NAMES (env keys,
 *     channel ids) but never secret VALUES.
 *   - `openclawToHandoff` ... pure conversion to an in-memory
 *     HandoffDocument plus a human-readable migration report listing
 *     what mapped, what didn't, and what to do about it. The report
 *     is appended to the continuity note so the migrated Agent itself
 *     knows what didn't come along.
 *   - `collectOpenClawLlmEnv` ... the ONLY function that reads secret
 *     values. Called at migrate time (operator's explicit call per
 *     Doug's 2026-06-12 direction: LLM keys move so the Agent keeps
 *     working without re-auth). Channel tokens (Discord etc.) are NOT
 *     collected here ... connector re-wiring is a separate step with
 *     its own consent moment.
 *
 * `renderDisableInstructions` covers the end of the flow: the source
 * OC instance gets DISABLED (never deleted) so the operator isn't
 * paying for two fleets. When 2200 runs on the same host we can stop
 * the systemd user unit directly; otherwise we print the commands.
 */
import { readFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { HandoffFrontmatterSchema, type HandoffDocument, type HandoffSchedule } from './types.js'

// ---------------------------------------------------------------------------
// Survey
// ---------------------------------------------------------------------------

export interface OpenClawCronJob {
  name: string
  enabled: boolean
  /** 5-field cron expression, when schedule.kind === 'cron'. */
  cronExpr: string | null
  tz: string | null
  /** Task text, when payload.kind === 'agentTurn'. */
  message: string | null
  /** Raw kinds for the report when a job doesn't map. */
  scheduleKind: string
  payloadKind: string
}

export interface OpenClawSurvey {
  ocHome: string
  /** OC's workspace dir (config `agents.defaults.workspace`, else `<home>/workspace`). */
  workspace: string
  /** Parsed IDENTITY.md key-values; null when the file is absent. */
  identity: {
    name: string | null
    creature: string | null
    emoji: string | null
  } | null
  /** SOUL.md content verbatim; null when absent. */
  soulMd: string | null
  /** Present operating docs (USER/AGENTS/TOOLS/HEARTBEAT.md) with content. */
  operatingDocs: { file: string; content: string }[]
  /** Daily-memory dir (workspace/memory) when present, with file count. */
  memoryDir: string | null
  memoryFileCount: number
  cronJobs: OpenClawCronJob[]
  /** `agents.defaults.model.primary`, e.g. "xai/grok-4.3". */
  primaryModel: string | null
  /** Channel names configured (e.g. ['discord']). Names only. */
  channels: string[]
  /** Skill directory names under workspace/skills. */
  skills: string[]
  sessionCount: number
  /** Env var NAMES from the config `env` block. Values are never read here. */
  envKeyNames: string[]
}

export class OpenClawSurveyError extends Error {}

/** True when `dir` looks like an OpenClaw home (config file present). */
export async function looksLikeOpenClawHome(dir: string): Promise<boolean> {
  try {
    const s = await stat(join(dir, 'openclaw.json'))
    return s.isFile()
  } catch {
    return false
  }
}

/**
 * Probe for an OpenClaw home in the conventional location
 * (`<baseDir>/.openclaw`, default `~/.openclaw`). Returns the absolute
 * path when it looks like a real OpenClaw home, else null.
 *
 * Used by the first-run wizard to offer migration ONLY when OpenClaw is
 * actually installed ... a blank user never sees the prompt. `baseDir`
 * is injectable so tests are deterministic instead of probing the real
 * home directory.
 */
export async function detectOpenClawHome(baseDir: string = homedir()): Promise<string | null> {
  const candidate = join(baseDir, '.openclaw')
  return (await looksLikeOpenClawHome(candidate)) ? candidate : null
}

export async function surveyOpenClawHome(ocHome: string): Promise<OpenClawSurvey> {
  if (!(await looksLikeOpenClawHome(ocHome))) {
    throw new OpenClawSurveyError(
      `${ocHome} does not look like an OpenClaw home (no openclaw.json). Pass the directory that contains openclaw.json (usually ~/.openclaw).`,
    )
  }
  const config = await readJsonTolerant(join(ocHome, 'openclaw.json'))

  const agentsDefaults = asRecord(asRecord(config['agents'])['defaults'])
  // The config stores the workspace as an ABSOLUTE path on the source
  // host. When the OC home was rsync'd to another machine for the
  // migration (the common cross-host case), that path dangles ... fall
  // back to the copy that traveled inside the OC home. Found live
  // against Skippy's instance 2026-06-12.
  const configuredWorkspace =
    typeof agentsDefaults['workspace'] === 'string' ? agentsDefaults['workspace'] : null
  let workspace = join(ocHome, 'workspace')
  if (configuredWorkspace !== null && (await dirExists(configuredWorkspace))) {
    workspace = configuredWorkspace
  }

  const soulMd = await readFileOrNull(join(workspace, 'SOUL.md'))
  const identityMd = await readFileOrNull(join(workspace, 'IDENTITY.md'))
  const identity = identityMd === null ? null : parseIdentityMd(identityMd)

  const operatingDocs: { file: string; content: string }[] = []
  for (const f of ['USER.md', 'AGENTS.md', 'TOOLS.md', 'HEARTBEAT.md']) {
    const content = await readFileOrNull(join(workspace, f))
    if (content !== null) operatingDocs.push({ file: f, content })
  }

  const memoryDir = join(workspace, 'memory')
  let memoryFileCount = 0
  let hasMemoryDir = false
  try {
    const entries = await readdir(memoryDir)
    hasMemoryDir = true
    memoryFileCount = entries.filter((e) => e.endsWith('.md')).length
  } catch {
    /* absent is fine */
  }

  const cronJobs = await readCronJobs(join(ocHome, 'cron', 'jobs.json'))

  const modelBlock = asRecord(agentsDefaults['model'])
  const primaryModel = typeof modelBlock['primary'] === 'string' ? modelBlock['primary'] : null

  const channels = Object.keys(asRecord(config['channels']))
  const envKeyNames = Object.keys(asRecord(config['env']))

  let skills: string[] = []
  try {
    skills = (await readdir(join(workspace, 'skills'))).filter((e) => !e.startsWith('.'))
  } catch {
    /* absent is fine */
  }

  let sessionCount = 0
  try {
    const sessions = await readdir(join(ocHome, 'agents', 'main', 'sessions'))
    sessionCount = sessions.filter((e) => e.endsWith('.jsonl')).length
  } catch {
    /* absent is fine */
  }

  return {
    ocHome,
    workspace,
    identity,
    soulMd,
    operatingDocs,
    memoryDir: hasMemoryDir ? memoryDir : null,
    memoryFileCount,
    cronJobs,
    primaryModel,
    channels,
    skills,
    sessionCount,
    envKeyNames,
  }
}

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

export interface ConvertOptions {
  /** Override the agent name (default: IDENTITY.md Name, lowercased). */
  name?: string
  /** Daily budget cap. OC has no budget concept; default 10 USD. */
  dailyCapUsd?: number
  /** Hostname recorded in provenance (informational). */
  sourceHost?: string
  /** Injected clock for deterministic tests. */
  now?: () => Date
}

export interface ConvertResult {
  handoff: HandoffDocument
  /** Markdown migration report (also appended to the continuity note). */
  report: string
  warnings: string[]
}

/**
 * Providers whose ids match between OpenClaw and 2200's catalog. A
 * primary model on any other provider is reported and the Identity
 * falls back to the migration default binding.
 */
const PROVIDER_MAP: ReadonlySet<string> = new Set([
  'anthropic',
  'openai',
  'deepseek',
  'openrouter',
  'gemini',
  'xai',
  'kimi',
])

export function openclawToHandoff(
  survey: OpenClawSurvey,
  opts: ConvertOptions = {},
): ConvertResult {
  const warnings: string[] = []

  const displayName = opts.name ?? survey.identity?.name ?? 'migrated-agent'
  const agentName = (opts.name ?? displayName).toLowerCase().replace(/[^a-z0-9_-]+/g, '-')
  if (!/^[a-z][a-z0-9_-]*$/.test(agentName)) {
    throw new OpenClawSurveyError(
      `cannot derive a valid agent name from "${displayName}"; pass --name explicitly`,
    )
  }

  // Model binding: "provider/model_id" with openrouter-style nested ids
  // ("openrouter/deepseek/deepseek-v3.2" → provider=openrouter, rest=id).
  let model: { tier: 'frontier'; provider: string; model_id: string } | undefined
  if (survey.primaryModel !== null) {
    const slash = survey.primaryModel.indexOf('/')
    const provider = slash === -1 ? survey.primaryModel : survey.primaryModel.slice(0, slash)
    const modelId = slash === -1 ? '' : survey.primaryModel.slice(slash + 1)
    if (PROVIDER_MAP.has(provider) && modelId !== '') {
      model = { tier: 'frontier', provider, model_id: modelId }
    } else {
      warnings.push(
        `primary model "${survey.primaryModel}" has no direct 2200 provider mapping; the Identity gets the migration default ... rebind via the model picker.`,
      )
    }
  }

  // Schedules: enabled cron+agentTurn jobs map 1:1; everything else is
  // reported rather than silently dropped.
  const schedules: HandoffSchedule[] = []
  const unmappedJobs: string[] = []
  for (const job of survey.cronJobs) {
    if (!job.enabled) {
      unmappedJobs.push(
        `"${job.name}" (disabled in OpenClaw; re-add with \`2200 schedule add\` if wanted)`,
      )
      continue
    }
    if (job.cronExpr === null || job.message === null) {
      unmappedJobs.push(
        `"${job.name}" (schedule kind "${job.scheduleKind}" / payload kind "${job.payloadKind}" not mappable)`,
      )
      continue
    }
    schedules.push({
      expr: job.cronExpr,
      ...(job.tz !== null ? { tz: job.tz } : {}),
      task: job.message,
    })
  }

  // Operating docs ride along as review-tagged brain notes ... they
  // describe the OLD runtime, so they're history, not instructions.
  const inlineNotes = survey.operatingDocs.map((d) => ({
    title: `OpenClaw ${d.file} (imported)`,
    slug: `openclaw-${d.file.toLowerCase().replace(/\.md$/, '')}`,
    type: 'reference',
    tags: ['openclaw-import', 'review'],
    body: d.content,
  }))

  const report = renderReport({ agentName, survey, schedules, unmappedJobs, warnings, model })

  const continuityBody = [
    `# Continuity: migrated from OpenClaw`,
    '',
    `You were an OpenClaw Agent on \`${opts.sourceHost ?? 'the source host'}\`; as of ${formatYmd((opts.now ?? (() => new Date()))())} you run on 2200. Your persona (SOUL.md) IS your Identity body ... you are still you.`,
    '',
    `Your daily memories (${String(survey.memoryFileCount)} files) were imported into your brain and are searchable. Your operating docs from OpenClaw are in your brain tagged \`openclaw-import\` ... they describe the old runtime, so treat them as history, not instructions. Read the platform starter pack in the shared brain to learn how 2200 works.`,
    '',
    '## Migration report',
    '',
    report,
  ].join('\n')

  const frontmatter = HandoffFrontmatterSchema.parse({
    handoff_schema_version: 1,
    agent_name: agentName,
    agent_type: 'agent',
    identity: { display_name: displayName },
    brain: {
      ...(survey.memoryDir !== null ? { source_dir: survey.memoryDir } : {}),
      ...(inlineNotes.length > 0 ? { inline_notes: inlineNotes } : {}),
    },
    budget: { daily_cap_usd: opts.dailyCapUsd ?? 10 },
    schedules,
    ...(model !== undefined ? { model } : {}),
    ...(survey.soulMd !== null ? { persona_body: survey.soulMd } : {}),
    provenance: {
      source_system: 'openclaw',
      ...(opts.sourceHost !== undefined ? { source_host: opts.sourceHost } : {}),
      exported_at: (opts.now ?? (() => new Date()))().toISOString(),
    },
  })

  return {
    handoff: { frontmatter, body: continuityBody, source_path: null },
    report,
    warnings,
  }
}

// ---------------------------------------------------------------------------
// Secrets (the only value-reading function) + disable instructions
// ---------------------------------------------------------------------------

/**
 * Collect the LLM provider env vars from the OC config's `env` block.
 * Per Doug's 2026-06-12 direction these migrate as-is into
 * `~/.config/2200/runtime.env` so the Agent's model binding works the
 * moment it lands ... no re-auth wall on the adoption path.
 *
 * Security: this is an explicit ALLOWLIST of known LLM-provider env-key
 * names, NOT a suffix heuristic. A suffix match like `_KEY$`/`_TOKEN$`
 * would sweep up unrelated secrets that happen to live in the same env
 * block (GITHUB_TOKEN, AWS_SECRET_ACCESS_KEY, STRIPE_API_KEY, channel
 * tokens, ...). We copy only the credentials for LLM providers 2200
 * actually understands; anything else stays in OpenClaw.
 */
const LLM_ENV_KEY_ALLOWLIST: ReadonlySet<string> = new Set([
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'DEEPSEEK_API_KEY',
  'OPENROUTER_API_KEY',
  'XAI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'KIMI_API_KEY',
  'MOONSHOT_API_KEY',
  'MINIMAX_API_KEY',
  'GROQ_API_KEY',
  'MISTRAL_API_KEY',
  'TOGETHER_API_KEY',
  'FIREWORKS_API_KEY',
  'PERPLEXITY_API_KEY',
  'COHERE_API_KEY',
])

export async function collectOpenClawLlmEnv(ocHome: string): Promise<Record<string, string>> {
  const config = await readJsonTolerant(join(ocHome, 'openclaw.json'))
  const env = asRecord(config['env'])
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) {
    if (typeof v !== 'string' || v === '') continue
    if (LLM_ENV_KEY_ALLOWLIST.has(k.toUpperCase())) {
      out[k] = v
    }
  }
  return out
}

/**
 * Commands that disable (never delete) a source OpenClaw instance so
 * the operator isn't running two fleets. Printed in the report and by
 * the CLI at the end of a successful migration; when 2200 runs on the
 * same host the CLI offers to run them.
 */
export function renderDisableInstructions(opts: { sameHost: boolean }): string {
  const cmds = [
    'systemctl --user stop openclaw 2>/dev/null || openclaw gateway stop',
    'systemctl --user disable openclaw 2>/dev/null || true',
  ]
  const header = opts.sameHost
    ? 'Disable the local OpenClaw instance (it is NOT deleted; re-enable with `systemctl --user enable --now openclaw`):'
    : 'On the OpenClaw host, disable the instance (it is NOT deleted; re-enable with `systemctl --user enable --now openclaw`):'
  return [header, ...cmds.map((c) => `  ${c}`)].join('\n')
}

/**
 * Actually disable (NOT delete) the local OpenClaw instance, so it stops
 * running alongside 2200 and the operator isn't paying for two fleets.
 * Tries systemd-user first (Linux), then the `openclaw` CLI's own stop
 * (macOS / non-systemd). Best-effort and non-fatal: returns a summary of
 * what ran. Re-enable later with `systemctl --user enable --now openclaw`
 * or by relaunching OpenClaw ... nothing here removes data.
 */
export async function disableOpenClaw(): Promise<{ ok: boolean; detail: string }> {
  const { spawn } = await import('node:child_process')
  const run = (cmd: string, args: string[]): Promise<number> =>
    new Promise((resolve) => {
      try {
        const child = spawn(cmd, args, { stdio: 'ignore' })
        child.on('error', () => {
          resolve(127)
        })
        child.on('exit', (code) => {
          resolve(code ?? 1)
        })
      } catch {
        resolve(127)
      }
    })

  // systemd user service (Linux). `disable` first so it does not come
  // back on next login; then `stop` to end the current run.
  const sysDisable = await run('systemctl', ['--user', 'disable', 'openclaw'])
  const sysStop = await run('systemctl', ['--user', 'stop', 'openclaw'])
  if (sysStop === 0 || sysDisable === 0) {
    return { ok: true, detail: 'stopped and disabled the openclaw systemd user service' }
  }

  // Fallback: the openclaw CLI's own gateway stop (macOS / no systemd).
  const cliStop = await run('openclaw', ['gateway', 'stop'])
  if (cliStop === 0) {
    return { ok: true, detail: 'stopped the OpenClaw gateway via the openclaw CLI' }
  }

  return {
    ok: false,
    detail:
      'could not stop OpenClaw automatically (no systemd user service and no openclaw CLI on PATH)',
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function readJsonTolerant(path: string): Promise<Record<string, unknown>> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (err) {
    throw new OpenClawSurveyError(
      `cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    )
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    return asRecord(parsed)
  } catch (err) {
    throw new OpenClawSurveyError(
      `${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    )
  }
}

async function dirExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {}
}

async function readFileOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

/**
 * IDENTITY.md is a KV list: `- **Name:** Skippy`. Tolerate plain
 * `- Name: Skippy` too.
 */
export function parseIdentityMd(content: string): {
  name: string | null
  creature: string | null
  emoji: string | null
} {
  const get = (key: string): string | null => {
    const re = new RegExp(`^-\\s*(?:\\*\\*)?${key}:?(?:\\*\\*)?:?\\s*(.+)$`, 'mi')
    const m = re.exec(content)
    if (!m) return null
    const val = (m[1] ?? '').trim()
    return val === '' || val.startsWith('_(') ? null : val
  }
  return { name: get('Name'), creature: get('Creature'), emoji: get('Emoji') }
}

async function readCronJobs(path: string): Promise<OpenClawCronJob[]> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return []
  }
  const jobs: unknown[] = Array.isArray(parsed)
    ? parsed
    : Array.isArray(asRecord(parsed)['jobs'])
      ? (asRecord(parsed)['jobs'] as unknown[])
      : []
  return jobs.map((j) => {
    const job = asRecord(j)
    const schedule = asRecord(job['schedule'])
    const payload = asRecord(job['payload'])
    const scheduleKind = typeof schedule['kind'] === 'string' ? schedule['kind'] : 'unknown'
    const payloadKind = typeof payload['kind'] === 'string' ? payload['kind'] : 'unknown'
    return {
      name: typeof job['name'] === 'string' ? job['name'] : '(unnamed)',
      enabled: job['enabled'] === true,
      cronExpr:
        scheduleKind === 'cron' && typeof schedule['expr'] === 'string' ? schedule['expr'] : null,
      tz: typeof schedule['tz'] === 'string' ? schedule['tz'] : null,
      message:
        payloadKind === 'agentTurn' && typeof payload['message'] === 'string'
          ? payload['message']
          : null,
      scheduleKind,
      payloadKind,
    }
  })
}

function renderReport(args: {
  agentName: string
  survey: OpenClawSurvey
  schedules: HandoffSchedule[]
  unmappedJobs: string[]
  warnings: string[]
  model: { tier: 'frontier'; provider: string; model_id: string } | undefined
}): string {
  const s = args.survey
  const lines: string[] = [
    '### Migrated',
    '',
    `- Persona: ${s.soulMd !== null ? 'SOUL.md → Identity body (verbatim)' : 'no SOUL.md found; generated stub used'}`,
    `- Memories: ${String(s.memoryFileCount)} daily files → brain (searchable)`,
    `- Operating docs: ${s.operatingDocs.length > 0 ? s.operatingDocs.map((d) => d.file).join(', ') + ' → brain, tagged `openclaw-import`' : 'none found'}`,
    `- Schedules: ${String(args.schedules.length)} imported`,
    '',
    '### Not migrated (and what to do)',
    '',
  ]
  for (const u of args.unmappedJobs) lines.push(`- Schedule ${u}`)
  for (const c of s.channels) {
    lines.push(
      `- Channel \`${c}\`: tokens stay in OpenClaw. Reconnect via 2200's Extensions store (the ${c} connector) ... takes a minute, and the Agent keeps the same ${c} presence.`,
    )
  }
  if (s.skills.length > 0) {
    lines.push(
      `- Skills (${s.skills.join(', ')}): install via 2200's skills ingestion (\`2200 skill install\`).`,
    )
  }
  if (s.sessionCount > 0) {
    lines.push(
      `- Session transcripts: ${String(s.sessionCount)} files stay in OpenClaw (import on request later; your daily memory files carry the durable context).`,
    )
  }
  for (const w of args.warnings) lines.push(`- ${w}`)

  // Post-migration checklist ... actionable, in the order it matters.
  // Lives in both the printed CLI output and the Agent's continuity
  // note, so neither the operator nor the Agent has to reconstruct
  // "what now?" from the prose above.
  lines.push('', '### Next steps (checklist)', '')
  lines.push(
    '- [ ] Bring the Agent up: `2200 daemon start` then `2200 agent start ' + args.agentName + '`',
  )
  lines.push(
    '- [ ] Confirm an LLM credential is set ... the migrate flow copies OpenClaw provider keys into `~/.config/2200/runtime.env` by default; if you skipped that, sign in (`2200 oauth xai login`) or paste a key.',
  )
  if (args.model === undefined && s.primaryModel !== null) {
    lines.push(
      `- [ ] Rebind the model ... OpenClaw ran \`${s.primaryModel}\`, which has no direct 2200 provider; pick a model in the web app (\`2200 web\` → the Agent → model picker).`,
    )
  }
  if (s.channels.length > 0) {
    lines.push(
      `- [ ] Re-wire channel(s) (${s.channels.join(', ')}) in the Extensions store so the Agent can talk where it used to.`,
    )
  }
  lines.push(
    '- [ ] Review the budget cap (defaulted on migration) via the web app or the Identity file; OpenClaw had no budget concept.',
  )
  lines.push(
    '- [ ] Once the Agent is confirmed working, disable the source OpenClaw instance so you are not paying twice (commands printed at the end of the migration).',
  )
  return lines.join('\n')
}

function formatYmd(d: Date): string {
  return d.toISOString().slice(0, 10)
}
