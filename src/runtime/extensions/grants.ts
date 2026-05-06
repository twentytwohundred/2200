/**
 * Extension permission grants (Epic 12 Phase B).
 *
 * When a user installs an Extension, they explicitly approve each
 * permission the manifest declares. The set of approved permissions
 * is recorded here and consulted at runtime when:
 *
 *   - the hook executor builds the capability-derived env (e.g.,
 *     `fs.scratch` exposes `EXTENSION_SCRATCH_DIR` only when granted)
 *   - the supervisor decides whether to register the Extension's
 *     declared tools (`tools` permission) or schedules (`schedule`
 *     permission) when those land in the next sub-phase
 *   - any future runtime gate consults the grant set rather than
 *     trusting the manifest at face value
 *
 * Storage: `<home>/state/extensions/<name>/grants.json`. One file per
 * Extension. Atomic writes. The directory is created lazily; readers
 * tolerate a missing file (returns the empty grant set). Removal of
 * the grants file accompanies uninstall.
 *
 * Grants are append-only across an install session: an `update` that
 * introduces new permissions adds them after a fresh prompt; an
 * `update` that removes a permission from the manifest leaves the old
 * grant on disk (the runtime never silently grants something the user
 * did not approve, so a stale grant is harmless until reused). The
 * runtime always intersects manifest-declared permissions with the
 * persisted grant set when deciding what the Extension can do.
 */
import { readFile } from 'node:fs/promises'
import { mkdir } from 'node:fs/promises'
import { atomicWriteJson } from '../util/atomic-write.js'
import { dirname } from 'node:path'
import { z } from 'zod'
import { ExtensionPermissionSchema, type ExtensionPermission } from './types.js'
import { extensionStatePaths } from '../storage/layout.js'

export const EXTENSION_GRANTS_SCHEMA_VERSION = 1 as const

export const ExtensionGrantsSchema = z.object({
  schema_version: z.literal(EXTENSION_GRANTS_SCHEMA_VERSION),
  /** Slug of the Extension these grants belong to. Mirrors the dir name. */
  name: z.string().min(1),
  /** ISO timestamp grants were last written. */
  granted_at: z.string().min(1),
  /**
   * Permissions the user has approved. Sorted on write for stable
   * diffs; readers do not depend on order.
   */
  permissions: z.array(ExtensionPermissionSchema),
})
export type ExtensionGrants = z.infer<typeof ExtensionGrantsSchema>

export class ExtensionGrantsError extends Error {
  constructor(
    public readonly path: string,
    message: string,
  ) {
    super(`Extension grants at ${path}: ${message}`)
    this.name = 'ExtensionGrantsError'
  }
}

/**
 * Read the grants file. Missing file → empty grant set (the
 * Extension was installed before grants persistence existed, or the
 * file was hand-removed). Malformed JSON / schema → throw, callers
 * decide whether to halt or rebuild grants.
 */
export async function readGrants(home: string, name: string): Promise<ExtensionGrants> {
  const path = extensionStatePaths(home, name).grants
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        schema_version: EXTENSION_GRANTS_SCHEMA_VERSION,
        name,
        granted_at: new Date(0).toISOString(),
        permissions: [],
      }
    }
    throw err
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new ExtensionGrantsError(
      path,
      `invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  const result = ExtensionGrantsSchema.safeParse(parsed)
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n')
    throw new ExtensionGrantsError(path, `\n${issues}`)
  }
  if (result.data.name !== name) {
    throw new ExtensionGrantsError(
      path,
      `grants name "${result.data.name}" does not match directory "${name}"`,
    )
  }
  return result.data
}

/**
 * Write the grants file atomically. Creates the parent directory if
 * absent. Permissions are sorted before write so the file is diff-
 * friendly across install / update.
 */
export async function writeGrants(
  home: string,
  name: string,
  permissions: readonly ExtensionPermission[],
  now: () => Date = () => new Date(),
): Promise<ExtensionGrants> {
  const path = extensionStatePaths(home, name).grants
  await mkdir(dirname(path), { recursive: true })
  const entry: ExtensionGrants = {
    schema_version: EXTENSION_GRANTS_SCHEMA_VERSION,
    name,
    granted_at: now().toISOString(),
    permissions: [...new Set(permissions)].sort(),
  }
  await atomicWriteJson(path, entry)
  return entry
}

/**
 * The intersection check the runtime uses to decide whether an
 * Extension can act on a manifest-declared permission. An Extension
 * cannot escalate at runtime; manifest declarations and persisted
 * grants must both agree.
 */
export function hasGrant(grants: ExtensionGrants, permission: ExtensionPermission): boolean {
  return grants.permissions.includes(permission)
}
