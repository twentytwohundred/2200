/**
 * SCUT-side configuration (Epic 4 Phase A PR F).
 *
 * Lives at `<2200_HOME>/config/scut.json`. Carries the on-chain
 * config the supervisor's identity-provisioning pipeline needs:
 * RPC URL, chain id, SII contract address, the seed-team wallet's
 * address (for sanity check) and a SecretRef pointing at the
 * wallet's private key (env-var or file).
 *
 * Defaults are the locked Base mainnet values per the Phase A
 * v0.3 spec; operators with a private RPC (Alchemy / QuickNode /
 * own Base node) override `rpc_url`.
 */
import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { homePaths } from '../storage/layout.js'
import { join } from 'node:path'

export const SCUT_CONFIG_SCHEMA_VERSION = 1

const SecretRefSchema = z.object({
  source: z.enum(['env', 'file']),
  id: z.string().min(1),
})
export type SecretRef = z.infer<typeof SecretRefSchema>

export const ScutConfigSchema = z.object({
  schema_version: z.literal(1),
  /** Base RPC URL. Default: https://mainnet.base.org (load-balanced; consider a dedicated endpoint at scale). */
  rpc_url: z.string().min(1).default('https://mainnet.base.org'),
  /** Chain id. Locked at 8453 (Base mainnet) in v1. */
  chain_id: z.number().int().positive().default(8453),
  /** SII contract address. Locked per Garfield's 2026-04-28 confirmation. */
  contract_address: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/)
    .default('0x199b48E27a28881502b251B0068F388Ce750feff'),
  /** Public wallet address. Used for sanity-check vs the resolved private key. */
  wallet_address: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  /** SecretRef for the wallet private key. Same shape as Identity.provider_secret. */
  wallet_private_key: SecretRefSchema,
  /** Override poll interval between ownerOf() consistency checks. */
  ownerof_poll_interval_ms: z.number().int().positive().optional(),
  /** Cap on ownerOf attempts before giving up. */
  ownerof_poll_max_attempts: z.number().int().positive().optional(),
})
export type ScutConfig = z.infer<typeof ScutConfigSchema>

export class ScutConfigError extends Error {}

/**
 * Resolve the absolute path to `<home>/config/scut.json`.
 */
export function scutConfigPath(home: string): string {
  return join(homePaths(home).config, 'scut.json')
}

/**
 * Load the SCUT config for an instance. Throws ScutConfigError if
 * the file is missing or malformed; the CLI surfaces the message
 * with a hint to run a future `2200 init --scut` setup helper.
 */
export async function loadScutConfig(home: string): Promise<ScutConfig> {
  const path = scutConfigPath(home)
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ScutConfigError(
        `SCUT config not found at ${path}. Create it with the locked Base mainnet defaults plus your wallet address and private-key SecretRef.`,
      )
    }
    throw err
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch (err) {
    throw new ScutConfigError(
      `SCUT config at ${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  const result = ScutConfigSchema.safeParse(parsed)
  if (!result.success) {
    throw new ScutConfigError(
      `SCUT config at ${path} fails schema validation: ${JSON.stringify(result.error.issues)}`,
    )
  }
  return result.data
}

/**
 * Resolve a SecretRef to a string. v1 supports `env` (reads
 * process.env[id]) and `file` (reads the file at `id`, trims).
 */
export async function resolveSecret(ref: SecretRef): Promise<string> {
  if (ref.source === 'env') {
    const value = process.env[ref.id]
    if (!value) {
      throw new ScutConfigError(
        `secret env var "${ref.id}" is not set or empty in the supervisor environment`,
      )
    }
    return value
  }
  // ref.source === 'file'
  const text = await readFile(ref.id, 'utf8')
  const trimmed = text.trim()
  if (trimmed.length === 0) {
    throw new ScutConfigError(`secret file "${ref.id}" is empty`)
  }
  return trimmed
}
