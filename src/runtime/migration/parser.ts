/**
 * Migration handoff document parser (Epic 5 Phase A PR A).
 *
 * Reads a markdown file with YAML frontmatter, validates the
 * frontmatter against the v1 schema in `./types.ts`, and returns a
 * HandoffDocument that the orchestrator (later PR) consumes.
 *
 * The parser is intentionally strict on the frontmatter shape (every
 * v1 field validated, schema_version locked to `1`, schedules forced
 * empty for Phase A) and lenient on the body (anything goes). Hard
 * failures throw a HandoffParseError with the source path and a
 * Zod-derived message so the operator can fix the file and re-run.
 */
import { readFile } from 'node:fs/promises'
import { parse as parseYaml } from 'yaml'
import { ZodError } from 'zod'
import { HandoffFrontmatterSchema, type HandoffDocument } from './types.js'

/**
 * Matches a leading YAML frontmatter block at the very start of a
 * file. Group 1 is the YAML; group 2 is the body (everything after
 * the closing `---` line, including a leading newline if present).
 *
 * The closing `---` must be on its own line; the regex is anchored
 * to start-of-string so a stray `---` inside the body is not a
 * candidate.
 */
const FRONTMATTER_RE = /^---\n([\s\S]+?)\n---\n?([\s\S]*)$/

/**
 * Thrown when a handoff document cannot be parsed or validated.
 * Carries the source path so the operator's recovery message can
 * point at the file. The underlying cause (Zod issue list, YAML
 * parse error, missing frontmatter) is exposed via `cause`.
 */
export class HandoffParseError extends Error {
  readonly source_path: string | null
  override readonly cause: unknown
  constructor(message: string, source_path: string | null, cause?: unknown) {
    super(message)
    this.name = 'HandoffParseError'
    this.source_path = source_path
    this.cause = cause
  }
}

/**
 * Parse + validate a handoff document from a file on disk. Reads the
 * file, splits frontmatter from body, parses YAML, validates against
 * `HandoffFrontmatterSchema`, returns the resulting HandoffDocument.
 *
 * Throws HandoffParseError on:
 *   - file read failure (cause is the underlying fs error)
 *   - missing or malformed frontmatter block
 *   - YAML parse failure (cause is the YAML library's error)
 *   - Zod validation failure (cause is the ZodError)
 */
export async function parseHandoffFile(path: string): Promise<HandoffDocument> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (err) {
    throw new HandoffParseError(
      `could not read handoff document at "${path}": ${(err as Error).message}`,
      path,
      err,
    )
  }
  return parseHandoffString(text, path)
}

/**
 * Parse + validate a handoff document from an in-memory string. Same
 * semantics as parseHandoffFile minus the file read. Useful for
 * tests and for callers that already have the doc in memory (e.g.,
 * a future export step that streams from one process to another).
 *
 * `source_path` is recorded on the returned HandoffDocument and
 * threaded into any HandoffParseError; pass null when there is no
 * meaningful path.
 */
export function parseHandoffString(text: string, source_path: string | null): HandoffDocument {
  const m = FRONTMATTER_RE.exec(text)
  if (m?.[1] === undefined) {
    throw new HandoffParseError(
      'handoff document is missing the leading YAML frontmatter block (expected "---\\n...\\n---" at the start of the file)',
      source_path,
    )
  }
  const yamlText = m[1]
  const body = m[2] ?? ''

  let raw: unknown
  try {
    raw = parseYaml(yamlText) ?? {}
  } catch (err) {
    throw new HandoffParseError(
      `frontmatter YAML failed to parse: ${(err as Error).message}`,
      source_path,
      err,
    )
  }

  let frontmatter
  try {
    frontmatter = HandoffFrontmatterSchema.parse(raw)
  } catch (err) {
    if (err instanceof ZodError) {
      const summary = err.issues
        .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('\n')
      throw new HandoffParseError(
        `handoff document failed validation:\n${summary}`,
        source_path,
        err,
      )
    }
    throw err
  }

  return {
    frontmatter,
    body,
    source_path,
  }
}
