/**
 * Identity + vault writes for skill installation.
 *
 * When the operator commits a skill install with an MCP server, three
 * writes happen per selected Agent:
 *
 *   1. Each required env value lands in the Agent's CredentialVault
 *      under a namespaced credential name (`<skill_slug>--<env_slug>`).
 *   2. The server's `McpServerSpec` is appended to the Identity's
 *      `mcp_servers[]` array, with `SecretRef`s pointing to the vault
 *      entries from step 1.
 *   3. The Identity file is rewritten atomically via `writeIdentity`.
 *
 * These helpers stay separate from `installSkill` itself because the
 * Skill on-disk copy is global (`<home>/skills/<name>/`) but the MCP
 * server + secrets are per-Agent. A single skill install fans out one
 * disk copy + N per-Agent mutations.
 */
import { join } from 'node:path'
import { loadIdentity, writeIdentity } from '../identity/loader.js'
import { CredentialVault } from '../credentials/vault.js'
import { CREDENTIAL_NAME_RE } from '../credentials/types.js'
import type { McpServerSpec } from '../identity/types.js'
import type { SecretRef } from '../secrets/types.js'

export class IdentityMutationError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'AGENT_NOT_FOUND'
      | 'DUPLICATE_SERVER_NAME'
      | 'INVALID_CREDENTIAL_NAME'
      | 'IO_ERROR',
  ) {
    super(message)
    this.name = 'IdentityMutationError'
  }
}

function identityPath(home: string, agentName: string): string {
  return join(home, 'agents', agentName, 'identity.md')
}

/**
 * Build the namespaced vault credential name for an env var from a
 * given skill. Each half is slugified independently (lowercase,
 * underscores → dashes, other non-slug chars → dashes, repeated
 * dashes collapsed, leading / trailing dashes stripped), then joined
 * with a literal `--` namespace separator. Throws if either half is
 * empty or if the joined slug fails `CREDENTIAL_NAME_RE`.
 */
export function credentialNameFor(skillSlug: string, envVarKey: string): string {
  const left = slugifyHalf(skillSlug)
  const right = slugifyHalf(envVarKey)
  if (left.length === 0 || right.length === 0) {
    throw new IdentityMutationError(
      `cannot derive a credential name from skill="${skillSlug}" env="${envVarKey}"`,
      'INVALID_CREDENTIAL_NAME',
    )
  }
  const slug = `${left}--${right}`
  if (!CREDENTIAL_NAME_RE.test(slug)) {
    throw new IdentityMutationError(
      `derived credential name "${slug}" does not match the required slug pattern`,
      'INVALID_CREDENTIAL_NAME',
    )
  }
  return slug
}

function slugifyHalf(input: string): string {
  return input
    .toLowerCase()
    .replace(/_/g, '-')
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

export interface StoreServerSecretsArgs {
  home: string
  agentName: string
  skillSlug: string
  /** Map of env-var-name → operator-supplied literal value. */
  env: Record<string, string>
}

/**
 * Write each supplied env value to the Agent's vault under a
 * namespaced credential name. Returns a `SecretRef` map keyed by the
 * original env var name so the caller can build an `McpServerSpec`.
 *
 * Idempotent: overwriting an existing credential is supported (the
 * vault's `set` is overwrite-on-write).
 */
export async function storeServerSecrets(
  args: StoreServerSecretsArgs,
): Promise<Record<string, SecretRef>> {
  const vault = new CredentialVault(args.home, args.agentName)
  const out: Record<string, SecretRef> = {}
  const createdAt = new Date().toISOString()
  for (const [envKey, value] of Object.entries(args.env)) {
    const credentialName = credentialNameFor(args.skillSlug, envKey)
    await vault.set(credentialName, {
      value,
      metadata: {
        created_at: createdAt,
        provider: `skill:${args.skillSlug}`,
        notes: `Set by skill install (${args.skillSlug}). Used for env var ${envKey}.`,
      },
    })
    out[envKey] = { source: 'vault', id: credentialName }
  }
  return out
}

export interface AppendMcpServerArgs {
  home: string
  agentName: string
  spec: McpServerSpec
}

/**
 * Append an MCP server entry to an Agent's Identity AND grant the
 * server's tool wildcard (`<server>.*`) in the identity's `tools[]`
 * array. Without the grant the Agent will not actually see the new
 * tools, since MCP-server-borne tools require explicit permission
 * (per `IdentityFrontmatterSchema.mcp_servers` docstring). The grant
 * is idempotent ... reinstall does not duplicate it.
 *
 * Throws if the Agent's identity.md is missing, if the Identity already
 * declares a server with the same name (`DUPLICATE_SERVER_NAME`), or if
 * the I/O fails. The identity file is rewritten atomically.
 */
export async function appendMcpServerToIdentity(args: AppendMcpServerArgs): Promise<void> {
  const path = identityPath(args.home, args.agentName)
  let identity
  try {
    identity = await loadIdentity(path)
  } catch (err) {
    throw new IdentityMutationError(
      `cannot load identity for "${args.agentName}": ${err instanceof Error ? err.message : String(err)}`,
      'AGENT_NOT_FOUND',
    )
  }
  for (const existing of identity.frontmatter.mcp_servers) {
    if (existing.name === args.spec.name) {
      throw new IdentityMutationError(
        `Agent "${args.agentName}" already declares an mcp_servers entry named "${args.spec.name}"`,
        'DUPLICATE_SERVER_NAME',
      )
    }
  }
  const wildcard = `${args.spec.name}.*`
  const tools = identity.frontmatter.tools.includes(wildcard)
    ? identity.frontmatter.tools
    : [...identity.frontmatter.tools, wildcard]
  const next = {
    ...identity.frontmatter,
    mcp_servers: [...identity.frontmatter.mcp_servers, args.spec],
    tools,
  }
  try {
    await writeIdentity(path, next, identity.body)
  } catch (err) {
    throw new IdentityMutationError(
      `failed to write identity for "${args.agentName}": ${err instanceof Error ? err.message : String(err)}`,
      'IO_ERROR',
    )
  }
}

export interface RemoveMcpServerArgs {
  home: string
  agentName: string
  serverName: string
}

/**
 * Remove an MCP server entry from an Agent's Identity. Returns true
 * if an entry was removed. Identity is rewritten atomically; the
 * associated vault entries are NOT touched (they may be shared with
 * other servers, and an explicit uninstall verb handles them).
 */
export async function removeMcpServerFromIdentity(args: RemoveMcpServerArgs): Promise<boolean> {
  const path = identityPath(args.home, args.agentName)
  let identity
  try {
    identity = await loadIdentity(path)
  } catch (err) {
    throw new IdentityMutationError(
      `cannot load identity for "${args.agentName}": ${err instanceof Error ? err.message : String(err)}`,
      'AGENT_NOT_FOUND',
    )
  }
  const before = identity.frontmatter.mcp_servers
  const after = before.filter((s) => s.name !== args.serverName)
  if (after.length === before.length) return false
  // Revoke any tool grants the install added (wildcard + any explicit
  // <server>.<verb> entries the operator may have added by hand). Keep
  // grants for tools whose namespace doesn't match this server.
  const wildcard = `${args.serverName}.*`
  const dotPrefix = `${args.serverName}.`
  const underscorePrefix = `${args.serverName}_`
  const filteredTools = identity.frontmatter.tools.filter((t) => {
    if (t === wildcard) return false
    if (t.startsWith(dotPrefix)) return false
    if (t.startsWith(underscorePrefix)) return false
    return true
  })
  try {
    await writeIdentity(
      path,
      { ...identity.frontmatter, mcp_servers: after, tools: filteredTools },
      identity.body,
    )
  } catch (err) {
    throw new IdentityMutationError(
      `failed to write identity for "${args.agentName}": ${err instanceof Error ? err.message : String(err)}`,
      'IO_ERROR',
    )
  }
  return true
}
