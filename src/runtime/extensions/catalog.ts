/**
 * Extension catalog types + loader.
 *
 * The catalog is a curated JSON document that lists installable
 * Extensions for browsing in the Store. For dev, the supervisor
 * serves an in-repo file (`extensions-catalog/v1.json`); for
 * production, 2200.ai hosts the same shape behind a CDN and the
 * supervisor fetches it.
 *
 * Decision: [[../../decisions/2026-05-16-connector-store]].
 */
import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import {
  ConnectorAccountScopeSchema,
  ConnectorAuthModelSchema,
  ExtensionPermissionSchema,
} from './types.js'

/**
 * How the supervisor's installer resolves the Extension's code.
 *
 * - `workspace`: dev mode. `path` is repo-relative; the installer
 *   copies the directory contents to <home>/extensions/<id>/.
 * - `npm`: production. The installer `pnpm install` the package at
 *   the locked version, verifies the tarball's sha256 against
 *   `sha256`, then runs install.
 */
export const CatalogSourceSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('workspace'),
    path: z.string().min(1),
  }),
  z.object({
    type: z.literal('npm'),
    package: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/, 'sha256 must be 64 hex chars'),
  }),
])
export type CatalogSource = z.infer<typeof CatalogSourceSchema>

export const CatalogCategorySchema = z.enum(['connector', 'voice', 'skill', 'model_provider'])
export type CatalogCategory = z.infer<typeof CatalogCategorySchema>

export const CatalogEntrySchema = z.object({
  /** Stable id; matches the Extension manifest's `name` (and `connector.id` if a connector). */
  id: z
    .string()
    .min(1)
    .regex(/^[a-z][a-z0-9-]*$/, 'id must be a slug starting with a lowercase letter'),
  /** Display label for the Store card. */
  label: z.string().min(1),
  /** Two-to-three-sentence blurb shown on the Store card. */
  blurb: z.string().min(1),
  /** Icon URL (PNG/SVG). Null = use a category default. */
  icon: z.string().nullable(),
  /** Which family of Extension this is. Drives which Store tab it shows on. */
  category: CatalogCategorySchema,
  /** Auth model the Store flow dispatches off (connectors only; null for non-connectors). */
  auth_model: ConnectorAuthModelSchema.nullable(),
  /**
   * Identity scope for connectors: 'extension' = pair-once-bind-to-Agent
   * (WhatsApp Inbox); 'agent' = each Agent has its own bot identity
   * (Discord, Telegram, Slack). Null for non-connector Extensions.
   * Default 'extension' for backwards-compat with the catalog v1.
   */
  account_scope: ConnectorAccountScopeSchema.nullable().default('extension'),
  /** Permissions the Extension declares; shown in the install modal. */
  permissions: z.array(ExtensionPermissionSchema),
  /** ToS acknowledgment surfaced verbatim at install time. */
  tos_acknowledgment: z.string().optional(),
  /** Link to detailed docs. */
  docs_url: z.string().optional(),
  /** Marketing screenshots; URLs. */
  screenshots: z.array(z.string()).default([]),
  /** Pinned version users get on a fresh install. */
  current_version: z.string().regex(/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/, 'must be semver'),
  /** Runtime version gate. */
  min_2200_version: z.string().optional(),
  /** How the installer fetches the code. */
  source: CatalogSourceSchema,
})
export type CatalogEntry = z.infer<typeof CatalogEntrySchema>

export const CatalogSchema = z.object({
  schema_version: z.literal(1),
  generated_at: z.string().min(1),
  extensions: z.array(CatalogEntrySchema),
})
export type Catalog = z.infer<typeof CatalogSchema>

/**
 * Load and validate the catalog from disk. Throws with a clear
 * message on schema failure; the supervisor surfaces that as a 500.
 */
export async function loadCatalog(path: string): Promise<Catalog> {
  const text = await readFile(path, 'utf-8')
  const json = JSON.parse(text) as unknown
  const result = CatalogSchema.safeParse(json)
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n')
    throw new Error(`catalog at ${path} is invalid:\n${issues}`)
  }
  return result.data
}
