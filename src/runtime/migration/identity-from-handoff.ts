/**
 * Build an Identity record from a parsed migration handoff document
 * (Epic 5 Phase A PR B).
 *
 * Pure function: takes a HandoffDocument plus a few orchestration
 * inputs (today's date, the home dir) and returns a fully-validated
 * IdentityFrontmatter and body, ready to be passed to writeIdentity.
 * Does no IO. Tests assert the output structure directly without
 * needing a tmpdir.
 *
 * Defaults that the handoff schema does NOT carry:
 *
 *   - `model`: defaulted to frontier / anthropic / claude-opus-4-7.
 *     Phase A keeps the migration handoff focused on continuity
 *     (identity intent, brain, budget). Model selection is a normal
 *     post-migration Identity edit; Hobby's first run on this default
 *     matches what he runs as outside 2200 today, so no edit is
 *     needed for the canonical migration.
 *   - `agent_role`: derived from handoff.agent_type by humanizing
 *     underscores ("build_agent" → "build agent"). Operator edits
 *     post-migration if they want richer prose.
 *   - `tools`: empty array. Tool assignments happen post-migration via
 *     normal Identity edits (Epic 9 will surface a CLI for this).
 *   - `cost_caps`: daily_usd from handoff; warn_at_pct / reset_at /
 *     on_breach default per CostCapsSchema.
 *
 * The Agent's Identity body uses `handoff.frontmatter.persona_body`
 * if set; otherwise a minimal generated stub that points the Agent
 * at its `continuity-from-migration` brain note for prior context.
 */
import type { HandoffDocument } from './types.js'
import { IdentityFrontmatterSchema, type IdentityFrontmatter } from '../identity/types.js'

export interface BuildIdentityArgs {
  handoff: HandoffDocument
  /**
   * Absolute path to the 2200 home dir. Used to resolve project_dir
   * and brain_dir to the canonical per-Agent locations under it.
   */
  home: string
  /**
   * Today's date as a Date object. Injected (rather than read from
   * `new Date()`) so tests are deterministic.
   */
  today: Date
}

export interface BuiltIdentity {
  frontmatter: IdentityFrontmatter
  body: string
  /**
   * The intended on-disk path for the Agent's source Identity file.
   * The orchestrator (PR C) writes here and then passes this path to
   * `cli.agent.create` (or directly to Supervisor.createAgent in the
   * no-daemon case). The supervisor copies it to the canonical
   * `<home>/agents/<name>/identity.md` location.
   */
  source_path: string
}

/**
 * Default model binding for migrated Agents. Frontier tier on Anthropic.
 * Aligned with what Hobby runs as today (Claude Opus 4.7 in Claude Code).
 *
 * Per [[2026-04-26-model-field-format]] the runtime composes
 * `<provider>/<model_id>` for plan records; the binding object below
 * uses the locked field separation.
 */
const DEFAULT_MODEL_BINDING = {
  tier: 'frontier' as const,
  provider: 'anthropic',
  model_id: 'claude-opus-4-7',
}

/**
 * Build the Identity record from a handoff. Pure; throws if the
 * resulting frontmatter would fail Identity's own Zod validation
 * (which would indicate a bug in the mapping logic ... the parser
 * should have caught any user-input issues).
 */
export function buildIdentityFromHandoff(args: BuildIdentityArgs): BuiltIdentity {
  const fm = args.handoff.frontmatter
  const dateStr = formatYmd(args.today)

  // A migrating Agent keeps its voice: when the handoff carries a
  // persona_body (SOUL.md via the OpenClaw adapter, the source
  // Identity body via a future 2200 export), it becomes the Identity
  // body verbatim. The generated stub is the fallback for handoffs
  // that bring continuity but no persona.
  const body =
    fm.persona_body ??
    renderIdentityBody({
      agent_name: fm.agent_name,
      agent_type: fm.agent_type,
      handoff_source_path: args.handoff.source_path,
    })

  // The Identity expects schema_version literal `5`. Compose the
  // frontmatter and run it through the loader's validator so any
  // mapping bug surfaces here rather than at writeIdentity time.
  //
  // `tools` is empty by default (operator edits post-migration). When
  // the handoff carries `mcp_servers`, we also seed a wildcard tool
  // grant per declared server (e.g., `github.*`) so the Agent has
  // access to the declared tools the moment it starts. The operator
  // can narrow grants by editing the Identity post-migration.
  const declaredServers = fm.mcp_servers
  const wildcardGrants = declaredServers.map((s) => `${s.name}.*`)

  const candidate = {
    schema_version: 5,
    agent_name: fm.agent_name,
    agent_role: humanizeAgentType(fm.agent_type),
    // Prefer the handoff's declared model when present (the onboarding
    // flow populates this from the picker). Fall back to the
    // hardcoded default for handoff documents that pre-date the field
    // (older `agent migrate` exports).
    model: fm.model ?? DEFAULT_MODEL_BINDING,
    tools: wildcardGrants,
    project_dir: `${args.home}/agents/${fm.agent_name}/project`,
    brain_dir: `${args.home}/agents/${fm.agent_name}/brain`,
    created: dateStr,
    cost_caps: {
      daily_usd: fm.budget.daily_cap_usd,
    },
    notification_policy: {
      tiers_allowed: fm.identity.notification_policy.tiers_allowed,
    },
    mcp_servers: declaredServers,
    capabilities: fm.capabilities,
  }

  const validated = IdentityFrontmatterSchema.parse(candidate)

  // Source path is `<home>/<name>.identity.md` — outside the canonical
  // `<home>/agents/<name>/` tree on purpose; `agent create` copies the
  // source into the canonical path. Same convention as `agent create`
  // when invoked with a user-supplied --identity path that lives
  // alongside the home root.
  const source_path = `${args.home}/${fm.agent_name}.identity.md`

  return {
    frontmatter: validated,
    body,
    source_path,
  }
}

interface RenderBodyArgs {
  agent_name: string
  agent_type: string
  handoff_source_path: string | null
}

/**
 * Render the Identity body. Minimal stub that orients the Agent on
 * first run. The rich prior-context narrative lives in the
 * `continuity-from-migration` brain note that the orchestrator (PR C)
 * writes from the handoff body.
 */
function renderIdentityBody(args: RenderBodyArgs): string {
  const lines: string[] = [
    `# ${capitalizeFirst(args.agent_name)}`,
    '',
    `Migrated into 2200 as a ${humanizeAgentType(args.agent_type)}.`,
    '',
    'Read your `continuity-from-migration` brain note for the prior context that came in with this migration ... who you were before, what you were working on, what to do first.',
    '',
    'This Identity body is a starting stub. Edit it to capture your persona, lane, and rules of engagement. Operators can also edit this file directly.',
  ]
  if (args.handoff_source_path !== null) {
    lines.push('', `Original handoff document: \`${args.handoff_source_path}\``)
  }
  return lines.join('\n')
}

/**
 * Convert an agent_type token (e.g. `build_agent`) into a human-readable
 * role string (e.g. `build agent`). Operators can replace this with
 * richer prose post-migration.
 */
function humanizeAgentType(agent_type: string): string {
  return agent_type.replace(/[_-]+/g, ' ').trim()
}

function capitalizeFirst(s: string): string {
  const first = s.charAt(0)
  if (first === '') return s
  return first.toUpperCase() + s.slice(1)
}

function formatYmd(d: Date): string {
  const y = String(d.getUTCFullYear())
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}
