/**
 * Capability walkthrough runner (Phase F §8).
 *
 * Purpose: drive the Agent's post-build credential setup. On the
 * Agent's first chat with the operator (or any subsequent chat where
 * unsealed Capability credentials remain), the runner produces:
 *
 *   1. A plan ... which of the Agent's declared `capabilities[]` need
 *      walkthrough work (i.e., have at least one declared `auth.env_var`
 *      that the vault does not yet hold).
 *   2. Rendered prose for each Capability's walkthrough body, ready to
 *      paste into chat verbatim before issuing the `credential_request`
 *      for that Capability's credential.
 *
 * This module is the planning + rendering primitive layer. It is
 * intentionally pure-functional + side-effect free: it takes a vault
 * interface as input, never constructs one. The Agent's first-chat
 * task body (separate PR) and the system prompt (separate PR) invoke
 * these primitives to drive the actual operator-facing flow.
 *
 * Phase F §0a locks honored:
 *   - §0a-3 forced walkthrough at first chat open. Runner produces a
 *     non-empty plan whenever unsealed credentials exist; the Agent's
 *     prompt logic uses that as the trigger.
 *   - §0a-4 per-Agent vault; multi-Agent share deferred. Runner reads
 *     the calling Agent's own vault only.
 *   - §0a-5 bundled-by-OAuth Capabilities (e.g. google-workspace =
 *     gmail + calendar + drive + contacts + tasks under one auth). The
 *     runner checks vault per Capability's declared auth entries, not
 *     per service surface. One Capability that bundles five services
 *     produces one walkthrough flow.
 *
 * What this is NOT:
 *   - Not a tool. The runner doesn't get registered as a baseline
 *     tool; the Agent's orientation task body invokes the planning
 *     function and renders the output. Future iterations may expose
 *     a `walkthrough_get_plan` tool, but that's a separable concern.
 *   - Not an orchestration loop. The Agent's loop drives the
 *     sequence by issuing one `credential_request` per Capability;
 *     the runner provides the data the loop needs, not the loop
 *     itself.
 *   - Not a substitute for the two INTERIM prompt patches from
 *     PR #207. Those teach the Agent the broad behavior; the runner
 *     gives the Agent the precise plan + prose. When the runner is
 *     fully integrated into the orientation task body, the INTERIM
 *     bullets get REMOVED as part of that integration's rollout.
 */
import type { CapabilityRecord } from './capability-loader.js'
import type { CredentialDecl } from './capability-schema.js'

/**
 * Minimal vault interface the runner depends on. The real
 * `CredentialVault` from `src/runtime/credentials/vault.ts` satisfies
 * this shape; tests can substitute a Map-backed stub.
 */
export interface VaultHasChecker {
  has(name: string): Promise<boolean>
}

/**
 * Per-Capability slot in the walkthrough plan. Carries enough context
 * to render the Capability prose AND to issue the credential_request
 * calls for the missing credentials.
 */
export interface CapabilityWalkthroughSlot {
  /** The full Capability record from the loader (id, frontmatter, body, source_*). */
  capability: CapabilityRecord
  /**
   * The subset of the Capability's `auth[]` entries whose credential
   * names are NOT in the vault. Empty array means the Capability is
   * fully provisioned (it WOULD have been filtered out of the plan,
   * but the field is here for completeness / debugging).
   */
  missing_credentials: CredentialDecl[]
}

/**
 * The complete walkthrough plan for an Agent.
 */
export interface WalkthroughPlan {
  /** The Agent's name (for context + logging). */
  agent_name: string
  /** Capabilities that need walkthrough work, in catalog id order. */
  needs_walkthrough: CapabilityWalkthroughSlot[]
  /** Capability ids that are fully provisioned (all auth credentials sealed). */
  already_provisioned: string[]
  /**
   * Capability ids declared in Identity.capabilities[] but NOT found in
   * the loaded catalog. Surfaced so the operator can audit (typo? old
   * catalog id that got renamed? operator-authored entry under
   * `~/.2200/catalog/capabilities/` that isn't loaded for some reason?).
   */
  unknown_capabilities: string[]
}

export interface ComputePlanArgs {
  /** Agent name; used for logging + rendered prose context. */
  agentName: string
  /** Capability ids declared in Identity.capabilities[]. */
  capabilityIds: string[]
  /** All Capabilities loaded from the catalog (from `loadCapabilities`). */
  catalog: CapabilityRecord[]
  /** Vault checker for "is this credential sealed?" probes. */
  vault: VaultHasChecker
}

/**
 * Compute the walkthrough plan for an Agent.
 *
 * For each Capability id in `capabilityIds`:
 *   - If it resolves to a catalog entry: check each declared
 *     `auth.env_var` against the vault. If any are unsealed, the
 *     Capability lands in `needs_walkthrough` with the missing list.
 *     If all are sealed, the id lands in `already_provisioned`.
 *   - If it does NOT resolve: the id lands in `unknown_capabilities`.
 *
 * Capabilities with empty `auth[]` are treated as "always already
 * provisioned" (a Capability that needs no credentials is functional
 * the moment it's selected; the walkthrough has nothing to do).
 *
 * Order in `needs_walkthrough` is by Capability id ascending, matching
 * the loader's deterministic ordering. The Agent walks through them in
 * that order unless the operator explicitly redirects.
 */
export async function computeWalkthroughPlan(args: ComputePlanArgs): Promise<WalkthroughPlan> {
  // Index catalog by id for O(1) lookups.
  const byId = new Map<string, CapabilityRecord>()
  for (const rec of args.catalog) {
    byId.set(rec.frontmatter.id, rec)
  }

  const needs: CapabilityWalkthroughSlot[] = []
  const sealed: string[] = []
  const unknown: string[] = []

  for (const id of args.capabilityIds) {
    const cap = byId.get(id)
    if (!cap) {
      unknown.push(id)
      continue
    }

    if (cap.frontmatter.auth.length === 0) {
      sealed.push(id)
      continue
    }

    const missing: CredentialDecl[] = []
    for (const credDecl of cap.frontmatter.auth) {
      const isSealed = await args.vault.has(credDecl.env_var)
      if (!isSealed) {
        missing.push(credDecl)
      }
    }

    if (missing.length === 0) {
      sealed.push(id)
    } else {
      needs.push({ capability: cap, missing_credentials: missing })
    }
  }

  needs.sort((a, b) => a.capability.frontmatter.id.localeCompare(b.capability.frontmatter.id))

  return {
    agent_name: args.agentName,
    needs_walkthrough: needs,
    already_provisioned: sealed,
    unknown_capabilities: unknown,
  }
}

/**
 * Render the operator-facing intro message for the walkthrough.
 * Posted as a single chat message before the per-Capability loop
 * begins. Sets expectations about scope + estimated time.
 *
 * If `plan.needs_walkthrough` is empty, returns an empty string ...
 * the caller should NOT post intro chat for a trivial plan.
 */
export function renderWalkthroughIntro(plan: WalkthroughPlan): string {
  if (plan.needs_walkthrough.length === 0) return ''

  const totalMinutes = plan.needs_walkthrough
    .map((slot) => slot.capability.frontmatter.walkthrough.estimated_minutes ?? 5)
    .reduce((a, b) => a + b, 0)

  const capNames = plan.needs_walkthrough.map((slot) => slot.capability.frontmatter.label)
  const namesList =
    capNames.length === 1
      ? (capNames[0] ?? '')
      : capNames.length === 2
        ? `${capNames[0] ?? ''} and ${capNames[1] ?? ''}`
        : `${capNames.slice(0, -1).join(', ')}, and ${capNames[capNames.length - 1] ?? ''}`

  const countWord =
    plan.needs_walkthrough.length === 1
      ? 'one integration'
      : `${String(plan.needs_walkthrough.length)} integrations`

  const lines = [
    `I need to set up ${countWord} before I can do real work on my lane: **${namesList}**.`,
    '',
    `Estimated time: about ${String(totalMinutes)} minutes total. Each one is a short walkthrough + a credential paste; you can skip individual integrations if you don't have them or don't want them yet.`,
    '',
    `I'll start with **${capNames[0] ?? ''}** in the next message. Reply "skip" at any point to skip the current integration, or "do this later" to pause the whole flow and come back another time.`,
  ]
  return lines.join('\n')
}

/**
 * Render the per-Capability walkthrough body for chat. This is the
 * Capability's `body` (the markdown after the frontmatter) prepended
 * with a short header naming what's about to happen + which
 * credentials will be requested.
 *
 * Posted as a single chat message before the `credential_request` call(s)
 * for this Capability's missing credentials.
 */
export function renderCapabilityWalkthrough(slot: CapabilityWalkthroughSlot): string {
  const cap = slot.capability
  const missing = slot.missing_credentials
  const credLabels =
    missing.length === 1
      ? `1 credential (\`${missing[0]?.env_var ?? ''}\`)`
      : `${String(missing.length)} credentials (${missing.map((c) => `\`${c.env_var}\``).join(', ')})`

  const header = [
    `## ${cap.frontmatter.label}`,
    '',
    cap.frontmatter.description,
    '',
    `**What I'll ask for:** ${credLabels}.`,
    '',
    '---',
    '',
  ].join('\n')

  return header + cap.body
}

/**
 * Render the closing message after all Capabilities are walked.
 * Acknowledges what was provisioned, what was skipped (per
 * operator-recorded skip flags in the caller's flow), and hands
 * control back to the operator for the first real task.
 */
export function renderWalkthroughClose(args: {
  agent_name: string
  agent_role: string
  provisioned: string[]
  skipped: string[]
}): string {
  const lines: string[] = []
  if (args.provisioned.length > 0) {
    const labels = args.provisioned.join(', ')
    lines.push(`I've provisioned credentials for: **${labels}**.`)
  }
  if (args.skipped.length > 0) {
    const labels = args.skipped.join(', ')
    lines.push(`Skipped (you can revisit anytime): **${labels}**.`)
  }
  lines.push('')
  lines.push(`I'm set up for my lane (${args.agent_role}). What would you like to work on first?`)
  return lines.join('\n')
}
