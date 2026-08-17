/**
 * Access-mode configuration (Epic 19).
 *
 * How this instance is reachable, chosen at first-run and changeable in
 * Settings:
 *
 *   - `cloud`     ... a Cloudflare Tunnel fronts a `{name}.<domain>` hostname
 *                     with real HTTPS; the web server binds loopback (the tunnel
 *                     is the only ingress). The default we steer operators to.
 *   - `local`     ... plain HTTP on the LAN (`0.0.0.0`). Opt-in; the tinkerer /
 *                     trusted-network / offline path.
 *   - `tailscale` ... reachable over the operator's tailnet; the web server
 *                     binds loopback and `tailscale serve` proxies to it.
 *
 * Persisted at `<home>/config/access.json`. The provisioned tunnel token is a
 * secret and lives in the sealed instance-secret store, NOT here; the hostname
 * is not secret and is recorded here for display + revoke.
 */
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { atomicWriteFile } from '../util/atomic-write.js'
import { homePaths } from '../storage/layout.js'

export const ACCESS_MODES = ['cloud', 'local', 'tailscale'] as const
export type AccessMode = (typeof ACCESS_MODES)[number]

const AccessConfigSchema = z.object({
  schema_version: z.literal(1),
  mode: z.enum(ACCESS_MODES),
  /** Provisioned tunnel hostname (cloud mode) or null until claimed. */
  hostname: z.string().nullable().default(null),
})
export type AccessConfig = z.infer<typeof AccessConfigSchema>

/** The default when nothing is configured yet. Local so a fresh box works with
 * zero external dependencies until the operator opts into the tunnel. */
export const DEFAULT_ACCESS_CONFIG: AccessConfig = {
  schema_version: 1,
  mode: 'local',
  hostname: null,
}

export function accessConfigPath(home: string): string {
  return join(homePaths(home).config, 'access.json')
}

/** Read the access config, or the default if none is written yet. */
export async function readAccessConfig(home: string): Promise<AccessConfig> {
  let raw: string
  try {
    raw = await readFile(accessConfigPath(home), 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ...DEFAULT_ACCESS_CONFIG }
    throw err
  }
  return AccessConfigSchema.parse(JSON.parse(raw))
}

export async function writeAccessConfig(
  home: string,
  config: Omit<AccessConfig, 'schema_version'>,
): Promise<void> {
  const path = accessConfigPath(home)
  await mkdir(dirname(path), { recursive: true })
  const full: AccessConfig = { schema_version: 1, mode: config.mode, hostname: config.hostname }
  await atomicWriteFile(path, JSON.stringify(full, null, 2))
}

/**
 * The address the web server should bind for a given access mode.
 *
 *   - cloud / tailscale → `127.0.0.1`: the tunnel (or `tailscale serve`) is the
 *     only ingress, so nothing is exposed on the LAN and the bearer never
 *     crosses it in cleartext.
 *   - local → `0.0.0.0`: reachable on the LAN by design (the opt-in mode).
 *
 * Pure so the bind decision is unit-testable and can't drift between the picker
 * and the supervisor.
 */
export function webBindHostForMode(mode: AccessMode): string {
  return mode === 'local' ? '0.0.0.0' : '127.0.0.1'
}
