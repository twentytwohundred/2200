/**
 * Runtime mode flag.
 *
 * Per [[../../wiki/decisions/2026-05-05-managed-service]] and the
 * follow-up convention [[../../wiki/conventions/security-architecture-hosted-mode]],
 * 2200 ships in three deployment tiers:
 *
 *   - **self-hosted**: Tier 1. The user owns the host, brings their
 *     own LLM keys, has full trust over the host environment. Default
 *     for any locally-installed instance.
 *   - **hosted-byok**: Tier 2. We host the runtime; the user brings
 *     their own LLM API keys. Hosted environment, but the user's
 *     credentials still pass through their instance to the LLM
 *     provider.
 *   - **hosted-managed**: Tier 3. We host the runtime AND manage the
 *     LLM provider relationships. The user's instance has NO direct
 *     access to provider keys; LLM calls route through the 2200
 *     proxy.
 *
 * v1 ships only `self-hosted` as a real deployment. The other two
 * values are accepted by the parser so the substrate is in place for
 * Epic 17, and so that a hosted instance reading the flag at startup
 * can branch on it (system-prompt clarification, proxy provider
 * binding, starter-inference rate limits) without a runtime
 * substrate change.
 *
 * Resolution order at startup:
 *   1. Explicit constructor argument (highest priority; tests use this).
 *   2. `TWENTYTWOHUNDRED_RUNTIME_MODE` env var.
 *   3. Default: `self-hosted`.
 */

export const RUNTIME_MODES = ['self-hosted', 'hosted-byok', 'hosted-managed'] as const
export type RuntimeMode = (typeof RUNTIME_MODES)[number]

export const DEFAULT_RUNTIME_MODE: RuntimeMode = 'self-hosted'

/** Env var consulted at startup. */
export const RUNTIME_MODE_ENV_VAR = 'TWENTYTWOHUNDRED_RUNTIME_MODE'

export class RuntimeModeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RuntimeModeError'
  }
}

/**
 * Parse a string into a RuntimeMode. Returns the default when input
 * is undefined or empty. Throws RuntimeModeError on an unknown value
 * so a typo in env config fails loud at startup rather than silently
 * defaulting.
 */
export function parseRuntimeMode(value: string | undefined): RuntimeMode {
  if (value === undefined || value.length === 0) return DEFAULT_RUNTIME_MODE
  if ((RUNTIME_MODES as readonly string[]).includes(value)) {
    return value as RuntimeMode
  }
  throw new RuntimeModeError(
    `unknown runtime mode "${value}"; expected one of: ${RUNTIME_MODES.join(', ')}`,
  )
}

/**
 * Resolve the runtime mode from env. Pass `process.env` (or a stub
 * in tests). Throws on invalid values; returns DEFAULT_RUNTIME_MODE
 * when the env var is missing or empty.
 */
export function resolveRuntimeMode(env: Record<string, string | undefined>): RuntimeMode {
  return parseRuntimeMode(env[RUNTIME_MODE_ENV_VAR])
}

/**
 * True when the runtime is in a managed-tokens deployment (Tier 3).
 * The proxy + system-prompt clarification + starter-inference path
 * all gate on this; pure helper for readability at call sites.
 */
export function isHostedManaged(mode: RuntimeMode): boolean {
  return mode === 'hosted-managed'
}

/**
 * True when the runtime is hosted by us (Tier 2 OR Tier 3). Some
 * decisions apply to both hosted tiers (per-tenant container
 * isolation, central audit logging) but not to Tier 1 (where the
 * user owns the trust boundary).
 */
export function isHosted(mode: RuntimeMode): boolean {
  return mode === 'hosted-byok' || mode === 'hosted-managed'
}
