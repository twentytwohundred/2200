/**
 * Identity loader.
 *
 * Reads `<identity>.md`, splits frontmatter from body, parses YAML
 * frontmatter, runs the migrator chain (so older `schema_version`
 * artifacts are upgraded to the current shape on read), and validates
 * against the Zod schema. Returns a fully-typed `IdentityRecord`.
 *
 * Errors are deliberately specific: the Agent's Identity is
 * security-sensitive (it declares which model, which tools, which
 * credentials). A bad Identity should fail loud at create time, not
 * at first use.
 */
import { readFile } from 'node:fs/promises'
import { resolve as resolvePath } from 'node:path'
import * as YAML from 'yaml'
import {
  IdentityFrontmatterSchema,
  type IdentityFrontmatter,
  type IdentityRecord,
} from './types.js'
import { migrateToCurrent } from './migrators/index.js'

/**
 * Load an Identity file. Throws `IdentityParseError` with a descriptive
 * message on any failure (file not found, missing frontmatter, malformed
 * YAML, schema mismatch, unsupported version with no migrator).
 */
export async function loadIdentity(path: string): Promise<IdentityRecord> {
  const absolute = resolvePath(path)
  let raw: string
  try {
    raw = await readFile(absolute, 'utf8')
  } catch (err) {
    throw new IdentityParseError(`could not read Identity at ${absolute}: ${errMsg(err)}`)
  }

  const split = splitFrontmatter(raw)
  if (split === null) {
    throw new IdentityParseError(
      `Identity at ${absolute} has no YAML frontmatter (expected '---' on the first line)`,
    )
  }

  let parsedYaml: unknown
  try {
    parsedYaml = YAML.parse(split.frontmatter)
  } catch (err) {
    throw new IdentityParseError(
      `Identity at ${absolute} has malformed YAML frontmatter: ${errMsg(err)}`,
    )
  }

  if (!isPlainObject(parsedYaml)) {
    throw new IdentityParseError(
      `Identity at ${absolute} frontmatter must be a YAML mapping at the top level`,
    )
  }

  // Run any necessary migrators so the loader tolerates older versions
  // of the schema. Per upgrade-readiness #1, the loader does NOT write
  // back; migration on write is a separate explicit operation.
  const migrated = migrateToCurrent(parsedYaml)

  const result = IdentityFrontmatterSchema.safeParse(migrated)
  if (!result.success) {
    throw new IdentityParseError(
      `Identity at ${absolute} fails schema validation:\n${formatIssues(result.error.issues)}`,
    )
  }

  return {
    frontmatter: result.data,
    body: split.body,
    source_path: absolute,
  }
}

/**
 * Validate an Identity file without returning the loaded record. Returns
 * `null` on success or an error message on failure. Useful for the
 * supervisor's create-time validation (catch bad Identities early
 * without paying the hydration cost).
 */
export async function validateIdentity(path: string): Promise<string | null> {
  try {
    await loadIdentity(path)
    return null
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

/**
 * Validate just an in-memory frontmatter object. Useful for tests and
 * for callers that have already parsed YAML.
 */
export function validateFrontmatter(value: unknown): IdentityFrontmatter {
  const migrated = migrateToCurrent(value)
  const result = IdentityFrontmatterSchema.safeParse(migrated)
  if (!result.success) {
    throw new IdentityParseError(
      `Identity frontmatter fails schema validation:\n${formatIssues(result.error.issues)}`,
    )
  }
  return result.data
}

/**
 * Error class for Identity load failures. Catchable distinctly from
 * generic IO errors.
 */
export class IdentityParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'IdentityParseError'
  }
}

interface SplitResult {
  frontmatter: string
  body: string
}

/**
 * Split an Identity file into frontmatter (between leading `---` and
 * matching `---`) and body. Returns null if no frontmatter is present.
 *
 * Tolerates trailing whitespace on the delimiter lines but requires the
 * first line of the file to be exactly `---` (with optional whitespace).
 */
function splitFrontmatter(raw: string): SplitResult | null {
  const lines = raw.split('\n')
  if (lines.length === 0 || !/^---\s*$/.test(lines[0] ?? '')) return null

  let closeIndex = -1
  for (let i = 1; i < lines.length; i++) {
    if (/^---\s*$/.test(lines[i] ?? '')) {
      closeIndex = i
      break
    }
  }
  if (closeIndex === -1) return null

  const frontmatter = lines.slice(1, closeIndex).join('\n')
  const body = lines.slice(closeIndex + 1).join('\n')
  // Trim leading blank lines from the body so the markdown reads naturally.
  return { frontmatter, body: body.replace(/^\s*\n/, '') }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function formatIssues(issues: readonly { path: PropertyKey[]; message: string }[]): string {
  return issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n')
}
