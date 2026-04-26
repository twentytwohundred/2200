/**
 * User config load/save.
 *
 * Resolves `2200_HOME` according to the precedence in
 * [[2026-04-26-commons-and-storage-root]]:
 *
 *   1. `--home <path>` CLI flag (highest)
 *   2. `TWENTYTWOHUNDRED_HOME` env var
 *   3. `$XDG_CONFIG_HOME/2200/config.json` -> `home` field
 *   4. Default: `$XDG_DATA_HOME/2200/` (`~/.local/share/2200/`)
 *
 * The `2200 init --home <path>` command writes the config file with the
 * user-chosen home; subsequent CLI invocations read it.
 *
 * Atomic writes via the existing util so a partial write never leaves a
 * torn config file on disk.
 */
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { atomicWriteJson } from '../util/atomic-write.js'
import { mkdir } from 'node:fs/promises'
import { UserConfigSchema, type UserConfig } from './types.js'

/** XDG-style config directory for 2200. */
export function userConfigDir(): string {
  const xdg = process.env['XDG_CONFIG_HOME']
  if (xdg && xdg.length > 0) return join(xdg, '2200')
  return join(homedir(), '.config', '2200')
}

/** XDG-style data directory; default for 2200_HOME when unspecified. */
export function defaultHome(): string {
  const xdg = process.env['XDG_DATA_HOME']
  if (xdg && xdg.length > 0) return join(xdg, '2200')
  return join(homedir(), '.local', 'share', '2200')
}

export function userConfigPath(): string {
  return join(userConfigDir(), 'config.json')
}

/**
 * Resolve `2200_HOME` against the precedence above. The optional
 * `cliHome` is the value passed via `--home` on the CLI.
 */
export async function resolveHome(cliHome?: string): Promise<string> {
  if (cliHome && cliHome.length > 0) return cliHome
  const envHome = process.env['TWENTYTWOHUNDRED_HOME']
  if (envHome && envHome.length > 0) return envHome
  const config = await tryLoadUserConfig()
  if (config) return config.home
  return defaultHome()
}

/** Load the user config file, returning null if it does not exist. */
export async function tryLoadUserConfig(): Promise<UserConfig | null> {
  let raw: string
  try {
    raw = await readFile(userConfigPath(), 'utf8')
  } catch (err) {
    if (isNodeNotFoundError(err)) return null
    throw err
  }
  const parsed = JSON.parse(raw) as unknown
  const result = UserConfigSchema.safeParse(parsed)
  if (!result.success) {
    throw new Error(
      `2200 user config at ${userConfigPath()} fails schema validation: ${JSON.stringify(result.error.issues)}`,
    )
  }
  return result.data
}

/** Write the user config file, creating its parent dir if needed. */
export async function saveUserConfig(config: UserConfig): Promise<void> {
  await mkdir(userConfigDir(), { recursive: true })
  await atomicWriteJson(userConfigPath(), config)
}

function isNodeNotFoundError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT'
}
