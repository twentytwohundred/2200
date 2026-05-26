/**
 * Embassy registration helpers (Phase 2 / PR-B1).
 *
 * The full registration flow lives on `Supervisor.registerEmbassy`;
 * this module exposes the file-touching primitives that flow uses.
 * Kept module-level (not class-level) so tests can exercise them
 * without a full Supervisor stand-up.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { stringify as yamlStringify } from 'yaml'
import { loadIdentity, writeIdentity } from '../../../identity/loader.js'
import type { IdentityFrontmatter } from '../../../identity/types.js'
import { agentPaths } from '../../../storage/layout.js'
import type { ConduitRecord, EmbassyIdentityBlock } from './types.js'
import {
  renderEmbassyIdentityBody,
  externalModelDisplayName,
  type EmbassyIdentityRenderArgs,
} from './identity-template.js'

/**
 * Patch an existing canonical identity file with an embassy block.
 * Used by the `attached` mode of registration. Idempotent: if the
 * identity already carries an embassy block for the same client_id,
 * the call is a no-op; for a DIFFERENT client_id, it throws (an
 * Agent can serve only one embassy at a time per the locked spec).
 */
export async function patchIdentityWithEmbassyBlock(
  canonicalIdentityPath: string,
  block: EmbassyIdentityBlock,
): Promise<void> {
  const identity = await loadIdentity(canonicalIdentityPath)
  const existing = identity.frontmatter.embassy
  if (existing !== undefined) {
    if (existing.client_id === block.client_id) return
    throw new Error(
      `Agent "${identity.frontmatter.agent_name}" is already acting as embassy for client_id "${existing.client_id}"; cannot also register it for "${block.client_id}". Retire the existing conduit first.`,
    )
  }
  const patched: IdentityFrontmatter = { ...identity.frontmatter, embassy: block }
  await writeIdentity(canonicalIdentityPath, patched, identity.body)
}

/**
 * Build a source identity file for a dedicated embassy and write it
 * to a temp directory. Returns the path to feed `supervisor.createAgent`.
 *
 * The supervisor's `createAgent` does its own validation + canonical
 * copy, so this module just produces a valid source artifact. Brain
 * dirs (shelf/, relationship-history/, standing-briefs/, notes/) are
 * created by `initEmbassyBrainDirs` after the Agent is created.
 */
export interface BuildDedicatedSourceArgs {
  home: string
  agentName: string
  externalModel: string
  clientId: string
  registeredAt: string
  /** Model binding (provider + model_id + tier). Required field on IdentityFrontmatter. */
  model: IdentityFrontmatter['model']
  /** Tools the embassy may call. Defaults to the empty tool set; B2 widens this. */
  tools?: IdentityFrontmatter['tools']
  /** ISO date for `created:`. Defaults to today. */
  created?: string
}

export async function buildDedicatedSourceIdentity(
  args: BuildDedicatedSourceArgs,
): Promise<string> {
  const displayName = externalModelDisplayName(args.externalModel)
  const renderArgs: EmbassyIdentityRenderArgs = {
    externalModelDisplay: displayName,
    clientId: args.clientId,
    registeredAt: args.registeredAt,
  }
  const body = renderEmbassyIdentityBody(renderArgs)
  const ap = agentPaths(args.home, args.agentName)
  const today = args.created ?? args.registeredAt.slice(0, 10)
  const frontmatter: Partial<IdentityFrontmatter> = {
    schema_version: 5,
    agent_name: args.agentName,
    agent_role: `Embassy for ${displayName}`,
    model: args.model,
    tools: args.tools ?? [],
    project_dir: ap.project,
    brain_dir: ap.brain,
    created: today,
    embassy: {
      external_model: args.externalModel,
      client_id: args.clientId,
      mode: 'dedicated',
      registered_at: args.registeredAt,
    },
  }
  // The source identity file lives in a temp area under
  // state/ — supervisor.createAgent reads it, copies it into the
  // canonical location, then never touches the source again.
  const sourceDir = join(args.home, 'state', 'connector', 'embassy-source-identities')
  await mkdir(sourceDir, { recursive: true, mode: 0o700 })
  const sourcePath = join(sourceDir, `${args.agentName}.identity.md`)
  const yaml = yamlStringify(frontmatter, { lineWidth: 0 })
  const content = `---\n${yaml}---\n\n${body}`
  await writeFile(sourcePath, content, { mode: 0o600 })
  return sourcePath
}

/**
 * Initialize an embassy Agent's brain directory layout per spec
 * section 4: shelf/, relationship-history/, standing-briefs/, notes/.
 * Other subdirs (the Agent's normal `brain/.records`, `notes/` etc.)
 * are created by the regular Agent init.
 */
export async function initEmbassyBrainDirs(home: string, embassyAgent: string): Promise<void> {
  const ap = agentPaths(home, embassyAgent)
  const dirs = ['shelf', 'relationship-history', 'standing-briefs', 'notes']
  for (const d of dirs) {
    await mkdir(join(ap.brain, d), { recursive: true, mode: 0o700 })
  }
}

/** Build a fresh ConduitRecord for a registration. */
export function buildConduitRecord(args: {
  clientId: string
  externalModel: string
  embassyAgent: string
  mode: 'dedicated' | 'attached'
  displayName: string
  registeredAt: string
  registeredBy: string
}): ConduitRecord {
  return {
    schema_version: 1,
    client_id: args.clientId,
    external_model: args.externalModel,
    embassy_agent: args.embassyAgent,
    mode: args.mode,
    display_name: args.displayName,
    registered_at: args.registeredAt,
    registered_by: args.registeredBy,
    last_seen_at: null,
    retired_at: null,
  }
}

/** Touch — kept for symmetry with future helpers. */
export function _embassyDirname(home: string, agentName: string): string {
  return dirname(agentPaths(home, agentName).identity)
}
