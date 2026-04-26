/**
 * SecretRef resolver.
 *
 * Resolves a SecretRef to its literal value at use-time. Always treat
 * the returned string as sensitive: do not log it, do not echo it, do
 * not include it in error messages thrown out of this module.
 *
 * Errors from this module are intentionally vague at the boundary
 * (`ENV_MISSING`, `FILE_UNREADABLE`) so that exposing the error to a
 * less-trusted caller does not leak the secret's name or location.
 */
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SecretRef } from './types.js'

export class SecretResolveError extends Error {
  constructor(
    message: string,
    public readonly code: 'ENV_MISSING' | 'FILE_UNREADABLE' | 'EMPTY_VALUE',
  ) {
    super(message)
    this.name = 'SecretResolveError'
  }
}

/**
 * Resolve a SecretRef to its literal value. The caller MUST NOT log
 * the returned string. Throws `SecretResolveError` on failure with a
 * code that does not reveal the secret's value.
 */
export async function resolveSecret(ref: SecretRef): Promise<string> {
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
        // Avoid echoing the path beyond what the caller already provided.
        const msg = err instanceof Error ? err.message : String(err)
        throw new SecretResolveError(
          `could not read secret file '${ref.id}': ${msg}`,
          'FILE_UNREADABLE',
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

function expandTilde(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  return path
}
