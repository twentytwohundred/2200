/**
 * Skill install-time analysis.
 *
 * Two pure functions a `ParsedSkill` produces before the operator
 * commits an install:
 *
 *   - `extractMcpServers` ... reads MCP server install entries from
 *     either a 2200 `mcp:` frontmatter block (preferred) or, as a
 *     fallback, a fenced ```json block in the body that contains a
 *     top-level `mcpServers` key. This is the convention published by
 *     OpenPub and used widely across the OpenClaw skill ecosystem.
 *
 *   - `extractToolClasses` ... reads a `tool_classes` frontmatter map
 *     mapping `<tool>` (or `<server>.<tool>`) to an audit class
 *     (file_create / file_read / external_send / etc.) The audit
 *     overlay uses this to classify newly-installed skill tools so
 *     claims involving them verify against the right log.
 *
 * Both functions are tolerant: they return null / empty rather than
 * throwing on malformed inputs. The wizard surfaces the resulting
 * preview to the operator who then chooses what to install.
 */
import type { ParsedSkill } from './types.js'

/**
 * Audit categories the verifier knows how to classify against. Must
 * stay in sync with the `*_CLASS_TOOLS` sets in
 * `src/runtime/agent/audit/verifiers.ts`. New categories require both
 * a verifier-side addition and a wider review of the audit substrate.
 */
export const TOOL_CLASS_VALUES = [
  'file_create',
  'file_read',
  'external_send',
  'tool_invoke',
  'process_count',
] as const
export type ToolClass = (typeof TOOL_CLASS_VALUES)[number]
const TOOL_CLASS_SET = new Set<string>(TOOL_CLASS_VALUES)

/**
 * Which credential a server entry needs the operator to supply at
 * install time. `stdio_env` is the OpenPub-style `env` map on a stdio
 * spec; `http_bearer` is an HTTP server requiring an `Authorization:
 * Bearer <token>` header (or an explicit `auth.token` placeholder).
 */
export interface RequiredSecret {
  key: string
  kind: 'stdio_env' | 'http_bearer' | 'http_header'
}

export type ExtractedMcpServer =
  | {
      name: string
      transport: 'stdio'
      command: string
      args: string[]
      required_secrets: RequiredSecret[]
      source: 'frontmatter' | 'body'
    }
  | {
      name: string
      transport: 'http'
      url: string
      auth_kind: 'none' | 'bearer'
      required_secrets: RequiredSecret[]
      source: 'frontmatter' | 'body'
    }

/**
 * Extract MCP server install entries from a parsed Skill. Returns an
 * empty array if no MCP block is declared (a knowledge-only skill).
 *
 * Resolution order:
 *   1. Frontmatter `mcp.servers` (2200 spec extension). When present,
 *      this is authoritative and body scanning is skipped.
 *   2. Fenced ```json blocks in the body whose top-level value has a
 *      `mcpServers` key. First valid block wins.
 */
export function extractMcpServers(skill: ParsedSkill): ExtractedMcpServer[] {
  const fromFrontmatter = extractFromFrontmatter(skill)
  if (fromFrontmatter !== null) return fromFrontmatter
  return extractFromBody(skill.body)
}

function extractFromFrontmatter(skill: ParsedSkill): ExtractedMcpServer[] | null {
  const mcp = skill.extras['mcp']
  if (mcp === null || mcp === undefined) return null
  if (typeof mcp !== 'object') return null
  const servers = (mcp as Record<string, unknown>)['servers']
  if (servers === null || servers === undefined) return null
  if (typeof servers !== 'object') return null
  const out: ExtractedMcpServer[] = []
  for (const [name, raw] of Object.entries(servers as Record<string, unknown>)) {
    const parsed = parseServerEntry(name, raw, 'frontmatter')
    if (parsed !== null) out.push(parsed)
  }
  return out
}

function extractFromBody(body: string): ExtractedMcpServer[] {
  for (const block of iterateJsonFences(body)) {
    let parsed: unknown
    try {
      parsed = JSON.parse(block)
    } catch {
      continue
    }
    if (parsed === null || typeof parsed !== 'object') continue
    const mcpServers = (parsed as Record<string, unknown>)['mcpServers']
    if (mcpServers === null || mcpServers === undefined) continue
    if (typeof mcpServers !== 'object') continue
    const out: ExtractedMcpServer[] = []
    for (const [name, raw] of Object.entries(mcpServers as Record<string, unknown>)) {
      const entry = parseServerEntry(name, raw, 'body')
      if (entry !== null) out.push(entry)
    }
    if (out.length > 0) return out
  }
  return []
}

/**
 * Walk the body line-by-line yielding the text inside each fenced
 * ``` block whose info-string contains `json` (case-insensitive).
 * Trailing fences without an opener are ignored.
 */
function* iterateJsonFences(body: string): Generator<string> {
  const lines = body.split('\n')
  let i = 0
  while (i < lines.length) {
    const line = lines[i] ?? ''
    const m = /^\s*```\s*(\S+)?\s*$/.exec(line)
    if (m) {
      const info = (m[1] ?? '').toLowerCase()
      const isJson = info === 'json' || info === 'jsonc'
      const content: string[] = []
      i++
      while (i < lines.length) {
        const inner = lines[i] ?? ''
        if (/^\s*```\s*$/.test(inner)) {
          i++
          if (isJson) yield content.join('\n')
          break
        }
        content.push(inner)
        i++
      }
      continue
    }
    i++
  }
}

function parseServerEntry(
  name: string,
  raw: unknown,
  source: 'frontmatter' | 'body',
): ExtractedMcpServer | null {
  if (raw === null || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  const isHttp = typeof obj['url'] === 'string'
  const isStdio = typeof obj['command'] === 'string'
  if (isStdio && !isHttp) return parseStdio(name, obj, source)
  if (isHttp && !isStdio) return parseHttp(name, obj, source)
  return null
}

function parseStdio(
  name: string,
  obj: Record<string, unknown>,
  source: 'frontmatter' | 'body',
): ExtractedMcpServer | null {
  const command = obj['command']
  if (typeof command !== 'string' || command.length === 0) return null
  const argsRaw = obj['args']
  const args = Array.isArray(argsRaw)
    ? argsRaw.filter((a): a is string => typeof a === 'string')
    : []
  const env = obj['env']
  const required_secrets: RequiredSecret[] = []
  if (env !== null && typeof env === 'object' && !Array.isArray(env)) {
    for (const key of Object.keys(env)) {
      if (key.length === 0) continue
      required_secrets.push({ key, kind: 'stdio_env' })
    }
  }
  return { name, transport: 'stdio', command, args, required_secrets, source }
}

function parseHttp(
  name: string,
  obj: Record<string, unknown>,
  source: 'frontmatter' | 'body',
): ExtractedMcpServer | null {
  const url = obj['url']
  if (typeof url !== 'string' || url.length === 0) return null
  const required_secrets: RequiredSecret[] = []
  let auth_kind: 'none' | 'bearer' = 'none'

  const headers = obj['headers']
  if (headers !== null && typeof headers === 'object' && !Array.isArray(headers)) {
    for (const [headerName, headerValue] of Object.entries(headers as Record<string, unknown>)) {
      if (typeof headerValue !== 'string') continue
      if (headerName.toLowerCase() === 'authorization' && /^bearer\b/i.test(headerValue)) {
        auth_kind = 'bearer'
        required_secrets.push({ key: 'token', kind: 'http_bearer' })
      } else if (/[<>]/.test(headerValue)) {
        required_secrets.push({ key: headerName, kind: 'http_header' })
      }
    }
  }

  const auth = obj['auth']
  if (auth !== null && typeof auth === 'object' && !Array.isArray(auth)) {
    const type = (auth as Record<string, unknown>)['type']
    if (type === 'bearer' && auth_kind !== 'bearer') {
      auth_kind = 'bearer'
      required_secrets.push({ key: 'token', kind: 'http_bearer' })
    }
  }

  return { name, transport: 'http', url, auth_kind, required_secrets, source }
}

/**
 * Read a `tool_classes` map from the Skill's frontmatter extras.
 * Returns an empty object if none declared or if the value is the
 * wrong shape. Individual entries with invalid class names are
 * dropped (the wizard surfaces a warning via `extractToolClassesWithWarnings`).
 */
export function extractToolClasses(skill: ParsedSkill): Record<string, ToolClass> {
  return extractToolClassesWithWarnings(skill).classes
}

export interface ToolClassExtraction {
  classes: Record<string, ToolClass>
  /** Operator-readable strings naming any dropped entries. */
  warnings: string[]
}

export function extractToolClassesWithWarnings(skill: ParsedSkill): ToolClassExtraction {
  const raw = skill.extras['tool_classes']
  if (raw === null || raw === undefined) return { classes: {}, warnings: [] }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { classes: {}, warnings: ['tool_classes is not an object; ignored'] }
  }
  const classes: Record<string, ToolClass> = {}
  const warnings: string[] = []
  for (const [tool, klass] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof klass !== 'string') {
      warnings.push(`tool_classes.${tool}: value is not a string`)
      continue
    }
    if (!TOOL_CLASS_SET.has(klass)) {
      warnings.push(
        `tool_classes.${tool}: "${klass}" is not a known audit class (valid: ${TOOL_CLASS_VALUES.join(', ')})`,
      )
      continue
    }
    classes[tool] = klass as ToolClass
  }
  return { classes, warnings }
}
