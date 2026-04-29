/**
 * SecretRef resolver.
 *
 * Resolves a SecretRef to its literal value at use-time. Always treat
 * the returned string as sensitive: do not log it, do not echo it, do
 * not include it in error messages thrown out of this module.
 *
 * Errors from this module are intentionally vague at the boundary
 * (`ENV_MISSING`, `FILE_UNREADABLE`, `VAULT_MISS`) so that exposing the
 * error to a less-trusted caller does not leak the secret's name or
 * location.
 */
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { CredentialVault } from '../credentials/vault.js'
import { CredentialVaultError } from '../credentials/types.js'
import type { SecretRef } from './types.js'

export class SecretResolveError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'ENV_MISSING'
      | 'FILE_UNREADABLE'
      | 'EMPTY_VALUE'
      | 'VAULT_MISCONFIGURED'
      | 'VAULT_MISS',
  ) {
    super(message)
    this.name = 'SecretResolveError'
  }
}

/**
 * Context for resolving SecretRefs. The `home` + optional `agentName`
 * are used by the `vault` source to open the per-Agent credential
 * vault. `env` and `file` sources ignore the context.
 */
export interface SecretResolveContext {
  home: string
  /** Default Agent for vault refs that omit the `<agent>:` prefix. */
  agentName?: string
}

/**
 * Resolve a SecretRef to its literal value. The caller MUST NOT log
 * the returned string. Throws `SecretResolveError` on failure with a
 * code that does not reveal the secret's value.
 *
 * The `vault` source requires a context (`{ home, agentName? }`).
 * The `env` and `file` sources ignore the context.
 */
export async function resolveSecret(ref: SecretRef, ctx?: SecretResolveContext): Promise<string> {
  let raw: string
  switch (ref.source) {
    case 'env': {
      const value = process.env[ref.id]
      if (value === undefined) {
        throw new SecretResolveError(`env var '${ref.id}' is not set`, 'ENV_MISSING')
      }
      raw = value
      break
    }
    case 'file': {
      const path = expandTilde(ref.id)
      try {
        raw = await readFile(path, 'utf8')
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        throw new SecretResolveError(
          `could not read secret file '${ref.id}': ${msg}`,
          'FILE_UNREADABLE',
        )
      }
      break
    }
    case 'vault': {
      if (!ctx) {
        throw new SecretResolveError(
          `vault SecretRef requires a context with { home }`,
          'VAULT_MISCONFIGURED',
        )
      }
      const { agent, credential } = parseVaultId(ref.id, ctx.agentName)
      const vault = new CredentialVault(ctx.home, agent)
      try {
        const entry = await vault.get(credential)
        raw = entry.value
      } catch (err) {
        if (err instanceof CredentialVaultError && err.code === 'NOT_FOUND') {
          throw new SecretResolveError(`vault credential '${ref.id}' not found`, 'VAULT_MISS')
        }
        throw new SecretResolveError(
          `could not resolve vault credential '${ref.id}'`,
          'VAULT_MISCONFIGURED',
        )
      }
      break
    }
  }
  const trimmed = raw.trim()
  if (trimmed.length === 0) {
    throw new SecretResolveError(`secret '${ref.id}' resolved to an empty value`, 'EMPTY_VALUE')
  }
  return trimmed
}

/**
 * Parse a vault SecretRef id of the form `<credential>` or
 * `<agent>:<credential>`. The bare form requires a default agent in
 * the context; the prefixed form overrides it.
 */
function parseVaultId(
  id: string,
  defaultAgent: string | undefined,
): { agent: string; credential: string } {
  const colon = id.indexOf(':')
  if (colon === -1) {
    if (!defaultAgent) {
      throw new SecretResolveError(
        `vault SecretRef '${id}' has no agent prefix and the resolver context provides no default Agent`,
        'VAULT_MISCONFIGURED',
      )
    }
    return { agent: defaultAgent, credential: id }
  }
  const agent = id.slice(0, colon)
  const credential = id.slice(colon + 1)
  if (!agent || !credential) {
    throw new SecretResolveError(
      `vault SecretRef '${id}' is malformed; expected '<agent>:<credential>' or '<credential>'`,
      'VAULT_MISCONFIGURED',
    )
  }
  return { agent, credential }
}

function expandTilde(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  return path
}
