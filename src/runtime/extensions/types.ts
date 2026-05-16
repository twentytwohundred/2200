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
 * - `brain_read`   read any Agent's brain.
 * - `brain_write`  write to any Agent's brain (dangerous; rarely needed).
 * - `notifications` emit notifications to the user.
 * - `schedule`    register cron-style timers.
 * - `pub_read`    read pub messages.
 * - `pub_send`    send pub messages.
 * - `network`     make outbound HTTP calls beyond the registered tool MCP servers.
 * - `fs.scratch`  read/write inside the Extension's own scratch directory.
 *
 * The list is closed: an Extension cannot invent a new category. If
 * a new capability surfaces, the manifest schema bumps and the runtime
 * declares the new permission.
 */
export const ExtensionPermissionSchema = z.enum([
  'tools',
  'brain_read',
  'brain_write',
  'notifications',
  'schedule',
  'pub_read',
  'pub_send',
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
 * Connector block (Extensions that integrate a messaging platform).
 *
 * Connectors are a specialization of Extensions: WhatsApp, Slack,
 * Discord, Telegram, etc. They run a long-lived gateway process,
 * receive inbound platform events, and route them to Agents whose
 * Identity declares a binding to the connector. See
 * [[../decisions/2026-05-16-connector-extensions]].
 *
 * Extensions that declare a `connector` block surface in the Connector
 * Store and use the `hooks.gateway` lifecycle. Extensions without one
 * are ordinary Extensions.
 */
export const ConnectorAuthModelSchema = z.enum(['qr_pair', 'oauth', 'bot_token', 'api_key'])
export type ConnectorAuthModel = z.infer<typeof ConnectorAuthModelSchema>

export const ConnectorManifestBlockSchema = z.object({
  /** Stable id used by Agent Identity bindings (e.g. 'whatsapp', 'slack'). */
  id: z
    .string()
    .min(1)
    .regex(/^[a-z][a-z0-9_]*$/, {
      message:
        'connector id must be lowercase letter followed by lowercase letters / digits / underscores',
    }),
  /** Display label for the Connector Store + status UIs. */
  label: z.string().min(1),
  /** One-line description shown in the Store list view. */
  blurb: z.string().min(1),
  /** Docs path relative to the wiki, surfaced as a link in the Store + install flow. */
  docs_path: z.string().optional(),
  /** Auth model the operator will see at install time. */
  auth_model: ConnectorAuthModelSchema,
  /**
   * ToS-acknowledgment string the user must explicitly agree to at install
   * time. Surfaced verbatim by the install flow. The Baileys-backed
   * WhatsApp connector uses this to surface the unofficial-client note.
   */
  tos_acknowledgment: z.string().optional(),
})
export type ConnectorManifestBlock = z.infer<typeof ConnectorManifestBlockSchema>

/**
 * Gateway lifecycle hook (Extension grows a long-lived child process).
 *
 * The supervisor spawns the gateway script when the Extension is
 * installed AND at least one Agent declares a binding to the
 * connector's `id`. Restart policy controls supervisor behavior when
 * the gateway exits.
 */
export const GatewayRestartPolicySchema = z.enum(['always', 'on_demand'])
export type GatewayRestartPolicy = z.infer<typeof GatewayRestartPolicySchema>

export const GatewayHookSchema = z.object({
  /** Relative path to the gateway entry script inside the Extension dir. */
  script: z.string().min(1),
  /**
   * `always`: respawn whenever the process exits (with a small budget).
   * `on_demand`: spawn only when an inbound or outbound request lands,
   *  exit on idle. Use `always` for socket-based gateways (WhatsApp,
   *  Discord); `on_demand` is reserved for poll-based gateways that
   *  don't need a persistent connection.
   */
  restart_policy: GatewayRestartPolicySchema.default('always'),
})
export type GatewayHook = z.infer<typeof GatewayHookSchema>

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
   * inside the Extension's directory.
   *
   * - `install` / `uninstall` / `update`: Phase B substrate. Run on
   *   the corresponding lifecycle verb.
   * - `tick`: Phase B-2. Runs on every Extension schedule fire (one
   *   tick per schedule). Receives `EXTENSION_SCHEDULE_ID` in env so
   *   the script can branch on which schedule fired. See
   *   [[../decisions/2026-05-06-extension-schedules-fire-tick-hook]].
   */
  hooks: z
    .object({
      install: z.string().optional(),
      uninstall: z.string().optional(),
      update: z.string().optional(),
      tick: z.string().optional(),
      /**
       * Long-lived child process spawned when the Extension is
       * installed AND at least one Agent declares a binding to the
       * connector's id. Used by connector Extensions. See
       * [[../decisions/2026-05-16-connector-extensions]].
       */
      gateway: GatewayHookSchema.optional(),
    })
    .default({}),
  /**
   * Optional connector block. Extensions that declare this surface in
   * the Connector Store and are eligible to be bound from Agent
   * Identity frontmatter. See [[../decisions/2026-05-16-connector-extensions]].
   */
  connector: ConnectorManifestBlockSchema.optional(),
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
