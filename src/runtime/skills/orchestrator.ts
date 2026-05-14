/**
 * Skill install orchestration.
 *
 * Wires together: source resolution → parse → analyze → optional disk
 * install → optional per-Agent MCP + vault writes. This is the
 * runtime entry point the web routes (and any future CLI verb that
 * wants the same orchestration) call into.
 *
 * Two main verbs:
 *
 *   - `previewSkillInstall` ... resolves the source, parses the
 *     SKILL.md, runs the analyzer, returns a structured preview the
 *     wizard renders. Does NOT touch the home directory. The cleanup
 *     side-effect runs before returning.
 *
 *   - `installSkillFromSource` ... preview + actually install:
 *     copies the skill into `<home>/skills/<name>/`, then for each
 *     selected Agent writes vault secrets and appends `mcp_servers[]`.
 *     Stops at the first per-Agent failure with no further mutation;
 *     the caller decides whether to retry or proceed with partial
 *     installation. Returns the list of Agents that were successfully
 *     wired up so the UI can surface restart pills.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  type ExtractedMcpServer,
  type ToolClass,
  extractMcpServers,
  extractToolClassesWithWarnings,
} from './analyze.js'
import { installSkill, uninstallSkill, SkillInstallError } from './install.js'
import {
  resolveSource,
  type ResolveSourceOptions,
  type ResolvedSource,
} from '../extensions/source.js'
import { parseSkillContent, SkillParseError } from './types.js'
import {
  appendMcpServerToIdentity,
  IdentityMutationError,
  removeMcpServerFromIdentity,
  storeServerSecrets,
} from './identity-write.js'
import { addOverlayEntries, removeOverlayEntries } from '../agent/audit/overlay.js'
import { CredentialVault } from '../credentials/vault.js'
import { loadIdentity } from '../identity/loader.js'
import type { McpServerSpec } from '../identity/types.js'
import type { SecretRef } from '../secrets/types.js'

export class SkillOrchestratorError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'SOURCE_FAILED'
      | 'PARSE_FAILED'
      | 'INSTALL_FAILED'
      | 'IDENTITY_FAILED'
      | 'SECRETS_INCOMPLETE',
  ) {
    super(message)
    this.name = 'SkillOrchestratorError'
  }
}

export interface SkillPreview {
  name: string
  description: string
  body_preview: string
  tags: string[]
  declared_tools: string[]
  mcp_servers: ExtractedMcpServer[]
  tool_classes: Record<string, ToolClass>
  tool_classes_warnings: string[]
  source_kind: ResolvedSource['kind']
}

const BODY_PREVIEW_CHARS = 1200

export interface PreviewSkillInstallArgs {
  source: string
  resolveOptions?: ResolveSourceOptions
}

export async function previewSkillInstall(args: PreviewSkillInstallArgs): Promise<SkillPreview> {
  let resolved: ResolvedSource
  try {
    resolved = await resolveSource(args.source, args.resolveOptions ?? {})
  } catch (err) {
    throw new SkillOrchestratorError(
      `could not resolve source: ${err instanceof Error ? err.message : String(err)}`,
      'SOURCE_FAILED',
    )
  }
  try {
    const skillPath = join(resolved.rootDir, 'SKILL.md')
    let content: string
    try {
      content = await readFile(skillPath, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new SkillOrchestratorError(
          `source has no SKILL.md at the root. The skill installer expects a SKILL.md file at the top of the directory or as the fetched file.`,
          'PARSE_FAILED',
        )
      }
      throw err
    }
    let parsed
    try {
      parsed = parseSkillContent(content, skillPath)
    } catch (err) {
      if (err instanceof SkillParseError) {
        throw new SkillOrchestratorError(err.message, 'PARSE_FAILED')
      }
      throw err
    }
    const mcpServers = extractMcpServers(parsed)
    const toolClasses = extractToolClassesWithWarnings(parsed)
    const bodyPreview =
      parsed.body.length > BODY_PREVIEW_CHARS
        ? `${parsed.body.slice(0, BODY_PREVIEW_CHARS)}…`
        : parsed.body
    return {
      name: parsed.name,
      description: parsed.frontmatter.description,
      body_preview: bodyPreview,
      tags: parsed.frontmatter.tags,
      declared_tools: parsed.frontmatter.tools,
      mcp_servers: mcpServers,
      tool_classes: toolClasses.classes,
      tool_classes_warnings: toolClasses.warnings,
      source_kind: resolved.kind,
    }
  } finally {
    await resolved.cleanup().catch(() => undefined)
  }
}

/**
 * Per-server, per-agent secret map. Operator-supplied at install time.
 * Outer key = agent name; inner key = server name; inner-inner key =
 * env var name → literal value.
 */
export type SecretsByAgent = Record<string, Record<string, Record<string, string>>>

export interface InstallSkillFromSourceArgs {
  home: string
  source: string
  /** Agent slugs that should receive the MCP server entries. May be empty for knowledge-only skills. */
  agents: string[]
  /** Operator-supplied env values. Required for any server that declares env keys. */
  secrets: SecretsByAgent
  force?: boolean
  resolveOptions?: ResolveSourceOptions
}

export interface InstallSkillResult {
  skill: { name: string; description: string; path: string }
  mcp_installed_for: string[]
  requires_restart: string[]
  warnings: string[]
}

export async function installSkillFromSource(
  args: InstallSkillFromSourceArgs,
): Promise<InstallSkillResult> {
  let resolved: ResolvedSource
  try {
    resolved = await resolveSource(args.source, args.resolveOptions ?? {})
  } catch (err) {
    throw new SkillOrchestratorError(
      `could not resolve source: ${err instanceof Error ? err.message : String(err)}`,
      'SOURCE_FAILED',
    )
  }

  let installed: Awaited<ReturnType<typeof installSkill>>
  try {
    try {
      installed = await installSkill({
        home: args.home,
        source: resolved,
        force: args.force ?? false,
      })
    } catch (err) {
      if (err instanceof SkillInstallError || err instanceof SkillParseError) {
        throw new SkillOrchestratorError(err.message, 'INSTALL_FAILED')
      }
      throw err
    }
  } finally {
    await resolved.cleanup().catch(() => undefined)
  }

  const warnings: string[] = []
  const toolClassExt = extractToolClassesWithWarnings(installed.skill)
  warnings.push(...toolClassExt.warnings)
  const extracted = extractMcpServers(installed.skill)

  // Validate that every required env value is supplied for every selected agent.
  for (const agent of args.agents) {
    for (const server of extracted) {
      const need = server.required_secrets.map((s) => s.key)
      if (need.length === 0) continue
      const supplied = args.secrets[agent]?.[server.name] ?? {}
      const missing = need.filter((k) => !(k in supplied) || supplied[k]?.length === 0)
      if (missing.length > 0) {
        throw new SkillOrchestratorError(
          `agent "${agent}" is missing values for server "${server.name}": ${missing.join(', ')}`,
          'SECRETS_INCOMPLETE',
        )
      }
    }
  }

  const namespacedClasses = namespacedToolClasses(extracted, toolClassExt.classes, warnings)

  const installedFor: string[] = []
  for (const agent of args.agents) {
    for (const server of extracted) {
      const envValues: Record<string, string> = {}
      const agentSecrets = args.secrets[agent]?.[server.name] ?? {}
      for (const required of server.required_secrets) {
        const value = agentSecrets[required.key]
        if (value !== undefined) envValues[required.key] = value
      }
      const refs = await storeServerSecrets({
        home: args.home,
        agentName: agent,
        skillSlug: installed.skill.name,
        env: envValues,
      })
      const spec = buildServerSpec(server, refs, installed.skill.name)
      try {
        await appendMcpServerToIdentity({ home: args.home, agentName: agent, spec })
      } catch (err) {
        if (err instanceof IdentityMutationError) {
          throw new SkillOrchestratorError(err.message, 'IDENTITY_FAILED')
        }
        throw err
      }
    }
    if (Object.keys(namespacedClasses).length > 0) {
      await addOverlayEntries({
        home: args.home,
        agentName: agent,
        skillSlug: installed.skill.name,
        toolClasses: namespacedClasses,
      })
    }
    installedFor.push(agent)
  }

  return {
    skill: {
      name: installed.skill.name,
      description: installed.skill.frontmatter.description,
      path: installed.destRoot,
    },
    mcp_installed_for: installedFor,
    requires_restart: installedFor,
    warnings,
  }
}

function buildServerSpec(
  ext: ExtractedMcpServer,
  refs: Record<string, SecretRef>,
  skillSlug: string,
): McpServerSpec {
  // Server names in mcp_servers[] use a stricter regex than skill slugs
  // (no dashes). Slugify to underscores to satisfy the schema while
  // staying readable.
  const safeName = ext.name.toLowerCase().replace(/[^a-z0-9_]/g, '_')
  if (ext.transport === 'stdio') {
    return {
      name: safeName,
      transport: 'stdio',
      command: ext.command,
      args: ext.args,
      env: refs,
    }
  }
  // http transport
  if (ext.auth_kind === 'bearer') {
    const bearerRef: SecretRef = refs['token'] ?? { source: 'vault', id: `${skillSlug}--token` }
    return {
      name: safeName,
      transport: 'http',
      url: ext.url,
      auth: { type: 'bearer', token: bearerRef },
      headers: {},
    }
  }
  return {
    name: safeName,
    transport: 'http',
    url: ext.url,
    auth: { type: 'none' },
    headers: {},
  }
}

/**
 * Apply MCP-server namespacing to a SKILL.md's `tool_classes` map.
 * Bare tool names (e.g. `check_in`) get prefixed with the slugified
 * server namespace so the dispatched tool name (`openpub_check_in`)
 * is what lands in the audit overlay. Fully-qualified keys (already
 * containing the namespace separator) pass through unchanged. Multi-
 * server skills with bare keys are surfaced as a warning rather than
 * broadcast. Underscore separator matches the runtime convention; the
 * audit verifier looks up `tool_call_end.tool` against the overlay
 * directly so the keys must match the dispatched name shape.
 */
function namespacedToolClasses(
  servers: ExtractedMcpServer[],
  toolClasses: Record<string, ToolClass>,
  warnings: string[],
): Record<string, ToolClass> {
  const slugify = (n: string) => n.toLowerCase().replace(/[^a-z0-9_]/g, '_')
  const namespaces = servers.map((s) => slugify(s.name))
  const out: Record<string, ToolClass> = {}
  for (const [tool, klass] of Object.entries(toolClasses)) {
    if (tool.includes('_') && namespaces.some((ns) => tool.startsWith(`${ns}_`))) {
      // Already fully-qualified with one of the declared servers.
      out[tool] = klass
      continue
    }
    if (tool.includes('.')) {
      // Legacy fully-qualified form ... rewrite to underscore so it
      // matches the runtime's dispatched name.
      out[tool.replace('.', '_')] = klass
      continue
    }
    if (namespaces.length === 0) {
      out[tool] = klass
      continue
    }
    if (namespaces.length === 1) {
      const ns = namespaces[0]
      if (ns !== undefined) out[`${ns}_${tool}`] = klass
      continue
    }
    warnings.push(
      `tool_classes.${tool}: skill declares ${String(namespaces.length)} MCP servers; please use a fully-qualified name like "<server>_${tool}" so the audit overlay knows which server the tool belongs to`,
    )
  }
  return out
}

export interface UninstallSkillArgs {
  home: string
  name: string
  /** Agents whose Identity files should have the skill's MCP server entries removed. */
  agents: string[]
}

export interface UninstallSkillResult {
  removed: boolean
  removed_from_agents: string[]
  requires_restart: string[]
}

export interface SkillCredentialEntry {
  env_key: string
  credential_name: string
  set_at: string | null
}

export interface SkillCredentialAgentGroup {
  agent: string
  server_name: string
  credentials: SkillCredentialEntry[]
}

export interface ListSkillCredentialsArgs {
  home: string
  skillName: string
  agents: string[]
}

const CREDENTIAL_PREFIX_SUFFIX = '--'

/**
 * For each live agent, return the vault credentials wired into the
 * named skill's MCP server, derived from the agent's identity. Filters
 * out env entries whose SecretRef does not match the skill's credential
 * prefix (`<skillName>--`); that prefix is the substrate's contract for
 * skill-installed credentials, so non-skill secrets stay invisible to
 * the skill-management UI.
 */
export async function listSkillCredentials(
  args: ListSkillCredentialsArgs,
): Promise<SkillCredentialAgentGroup[]> {
  const prefix = `${args.skillName}${CREDENTIAL_PREFIX_SUFFIX}`
  const out: SkillCredentialAgentGroup[] = []
  for (const agent of args.agents) {
    const path = join(args.home, 'agents', agent, 'identity.md')
    let identity
    try {
      identity = await loadIdentity(path)
    } catch {
      continue
    }
    const vault = new CredentialVault(args.home, agent)
    for (const server of identity.frontmatter.mcp_servers) {
      const credentials: SkillCredentialEntry[] = []
      if (server.transport === 'stdio') {
        for (const [envKey, ref] of Object.entries(server.env)) {
          if (ref.source !== 'vault' || !ref.id.startsWith(prefix)) continue
          credentials.push({
            env_key: envKey,
            credential_name: ref.id,
            set_at: await safeGetSetAt(vault, ref.id),
          })
        }
      } else {
        if (
          server.auth.type === 'bearer' &&
          server.auth.token.source === 'vault' &&
          server.auth.token.id.startsWith(prefix)
        ) {
          credentials.push({
            env_key: 'Authorization (bearer)',
            credential_name: server.auth.token.id,
            set_at: await safeGetSetAt(vault, server.auth.token.id),
          })
        }
      }
      if (credentials.length > 0) {
        out.push({ agent, server_name: server.name, credentials })
      }
    }
  }
  return out
}

async function safeGetSetAt(vault: CredentialVault, name: string): Promise<string | null> {
  try {
    const list = await vault.list()
    for (const entry of list) {
      if (entry.name === name) return entry.metadata.created_at
    }
  } catch {
    // tolerate
  }
  return null
}

export interface UpdateSkillCredentialArgs {
  home: string
  skillName: string
  agentName: string
  envKey: string
  /** New literal value to seal into the vault. */
  value: string
}

export interface UpdateSkillCredentialResult {
  credential_name: string
  set_at: string
  requires_restart: string
}

/**
 * Update one skill-owned vault credential. Uses the agent's identity
 * as the source of truth for which credential is mapped to the env
 * key (so we can never accidentally overwrite a non-skill credential
 * via this path) and refuses unless the resolved credential name
 * carries the skill's prefix.
 */
export async function updateSkillCredential(
  args: UpdateSkillCredentialArgs,
): Promise<UpdateSkillCredentialResult> {
  const path = join(args.home, 'agents', args.agentName, 'identity.md')
  let identity
  try {
    identity = await loadIdentity(path)
  } catch (err) {
    throw new SkillOrchestratorError(
      `cannot load identity for "${args.agentName}": ${err instanceof Error ? err.message : String(err)}`,
      'IDENTITY_FAILED',
    )
  }
  const prefix = `${args.skillName}${CREDENTIAL_PREFIX_SUFFIX}`
  let credentialName: string | null = null
  for (const server of identity.frontmatter.mcp_servers) {
    if (server.transport === 'stdio') {
      const ref = server.env[args.envKey]
      if (ref?.source === 'vault' && ref.id.startsWith(prefix)) {
        credentialName = ref.id
        break
      }
    } else if (
      args.envKey === 'Authorization (bearer)' &&
      server.auth.type === 'bearer' &&
      server.auth.token.source === 'vault' &&
      server.auth.token.id.startsWith(prefix)
    ) {
      credentialName = server.auth.token.id
      break
    }
  }
  if (credentialName === null) {
    throw new SkillOrchestratorError(
      `agent "${args.agentName}" has no skill-owned credential mapped to env key "${args.envKey}" for skill "${args.skillName}"`,
      'IDENTITY_FAILED',
    )
  }
  if (args.value.length === 0) {
    throw new SkillOrchestratorError('credential value cannot be empty', 'SECRETS_INCOMPLETE')
  }
  const vault = new CredentialVault(args.home, args.agentName)
  const setAt = new Date().toISOString()
  await vault.set(credentialName, {
    value: args.value,
    metadata: {
      created_at: setAt,
      provider: `skill:${args.skillName}`,
      notes: `Updated via Settings → Skills credential management.`,
    },
  })
  return {
    credential_name: credentialName,
    set_at: setAt,
    requires_restart: args.agentName,
  }
}

export async function uninstallSkillFromHome(
  args: UninstallSkillArgs,
): Promise<UninstallSkillResult> {
  const removedFromAgents: string[] = []
  for (const agent of args.agents) {
    try {
      const removed = await removeMcpServerFromIdentity({
        home: args.home,
        agentName: agent,
        serverName: args.name,
      })
      if (removed) removedFromAgents.push(agent)
    } catch (err) {
      if (err instanceof IdentityMutationError && err.code === 'AGENT_NOT_FOUND') continue
      throw err
    }
    await removeOverlayEntries({ home: args.home, agentName: agent, skillSlug: args.name })
  }
  const result = await uninstallSkill({
    home: args.home,
    name: args.name,
    approve: () => Promise.resolve(true),
    skipApprove: true,
  })
  return {
    removed: result.removed,
    removed_from_agents: removedFromAgents,
    requires_restart: removedFromAgents,
  }
}
