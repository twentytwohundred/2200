/**
 * Runtime-env file loader.
 *
 * 2200 supervisor processes (daemon + agents) need long-lived secrets
 * in their environment at start time. The canonical example is an LLM
 * provider API key (`DEEPSEEK_API_KEY`, `ANTHROPIC_API_KEY`, etc.) that
 * the AgentLoop's provider-bind step reads via `process.env`. Without
 * the key in the supervisor's env, agent bootstrap fails with
 * `env var 'DEEPSEEK_API_KEY' is not set` and the agent crashes on
 * start.
 *
 * Before this loader, the only path to get those keys into the
 * supervisor was for the user to source their shell rc (or a hand-
 * curated env file) before `2200 daemon start`. That's a friction
 * point: easy to forget, breaks restarts, breaks any non-interactive
 * launch path.
 *
 * This module reads `~/.config/2200/runtime.env` (or any path the
 * caller passes), parses bash-style `export KEY=value` lines, and
 * returns a `Record<string, string>`. Callers (daemon-start, agent-
 * start) merge the result with `process.env` and pass the union as
 * the child process's env.
 *
 * Security:
 *   - The file is expected to be mode 0600 (user-only). The loader
 *     does NOT enforce this; setting permissions is the user's
 *     responsibility (see the production-oauth-setup runbook).
 *   - Values are NEVER logged. Callers that emit telemetry about the
 *     load result should log only the count of keys, not key names
 *     or values. Inside this module, no logger is invoked.
 *   - On parse error, the loader throws `RuntimeEnvParseError` with a
 *     line number. Callers should surface the error to the user
 *     verbatim and refuse to start the daemon.
 *
 * Format:
 *   - One `KEY=value` per line.
 *   - Optional leading `export ` (bash-source compatible).
 *   - `KEY` matches `[A-Z_][A-Z0-9_]*` (uppercase, digits, underscore;
 *     starts with letter or underscore).
 *   - `value` is the rest of the line, trimmed of trailing whitespace.
 *     Surrounding `"` or `'` quote pairs are stripped (no escape
 *     processing inside quotes; values are taken as-is otherwise).
 *   - Blank lines and lines whose first non-whitespace char is `#`
 *     are ignored.
 *   - No multi-line values, no command substitution, no variable
 *     interpolation. This is a config file, not a shell script.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const KEY_RE = /^([A-Z_][A-Z0-9_]*)$/

/** Default location: `~/.config/2200/runtime.env`. */
export function defaultRuntimeEnvPath(): string {
  return join(homedir(), '.config', '2200', 'runtime.env')
}

export class RuntimeEnvParseError extends Error {
  readonly line: number
  readonly raw: string
  constructor(line: number, raw: string, message: string) {
    super(
      `runtime.env parse error at line ${String(line)}: ${message} (raw: ${JSON.stringify(raw)})`,
    )
    this.name = 'RuntimeEnvParseError'
    this.line = line
    this.raw = raw
  }
}

/**
 * Parse the contents of a runtime-env file. Returns an empty record
 * for an empty file. Throws `RuntimeEnvParseError` on malformed lines.
 */
export function parseRuntimeEnv(contents: string): Record<string, string> {
  const out: Record<string, string> = {}
  const lines = contents.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const lineNumber = i + 1
    const raw = lines[i] ?? ''
    const trimmed = raw.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue

    // Strip optional leading `export `.
    const body = trimmed.startsWith('export ') ? trimmed.slice('export '.length).trim() : trimmed

    const eq = body.indexOf('=')
    if (eq === -1) {
      throw new RuntimeEnvParseError(lineNumber, raw, `missing '='`)
    }
    const key = body.slice(0, eq).trim()
    if (!KEY_RE.test(key)) {
      throw new RuntimeEnvParseError(
        lineNumber,
        raw,
        `key ${JSON.stringify(key)} does not match /^[A-Z_][A-Z0-9_]*$/`,
      )
    }
    let value = body.slice(eq + 1)
    // Trim trailing whitespace from value (preserve leading internal whitespace
    // in case someone has a trailing space inside their secret, which is rare
    // but possible).
    value = value.replace(/\s+$/, '')
    // Strip surrounding matching quote pairs.
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1)
    }
    out[key] = value
  }
  return out
}

/**
 * Read and parse the runtime-env file at `path`. Returns an empty
 * record if the file does not exist (the supervisor still starts; the
 * agent provider bind will fail loudly if a required key is missing,
 * which is the correct behavior). Throws on parse errors.
 */
export async function loadRuntimeEnv(path?: string): Promise<Record<string, string>> {
  const target = path ?? defaultRuntimeEnvPath()
  let text: string
  try {
    text = await readFile(target, 'utf8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return {}
    throw err
  }
  return parseRuntimeEnv(text)
}

/**
 * Read the raw runtime-env file contents. Returns empty string when
 * the file does not exist. Used by the upsert/remove writers below
 * so they can preserve unrelated lines (comments, blanks, other keys).
 */
async function readRaw(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw err
  }
}

/**
 * Format a single env-file line. Quotes the value if it contains a
 * char that bash-source treats specially (whitespace, `#`, `"`, `'`,
 * `$`, backtick). Always uses double quotes; embedded `"` are escaped
 * with a backslash. Plain values stay unquoted to match the
 * ergonomics of the existing files users may have hand-edited.
 */
function formatLine(key: string, value: string): string {
  const needsQuote = /[\s#"'$`]/.test(value)
  const escaped = needsQuote ? `"${value.replace(/"/g, '\\"')}"` : value
  return `${key}=${escaped}`
}

/**
 * Upsert a single key=value pair in the runtime-env file at `path`.
 * Preserves all unrelated lines (comments, blanks, other keys). If
 * the key already exists, replaces its line in place; otherwise
 * appends a new line at end of file. Creates the parent directory
 * and the file (mode 0600) when missing.
 *
 * Note: the supervisor reads runtime.env once at start; in-flight
 * agent processes do NOT see the new value until they are restarted.
 * Callers should surface this to the user.
 */
export async function upsertRuntimeEnvKey(
  key: string,
  value: string,
  path?: string,
): Promise<void> {
  if (!KEY_RE.test(key)) {
    throw new Error(
      `upsertRuntimeEnvKey: key ${JSON.stringify(key)} must match /^[A-Z_][A-Z0-9_]*$/`,
    )
  }
  const target = path ?? defaultRuntimeEnvPath()
  await mkdir(dirname(target), { recursive: true, mode: 0o700 })
  const raw = await readRaw(target)
  const lines = raw === '' ? [] : raw.split('\n')
  const newLine = formatLine(key, value)
  const out: string[] = []
  let replaced = false
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) {
      out.push(line)
      continue
    }
    const body = trimmed.startsWith('export ') ? trimmed.slice('export '.length) : trimmed
    const eq = body.indexOf('=')
    if (eq === -1) {
      out.push(line)
      continue
    }
    const lineKey = body.slice(0, eq).trim()
    if (lineKey === key) {
      replaced = true
      out.push(newLine)
    } else {
      out.push(line)
    }
  }
  if (!replaced) out.push(newLine)
  // Ensure single trailing newline.
  let serialized = out.join('\n')
  if (!serialized.endsWith('\n')) serialized += '\n'
  await writeFile(target, serialized, { mode: 0o600 })
}

/**
 * Remove a single key from the runtime-env file. No-op if the file
 * or the key does not exist. Preserves unrelated lines.
 */
export async function removeRuntimeEnvKey(key: string, path?: string): Promise<void> {
  if (!KEY_RE.test(key)) return
  const target = path ?? defaultRuntimeEnvPath()
  const raw = await readRaw(target)
  if (raw === '') return
  const lines = raw.split('\n')
  const out = lines.filter((line) => {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) return true
    const body = trimmed.startsWith('export ') ? trimmed.slice('export '.length) : trimmed
    const eq = body.indexOf('=')
    if (eq === -1) return true
    const lineKey = body.slice(0, eq).trim()
    return lineKey !== key
  })
  let serialized = out.join('\n')
  if (serialized !== '' && !serialized.endsWith('\n')) serialized += '\n'
  await writeFile(target, serialized, { mode: 0o600 })
}
