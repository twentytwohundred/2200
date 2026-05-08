/**
 * Build native tool-use specs from a tool registry.
 *
 * Each baseline (and Identity-declared) tool has a Zod args schema.
 * This module converts that schema to a JSON Schema (draft 2020-12)
 * via `z.toJSONSchema()` and packages it with the tool's name and
 * description in a shape the LLMProvider native tool-use surface
 * accepts.
 *
 * Anthropic and OpenAI both want JSON Schema for the args (Anthropic:
 * `tools[].input_schema`, OpenAI: `tools[].function.parameters`).
 * Providers without native tool-use ignore the field; the agent loop
 * falls back to fenced-text parsing of the response text.
 *
 * Conversion notes:
 * - Zod 4's `z.toJSONSchema` produces draft 2020-12 with
 *   `additionalProperties: false`; both Anthropic and OpenAI accept
 *   this. The `$schema` field is dropped (the providers don't expect
 *   it and OpenAI in particular is touchy about extra top-level keys).
 * - Description text comes from `tool.description` verbatim; the
 *   schema's per-property descriptions (when present in the Zod
 *   schema's `.describe()` calls) flow through.
 */
import { z } from 'zod'
import type { ToolRegistry } from '../mcp/registry.js'
import type { NativeToolSpec } from './types.js'

/**
 * Convert a registry's allowed tools to NativeToolSpec[]. Tools whose
 * schema cannot be converted to JSON Schema are skipped with a console
 * warning rather than aborting the build; this happens roughly never
 * in practice and we'd rather lose native tool-use for one tool than
 * lose it for the whole agent.
 *
 * Tool names are translated from dotted internal form (`fs.read`)
 * to underscored wire form (`fs_read`) because both Anthropic and
 * OpenAI's native tool-use surfaces enforce `^[a-zA-Z0-9_-]+$` on
 * tool names. The translation is bidirectional via the
 * `internalName` field; the loop uses that to dispatch back to the
 * registry when a native tool call comes in.
 */
export function toNativeToolSpecs(
  registry: ToolRegistry,
  allowedNames: ReadonlySet<string>,
): NativeToolSpec[] {
  const out: NativeToolSpec[] = []
  const seen = new Set<string>()
  for (const { name, tool } of registry.allTools()) {
    if (!allowedNames.has(name)) continue
    const wireName = toWireName(name)
    if (seen.has(wireName)) {
      // Two internal names mapped to the same wire name; rare but
      // would silently break dispatch. Skip the second to keep
      // collisions visible in the warning instead of corrupting the
      // mapping.
      console.warn(`tool-spec: wire-name collision on ${wireName}; skipping ${name}`)
      continue
    }
    seen.add(wireName)
    let parametersJsonSchema: object
    try {
      const raw = z.toJSONSchema(tool.argsSchema)
      // Strip the $schema header; providers don't want it.
      const { $schema: _$schema, ...rest } = raw as Record<string, unknown>
      parametersJsonSchema = rest
    } catch (err) {
      console.warn(
        `tool-spec: skipping ${name} (zod-to-json-schema failed: ${
          err instanceof Error ? err.message : String(err)
        })`,
      )
      continue
    }
    out.push({
      name: wireName,
      internalName: name,
      description: tool.description,
      parametersJsonSchema,
    })
  }
  return out
}

/**
 * Translate a registry tool name (dotted) to a wire name accepted by
 * Anthropic / OpenAI native tool-use (must match
 * `^[a-zA-Z0-9_-]+$`). Dots become underscores; everything else is
 * already in the safe set per our internal naming convention.
 */
export function toWireName(internalName: string): string {
  return internalName.replace(/\./g, '_')
}
