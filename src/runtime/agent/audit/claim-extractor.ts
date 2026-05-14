/**
 * Claim extraction via a cheap LLM call.
 *
 * Input: the agent's final assistant message body.
 * Output: structured `ExtractedClaim[]` matching the locked taxonomy.
 *
 * Why an LLM (not regex): the agent's message is natural prose; verbs
 * vary; the verb-to-category mapping is fuzzy. A cheap model handles
 * "I uploaded the cover" → category=file_create vs. "I uploaded the
 * cover image" → still file_create vs. "I cleared the playlist" →
 * external_send (state change on Spotify). Regex on prose chases its
 * tail.
 *
 * Why cheap: the audit pass runs once per task; cost per call must
 * stay well under a frontier-model call's cost or the audit becomes
 * a regrettable tax. Anthropic Haiku ($0.25/M in, $1.25/M out) is the
 * default; operators with no Anthropic key get a graceful no-op (no
 * audit, but the loop still runs).
 *
 * The prompt asks the model to return a JSON array. We tolerate the
 * model wrapping it in a code fence or prose; the parser strips both.
 * Anything the model returns that doesn't conform to the schema is
 * dropped silently ... false-positive claims would create operator
 * noise.
 */
import { z } from 'zod'
import type { LLMProvider } from '../../llm/provider.js'
import type { ExtractedClaim } from './types.js'

const EXTRACTION_SYSTEM_PROMPT = `You are an audit assistant for a multi-agent platform. Your one job: read another agent's message and list every factual claim the agent made about an action it took.

Return ONLY a JSON array. Each element is an object with these keys:

  category    one of: file_create, file_read, external_send, tool_invoke, process_count
  verb        the surface verb the agent used (e.g. "wrote", "saved", "pushed", "sent")
  object      what the verb acted on, in the agent's own words
  path        OPTIONAL. For file_create / file_read, the literal path the agent named.
  tool        OPTIONAL. For tool_invoke, the literal tool name the agent named.
  target      OPTIONAL. For external_send, the recipient (pub/channel/user).
  count       OPTIONAL. For process_count, the integer the agent claimed.

Category rules:
  file_create   "wrote", "saved", "created", "updated", "uploaded", "stored", "appended", "encrypted to disk", "committed"
  file_read     "read", "loaded", "opened", "examined", "checked the contents of"
  external_send "sent", "posted", "broadcast", "messaged", "emailed", "delivered", "notified", "kicked off task for <agent>"
  tool_invoke   "called <toolname>", "ran <toolname>", "invoked <toolname>" with an EXPLICIT tool identifier
  process_count "checked all N", "processed N", "found N", "ran through 12" with an explicit integer

If the agent only narrated planning ("I should...", "next I will...") or asked a question, return [].
If the agent admitted failure ("couldn't write...", "the call failed"), do NOT include that as a claim ... it's a self-report of failure, not a claim of action.

Return ONLY the JSON array. No prose, no explanation, no code fences.`

const ClaimSchema = z.object({
  category: z.enum(['file_create', 'file_read', 'external_send', 'tool_invoke', 'process_count']),
  verb: z.string().min(1).max(80),
  object: z.string().min(1).max(300),
  path: z.string().min(1).max(500).optional(),
  tool: z.string().min(1).max(80).optional(),
  target: z.string().min(1).max(200).optional(),
  count: z.number().int().min(0).max(10_000).optional(),
})

const ClaimsArraySchema = z.array(ClaimSchema).max(20)

export interface ExtractClaimsArgs {
  /** The agent's final assistant message body. */
  body: string
  /** Cheap-model LLM provider; the audit pass passes this in. */
  provider: LLMProvider
  /** Model id under the provider (e.g. "claude-haiku-4-5-20251001"). */
  modelId: string
}

/**
 * Run the extraction. Returns `[]` on any failure (LLM error, parse
 * failure, schema mismatch); the audit pass treats this as "nothing
 * to verify" rather than failing the task. Reliability over coverage.
 */
export async function extractClaims(args: ExtractClaimsArgs): Promise<ExtractedClaim[]> {
  // Skip empty / trivial bodies. Saves a cheap-model call per pure
  // "ok" / "done" reply.
  const trimmed = args.body.trim()
  if (trimmed.length < 12) return []

  let response
  try {
    response = await args.provider.complete({
      modelId: args.modelId,
      systemPrompt: EXTRACTION_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: trimmed.slice(0, 8000) }],
      maxTokens: 1200,
      temperature: 0,
    })
  } catch {
    return []
  }

  const json = extractJsonArray(response.text)
  if (json === null) return []

  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return []
  }

  const validated = ClaimsArraySchema.safeParse(parsed)
  if (!validated.success) return []
  // Drop the explicit-undefined optionals that Zod parses into the
  // object; the ExtractedClaim type uses exactOptionalPropertyTypes
  // so undefined-keyed properties don't match.
  return validated.data.map((c) => {
    const out: ExtractedClaim = { category: c.category, verb: c.verb, object: c.object }
    if (c.path !== undefined) out.path = c.path
    if (c.tool !== undefined) out.tool = c.tool
    if (c.target !== undefined) out.target = c.target
    if (c.count !== undefined) out.count = c.count
    return out
  })
}

/**
 * Find the first JSON array in the model's output. Tolerates the
 * model wrapping the array in a ```json``` fence or prefixing it
 * with a sentence. Returns the substring `[...]` or null if no
 * balanced array could be located.
 */
export function extractJsonArray(raw: string): string | null {
  const fence = /```(?:json)?\s*([\s\S]*?)```/u.exec(raw)
  const candidate = fence?.[1] ?? raw
  const start = candidate.indexOf('[')
  if (start === -1) return null
  let depth = 0
  let inString = false
  let escape = false
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate.charAt(i)
    if (escape) {
      escape = false
      continue
    }
    if (ch === '\\') {
      escape = true
      continue
    }
    if (ch === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (ch === '[') depth += 1
    else if (ch === ']') {
      depth -= 1
      if (depth === 0) {
        return candidate.slice(start, i + 1)
      }
    }
  }
  return null
}
