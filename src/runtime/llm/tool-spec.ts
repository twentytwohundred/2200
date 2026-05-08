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
 */
export function toNativeToolSpecs(
  registry: ToolRegistry,
  allowedNames: ReadonlySet<string>,
): NativeToolSpec[] {
  const out: NativeToolSpec[] = []
  for (const { name, tool } of registry.allTools()) {
    if (!allowedNames.has(name)) continue
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
      name,
      description: tool.description,
      parametersJsonSchema,
    })
  }
  return out
}
