/**
 * User identity file loader and writer.
 *
 * Reads/writes `<home>/config/user.md` per Epic 3
 * [[03-local-pub-integration]]. Pattern mirrors `runtime/identity/loader.ts`:
 *  - Frontmatter + body split
 *  - YAML parse with descriptive errors
 *  - Zod schema validation
 *  - Atomic writes via temp+rename
 *
 * Why a separate loader from Agent Identity: the user identity has a
 * different schema (no model binding, no tools, no project_dir) and
 * different semantics (one per instance, not one per Agent). Sharing
 * one loader would force a discriminated union that buys nothing.
 */
import { readFile } from 'node:fs/promises'
import { resolve as resolvePath } from 'node:path'
import * as YAML from 'yaml'
import { atomicWriteFile } from '../util/atomic-write.js'
import {
  UserIdentityFrontmatterSchema,
  type UserIdentityFrontmatter,
  type UserIdentityRecord,
} from './types.js'

/**
 * Load the user identity file. Throws `UserIdentityParseError` on
 * any failure (file not found, missing frontmatter, malformed YAML,
 * schema mismatch).
 */
export async function loadUserIdentity(path: string): Promise<UserIdentityRecord> {
  const absolute = resolvePath(path)
  let raw: string
  try {
    raw = await readFile(absolute, 'utf8')
  } catch (err) {
    throw new UserIdentityParseError(`could not read user identity at ${absolute}: ${errMsg(err)}`)
  }

  const split = splitFrontmatter(raw)
  if (split === null) {
    throw new UserIdentityParseError(
      `user identity at ${absolute} has no YAML frontmatter (expected '---' on the first line)`,
    )
  }

  let parsedYaml: unknown
  try {
    parsedYaml = YAML.parse(split.frontmatter)
  } catch (err) {
    throw new UserIdentityParseError(
      `user identity at ${absolute} has malformed YAML frontmatter: ${errMsg(err)}`,
    )
  }

  if (!isPlainObject(parsedYaml)) {
    throw new UserIdentityParseError(
      `user identity at ${absolute} frontmatter must be a YAML mapping at the top level`,
    )
  }

  const result = UserIdentityFrontmatterSchema.safeParse(parsedYaml)
  if (!result.success) {
    throw new UserIdentityParseError(
      `user identity at ${absolute} fails schema validation:\n${formatIssues(result.error.issues)}`,
    )
  }

  return {
    frontmatter: result.data,
    body: split.body,
    source_path: absolute,
  }
}

/**
 * Write the user identity file. Atomic via temp+rename. Composes the
 * frontmatter via YAML.stringify + the body text. Pass an empty body
 * to write just the frontmatter.
 */
export async function writeUserIdentity(
  path: string,
  frontmatter: UserIdentityFrontmatter,
  body = '',
): Promise<void> {
  // Validate before writing so we never persist an invalid file.
  const validated = UserIdentityFrontmatterSchema.parse(frontmatter)
  const yaml = YAML.stringify(validated)
  const trimmedBody = body.trimStart()
  const content = `---\n${yaml}---\n${trimmedBody ? `\n${trimmedBody}\n` : ''}`
  await atomicWriteFile(path, content)
}

/**
 * Try to load the user identity; return null if the file doesn't
 * exist (first-boot case). Other errors propagate.
 */
export async function loadUserIdentityIfExists(path: string): Promise<UserIdentityRecord | null> {
  try {
    return await loadUserIdentity(path)
  } catch (err) {
    if (err instanceof UserIdentityParseError && err.message.includes('could not read')) {
      // File-not-found case (the loader wraps fs errors generically).
      // Discriminate by also checking for ENOENT in the wrapped message.
      if (err.message.includes('ENOENT')) {
        return null
      }
    }
    throw err
  }
}

export class UserIdentityParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UserIdentityParseError'
  }
}

interface SplitResult {
  frontmatter: string
  body: string
}

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
