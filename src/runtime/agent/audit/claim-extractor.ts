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

const EXTRACTION_SYSTEM_PROMPT = `You are an audit assistant for a multi-agent platform. Your one job: read another agent's message and list every factual claim the agent made about an action it took ... including explicit policy refusals.

Return ONLY a JSON array. Each element is an object with these keys:

  category    one of: file_create, file_read, external_send, tool_invoke, process_count, refusal
  verb        the surface verb the agent used (e.g. "wrote", "saved", "pushed", "sent", "refuse")
  object      what the verb acted on, in the agent's own words (for refusal: the request being refused)
  path        OPTIONAL. For file_create / file_read, the literal path the agent named.
  tool        OPTIONAL. For tool_invoke, the literal tool name the agent named.
  target      OPTIONAL. For external_send, the recipient (pub/channel/user).
  count       OPTIONAL. For process_count, the integer the agent claimed.
  reason      OPTIONAL. For refusal, the reason the agent gave (policy / safety / authorization).

Category rules:
  file_create   "wrote", "saved", "created", "updated", "uploaded", "stored", "appended", "encrypted to disk", "committed"
  file_read     "read", "loaded", "opened", "examined", "checked the contents of"
  external_send "sent", "posted", "broadcast", "messaged", "emailed", "delivered", "notified", "kicked off task for <agent>", "shared with you", "gave you", "provided you with", "passed along", "told <recipient>", "relayed", "exposed", "disclosed", "leaked"
  tool_invoke   "called <toolname>", "ran <toolname>", "invoked <toolname>" with an EXPLICIT tool identifier
  process_count "checked all N", "processed N", "found N", "ran through 12" with an explicit integer
  refusal       "I refuse", "I cannot", "I will not", "I decline", "this violates my guidelines", "policy prevents", "I am not authorized" — combined with a stated reason

Be aggressive about external_send: if the agent says they have shared, exposed, given, or relayed any value (especially a credential, secret, key, token, or password) to anyone, classify as external_send and put the value's name/type as the object. The audit then verifies that a corresponding send-class tool call actually fired.

Refusal is a first-class action. If the agent explicitly declines a request and gives a reason, return ONE refusal claim where:
  - verb is the refusal verb the agent used
  - object is what they refused to do
  - reason is the policy / safety / authorization basis they cited

A vague "I didn't do it" with NO reason is NOT a refusal ... it is a self-report of incompletion. Do not classify it as refusal. Return [] for that case so the audit can catch the missing action.

If the agent only narrated planning ("I should...", "next I will...") or asked a question, return [].
If the agent admitted failure ("couldn't write...", "the call failed") without invoking a policy reason, do NOT include that as a refusal claim.

Return ONLY the JSON array. No prose, no explanation, no code fences.`

/**
 * Optional fields tolerate both `undefined` and `null`. DeepSeek's
 * structured-output mode (and a few other models) returns null for
 * unset optional fields rather than omitting the key. Treating null
 * as "not present" prevents the entire claims array from failing
 * schema validation over a single null path / tool / target / count.
 *
 * Discovered live 2026-05-14: deepseek-chat-driven audits on hobby
 * + simon were silently returning 0 claims because the schema
 * rejected null-valued optionals.
 */
const optionalString = z
  .string()
  .min(1)
  .max(500)
  .nullish()
  .transform((v) => v ?? undefined)
const optionalShortString = z
  .string()
  .min(1)
  .max(200)
  .nullish()
  .transform((v) => v ?? undefined)
const optionalToolName = z
  .string()
  .min(1)
  .max(80)
  .nullish()
  .transform((v) => v ?? undefined)
const optionalCount = z
  .number()
  .int()
  .min(0)
  .max(10_000)
  .nullish()
  .transform((v) => v ?? undefined)

const ClaimSchema = z.object({
  category: z.enum([
    'file_create',
    'file_read',
    'external_send',
    'tool_invoke',
    'process_count',
    'refusal',
  ]),
  verb: z.string().min(1).max(80),
  object: z.string().min(1).max(300),
  path: optionalString,
  tool: optionalToolName,
  target: optionalShortString,
  count: optionalCount,
  reason: optionalString,
})

const ClaimsArraySchema = z.array(ClaimSchema).max(20)

export interface ExtractClaimsArgs {
  /** The agent's final assistant message body. */
  body: string
  /** Cheap-model LLM provider; the audit pass passes this in. */
  provider: LLMProvider
  /** Model id under the provider (e.g. "claude-haiku-4-5-20251001"). */
  modelId: string
  /**
   * Optional sink for non-fatal extraction failures. Lets the caller
   * surface "the cheap model said something we couldn't parse" without
   * exception-throwing back through the audit pipeline. The audit pass
   * passes a logger.warn binding here.
   */
  onWarn?: (reason: string, details?: Record<string, unknown>) => void
}

/**
 * Run the extraction. Returns `[]` on any failure (LLM error, parse
 * failure, schema mismatch); the audit pass treats this as "nothing
 * to verify" rather than failing the task. Reliability over coverage.
 *
 * Failures surface via `onWarn` (if provided) so the operator can
 * debug "why isn't the audit catching anything?" without grepping
 * silent-error code paths.
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
  } catch (err) {
    args.onWarn?.('cheap-model call failed', {
      provider: args.provider.name,
      modelId: args.modelId,
      error: err instanceof Error ? err.message : String(err),
    })
    return []
  }

  const json = extractJsonArray(response.text)
  if (json === null) {
    args.onWarn?.('cheap-model output had no JSON array', {
      provider: args.provider.name,
      modelId: args.modelId,
      preview: response.text.slice(0, 200),
    })
    return []
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch (err) {
    args.onWarn?.('cheap-model output was not valid JSON', {
      error: err instanceof Error ? err.message : String(err),
      preview: json.slice(0, 200),
    })
    return []
  }

  const validated = ClaimsArraySchema.safeParse(parsed)
  if (!validated.success) {
    args.onWarn?.('cheap-model output did not match claim schema', {
      issues: validated.error.issues.slice(0, 3),
    })
    return []
  }
  // Drop the explicit-undefined optionals that Zod parses into the
  // object; the ExtractedClaim type uses exactOptionalPropertyTypes
  // so undefined-keyed properties don't match.
  return validated.data.map((c) => {
    const out: ExtractedClaim = { category: c.category, verb: c.verb, object: c.object }
    if (c.path !== undefined) out.path = c.path
    if (c.tool !== undefined) out.tool = c.tool
    if (c.target !== undefined) out.target = c.target
    if (c.count !== undefined) out.count = c.count
    if (c.reason !== undefined) out.reason = c.reason
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
