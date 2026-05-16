/**
 * Connector binding writer.
 *
 * Adds or replaces a `connectors[]` entry in an Agent's identity.md
 * frontmatter. Used by the Store's per-Agent setup endpoint to wire
 * a freshly-installed connector (Discord bot, etc.) into the Agent's
 * Identity without the operator hand-editing the markdown file.
 *
 * Idempotency: matching is by `connector_id` + `account`. A second
 * setup call with the same pair updates the existing binding in place.
 *
 * Format preservation: the writer reads frontmatter via the same
 * YAML loader the Identity reader uses, mutates the parsed object,
 * and serializes back with the YAML library's stable output. Markdown
 * body below the frontmatter is preserved verbatim.
 *
 * Decision: [[../../decisions/2026-05-16-connector-per-agent-identity]]
 */
import { readFile, writeFile } from 'node:fs/promises'
import * as YAML from 'yaml'
import { AgentConnectorBindingSchema, type AgentConnectorBinding } from './types.js'

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/

export async function upsertConnectorBinding(
  identityPath: string,
  binding: AgentConnectorBinding,
): Promise<void> {
  // Validate the binding (defensive; caller already builds a typed
  // object, but a runtime check catches drift if the schema evolves).
  const validated = AgentConnectorBindingSchema.parse(binding)

  const text = await readFile(identityPath, 'utf-8')
  const m = FRONTMATTER_RE.exec(text)
  if (!m) {
    throw new Error(`identity.md at ${identityPath} has no YAML frontmatter`)
  }
  const frontmatterYaml = m[1] ?? ''
  const body = m[2] ?? ''

  const frontmatter = (YAML.parse(frontmatterYaml) ?? {}) as Record<string, unknown>
  const existing = Array.isArray(frontmatter['connectors'])
    ? (frontmatter['connectors'] as AgentConnectorBinding[])
    : []
  const filtered = existing.filter(
    (b) => !(b.connector_id === validated.connector_id && b.account === validated.account),
  )
  filtered.push(validated)
  frontmatter['connectors'] = filtered

  // yaml lib emits with stable key order matching insertion. Line
  // width = 100 keeps allowlist arrays readable without aggressive
  // wrapping.
  const newFrontmatter = YAML.stringify(frontmatter, { lineWidth: 100 }).trimEnd()
  const newText = `---\n${newFrontmatter}\n---\n${body.startsWith('\n') ? '' : '\n'}${body}`
  await writeFile(identityPath, newText)
}
