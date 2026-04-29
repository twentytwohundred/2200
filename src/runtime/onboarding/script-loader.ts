/**
 * Script loader for the conversational onboarding flow
 * (Epic 14 Phase A PR A).
 *
 * Reads a YAML question script, validates it against the Zod schema in
 * `./types.js`, and surfaces precise error messages for malformed
 * scripts. The loader fails loud at boot time rather than mid-
 * conversation: a bad script is an operator-fixable configuration
 * issue, not a user-facing surprise.
 */
import { readFile } from 'node:fs/promises'
import { parse as parseYaml } from 'yaml'
import { ZodError } from 'zod'
import { QuestionScriptSchema, type QuestionScript } from './types.js'

/**
 * Thrown when a question script cannot be parsed or validated. Carries
 * the source path so the operator's recovery message can point at the
 * file. Underlying cause is exposed via `cause`.
 */
export class ScriptLoadError extends Error {
  readonly source_path: string | null
  override readonly cause: unknown
  constructor(message: string, source_path: string | null, cause?: unknown) {
    super(message)
    this.name = 'ScriptLoadError'
    this.source_path = source_path
    this.cause = cause
  }
}

/**
 * Load a question script from a YAML file on disk. Throws
 * `ScriptLoadError` on read failure, YAML parse failure, schema
 * mismatch, or referential integrity issues (e.g., `default_branch`
 * names a branch that does not exist).
 */
export async function loadScriptFile(path: string): Promise<QuestionScript> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (err) {
    throw new ScriptLoadError(
      `could not read onboarding script at "${path}": ${(err as Error).message}`,
      path,
      err,
    )
  }
  return parseScriptString(text, path)
}

/**
 * Parse + validate a question script from an in-memory string. Same
 * semantics as `loadScriptFile` minus the file read. Useful for tests.
 */
export function parseScriptString(text: string, source_path: string | null): QuestionScript {
  let raw: unknown
  try {
    raw = parseYaml(text) ?? {}
  } catch (err) {
    throw new ScriptLoadError(
      `onboarding script YAML failed to parse: ${(err as Error).message}`,
      source_path,
      err,
    )
  }

  let parsed: QuestionScript
  try {
    parsed = QuestionScriptSchema.parse(raw)
  } catch (err) {
    if (err instanceof ZodError) {
      const summary = err.issues
        .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('\n')
      throw new ScriptLoadError(
        `onboarding script failed validation:\n${summary}`,
        source_path,
        err,
      )
    }
    throw err
  }

  // Referential integrity: routing rules must point at known branches,
  // and `default_branch` must name a branch that exists. The loader is
  // the right place to catch these (Zod cannot, since the rules are
  // structural across fields). A bad cross-reference fails the operator
  // at boot rather than mid-interview.
  const branchIds = new Set(parsed.branches.map((b) => b.id))
  if (!branchIds.has(parsed.default_branch)) {
    throw new ScriptLoadError(
      `default_branch "${parsed.default_branch}" does not match any branch id`,
      source_path,
    )
  }
  for (let i = 0; i < parsed.routing.length; i++) {
    const rule = parsed.routing[i]
    if (rule === undefined) continue
    if (!branchIds.has(rule.next_branch)) {
      throw new ScriptLoadError(
        `routing[${String(i)}].next_branch "${rule.next_branch}" does not match any branch id`,
        source_path,
      )
    }
  }

  // Branch ids must be unique. Two branches with the same id would
  // make routing ambiguous.
  const seen = new Set<string>()
  for (const branch of parsed.branches) {
    if (seen.has(branch.id)) {
      throw new ScriptLoadError(
        `duplicate branch id "${branch.id}"; branch ids must be unique within a script`,
        source_path,
      )
    }
    seen.add(branch.id)
  }

  return parsed
}
