/**
 * Extension manifest types (Epic 12 Phase A).
 *
 * Extensions are installable capability bundles that go beyond what
 * Skills can do. They have state, schedule, multi-Agent coordination,
 * UI surface, tools, lifecycle hooks, permissions, and versioning.
 *
 * The manifest is a JSON file at:
 *   <home>/extensions/<extension_name>/manifest.json
 *
 * Phase A scope (this file + registry.ts + CLI):
 *   - Schema definition (Zod) for manifest validation.
 *   - Read-only registry: scan <home>/extensions and list installed
 *     extensions.
 *   - CLI: list + show (no install / uninstall yet ... those land in
 *     Phase B with the actual lifecycle hook execution).
 *
 * Phase B brings install / uninstall, lifecycle hooks, state storage,
 * scheduler integration, and the permissions prompt at install time.
 *
 * Phase C brings UI rendering hooks for the web app + version-aware
 * migrations on update.
 */
import { z } from 'zod'

/**
 * Extension manifest version. Bump on breaking schema changes.
 * Migrators land at src/runtime/extensions/migrators/<from>-to-<to>.ts
 * once the format starts evolving.
 */
export const EXTENSION_SCHEMA_VERSION = 1 as const

/**
 * Permission categories. An Extension declares the categories it
 * needs at install time; the user explicitly approves each one
 * before the install completes.
 *
 * - `tools`        register MCP servers / built-in tools the Agent can call.
 * - `brain.read`   read any Agent's brain.
 * - `brain.write`  write to any Agent's brain (dangerous; rarely needed).
 * - `notifications` emit notifications to the user.
 * - `schedule`    register cron-style timers.
 * - `pub.read`    read pub messages.
 * - `pub.send`    send pub messages.
 * - `network`     make outbound HTTP calls beyond the registered tool MCP servers.
 * - `fs.scratch`  read/write inside the Extension's own scratch directory.
 *
 * The list is closed: an Extension cannot invent a new category. If
 * a new capability surfaces, the manifest schema bumps and the runtime
 * declares the new permission.
 */
export const ExtensionPermissionSchema = z.enum([
  'tools',
  'brain.read',
  'brain.write',
  'notifications',
  'schedule',
  'pub.read',
  'pub.send',
  'network',
  'fs.scratch',
])
export type ExtensionPermission = z.infer<typeof ExtensionPermissionSchema>

/**
 * Schedule entry an Extension declares. The runtime registers these
 * on install and unregisters on uninstall. Cron-style scheduling
 * is rooted in the Extension's name + an optional id; the resulting
 * job key is `extension:<name>:<id>`.
 */
export const ExtensionScheduleSchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9-]*$/, {
      message: 'schedule id must be lowercase alphanumeric/dashes, starting with a letter or digit',
    }),
  cron: z.string().min(1),
  /** Optional human description for `2200 extension show`. */
  description: z.string().optional(),
})
export type ExtensionSchedule = z.infer<typeof ExtensionScheduleSchema>

/**
 * Tool the Extension registers. Phase A v1: just the name (a
 * provider-prefixed wildcard or exact name from the tool registry).
 * Phase B can extend with config knobs.
 */
export const ExtensionToolSchema = z.object({
  name: z.string().min(1),
  /** Optional human description for `2200 extension show`. */
  description: z.string().optional(),
})
export type ExtensionTool = z.infer<typeof ExtensionToolSchema>

/**
 * Extension manifest (the JSON shape on disk).
 *
 * Naming rules:
 *   - `name` matches `^[a-z][a-z0-9-]*$` (slug). Used in paths and CLI args.
 *   - `version` is semver (validated as a regex; we don't enforce
 *     full semver semantics at v1).
 *   - `author` is freeform.
 *
 * Compatibility commitments:
 *   - Adding fields: non-breaking. The Zod parser drops unknown fields
 *     by default, and the migrator chain handles older schemas.
 *   - Removing or renaming fields: bumps `schema_version`.
 */
export const ExtensionManifestSchema = z.object({
  schema_version: z.literal(EXTENSION_SCHEMA_VERSION),
  name: z.string().regex(/^[a-z][a-z0-9-]*$/, {
    message:
      'name must be a slug starting with a lowercase letter; lowercase + digits + dashes only',
  }),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/, {
    message: 'version must be semver (e.g. 0.1.0, 1.2.3-beta.4)',
  }),
  display_name: z.string().min(1),
  description: z.string().min(1),
  author: z.string().min(1),
  /** Optional homepage / repo URL. Surfaced in `2200 extension show`. */
  homepage: z.url().optional(),
  /** Permissions the Extension requires. Empty array = pure-data ext. */
  permissions: z.array(ExtensionPermissionSchema).default([]),
  /** Schedules the Extension registers. Empty array = no scheduled jobs. */
  schedules: z.array(ExtensionScheduleSchema).default([]),
  /** Tools the Extension registers. Empty array = no tools. */
  tools: z.array(ExtensionToolSchema).default([]),
  /**
   * Optional lifecycle hooks. Each is a relative path to a script
   * inside the Extension's directory. Phase A reads them but does
   * not execute; Phase B wires execution.
   */
  hooks: z
    .object({
      install: z.string().optional(),
      uninstall: z.string().optional(),
      update: z.string().optional(),
    })
    .default({}),
})
export type ExtensionManifest = z.infer<typeof ExtensionManifestSchema>

/**
 * Validation helper. Wraps ZodError so the CLI / supervisor can
 * surface a clean message.
 */
export class ExtensionManifestError extends Error {
  constructor(
    public readonly path: string,
    message: string,
  ) {
    super(`Extension manifest at ${path}: ${message}`)
    this.name = 'ExtensionManifestError'
  }
}

/**
 * Parse + validate a raw manifest object. Throws ExtensionManifestError
 * on schema failure. The path is included for error context (the file
 * the manifest was loaded from); pass an empty string when validating
 * an in-memory object.
 */
export function validateManifest(value: unknown, path: string): ExtensionManifest {
  const result = ExtensionManifestSchema.safeParse(value)
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n')
    throw new ExtensionManifestError(path, `\n${issues}`)
  }
  return result.data
}
