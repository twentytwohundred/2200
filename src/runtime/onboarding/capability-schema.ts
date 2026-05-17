/**
 * Capability schema for the Phase F Capability Catalog.
 *
 * A Capability is the unit of integration an operator says yes/no to
 * during onboarding ... it bundles the credentials needed, the tools /
 * skills / extensions / providers that become functional once those
 * credentials are sealed, and the human-facing acquisition walkthrough
 * as one entity with a single trust contract.
 *
 * Frontmatter is loaded from markdown files under
 * `wiki/catalog/capabilities/` (first-party catalog, public wiki) and
 * `~/.2200/catalog/capabilities/` (operator overrides, local). The
 * body of each file is the acquisition prose rendered inline into chat
 * during the post-spawn walkthrough.
 *
 * See:
 *   wiki/epics/14-phase-f-capability-catalog.md ... full spec.
 *   wiki/decisions/2026-05-18-capability-security-model.md ... forward-
 *     compat primitives shipped at v1 with enforcement deferred to the
 *     External-Publisher Epic.
 */
import { z } from 'zod'

// ---------------------------------------------------------------------------
// Substrate-level constants
// ---------------------------------------------------------------------------

/**
 * Environment variables that no Capability's `auth.env_var` may shadow.
 *
 * Declared at the substrate, not at Capability frontmatter, so a malicious
 * or buggy Capability cannot opt out via frontmatter declaration. The Zod
 * schema's refine on `auth.env_var` rejects entries that name a blocked
 * variable at Capability load time.
 *
 * Pattern borrowed from Hermes Agent's `_HERMES_PROVIDER_ENV_BLOCKLIST`
 * (response to GHSA-rhgp-j443-p4rf, the real-world incident where a
 * skill registered `ANTHROPIC_TOKEN` as passthrough and received the
 * host's credential). MIT (c) 2025 Nous Research.
 *
 * Runtime enforcement (scrubbing these env vars from subprocess
 * environments at launch time) ships in Epic 16 Wave 1 item 6.
 */
export const PROVIDER_ENV_BLOCKLIST: ReadonlySet<string> = new Set([
  // Host LLM provider keys
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_TOKEN',
  'OPENAI_API_KEY',
  'OPENAI_TOKEN',
  'DEEPSEEK_API_KEY',
  'XAI_API_KEY',
  'GROK_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'MISTRAL_API_KEY',
  'GROQ_API_KEY',
  'COHERE_API_KEY',
  'TOGETHER_API_KEY',
  'PERPLEXITY_API_KEY',
  'OPENROUTER_API_KEY',
  'FIREWORKS_API_KEY',
  // Speech / vision LLM keys (host-managed when present)
  'ELEVENLABS_API_KEY',
  'DEEPGRAM_API_KEY',
  // 2200's own service tokens (reserved for the platform)
  '_2200_SUPERVISOR_TOKEN',
  '_2200_PUB_AUTH_TOKEN',
  '_2200_OPENSCUT_TOKEN',
  // Common credential-store / secret-manager vars the operator might
  // have at the OS level for their own use; Capabilities must not read
  // these directly.
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
])

/**
 * Marketing words rejected from Capability descriptions.
 *
 * The description is the picker's prompt budget; treating it as a
 * moderation surface keeps the catalog dense across hundreds of
 * entries. Word-boundary match (case-insensitive); precise enough that
 * false positives are rare in practice.
 */
const MARKETING_WORDS: readonly string[] = [
  'amazing',
  'powerful',
  'seamless',
  'delightful',
  'robust',
  'comprehensive',
  'cutting-edge',
  'world-class',
  'best-in-class',
  'revolutionary',
  'game-changing',
  'transformative',
  'beautiful',
  'elegant',
  'intuitive',
  'effortless',
  'magical',
  'awesome',
  'incredible',
  'state-of-the-art',
]

// ---------------------------------------------------------------------------
// Description hardline validation
// ---------------------------------------------------------------------------

/**
 * Reasons a description fails the hardline. Discriminated union so
 * callers can surface a precise error to the operator.
 */
export type DescriptionReject =
  | { kind: 'too-long'; length: number; max: 60 }
  | { kind: 'no-period' }
  | { kind: 'multi-sentence'; count: number }
  | { kind: 'marketing-word'; word: string }

/**
 * Validate a description against the hardline. Returns null on pass,
 * structured reject reason on fail.
 *
 * Rules (cumulative):
 *   1. ≤60 characters
 *   2. ends with a period
 *   3. single sentence (no period-space-uppercase mid-string)
 *   4. no marketing words from MARKETING_WORDS
 */
export function validateDescription(s: string): DescriptionReject | null {
  if (s.length > 60) return { kind: 'too-long', length: s.length, max: 60 }
  if (!/\.\s*$/.test(s)) return { kind: 'no-period' }
  // Sentence count: terminating punctuation followed by whitespace OR
  // end-of-string. Treats `...` as one terminator. False positive on
  // abbreviations with internal periods (e.g., `U.S.`); the catalog
  // can avoid those by rephrasing.
  const sentenceTerminators = s.match(/[.!?]+(?:\s|$)/g) ?? []
  if (sentenceTerminators.length > 1) {
    return { kind: 'multi-sentence', count: sentenceTerminators.length }
  }
  for (const word of MARKETING_WORDS) {
    // Word-boundary on hyphenated terms requires escaping the hyphen
    // in the regex character class; \b would split on the hyphen.
    const escaped = word.replace(/-/g, '\\-')
    const re = new RegExp(`(?:^|[^\\w-])${escaped}(?:[^\\w-]|$)`, 'i')
    if (re.test(s)) return { kind: 'marketing-word', word }
  }
  return null
}

// ---------------------------------------------------------------------------
// Auth (discriminated by kind)
// ---------------------------------------------------------------------------

/**
 * Auth shape per the Phase F doc §5 "Auth pattern primitives." 14
 * distinct shapes the catalog needs to express. Each one corresponds
 * to a credential-acquisition flow operators have seen in the wild.
 */
export const AuthKindSchema = z.enum([
  'api_key',
  'api_key_dual',
  'bot_token',
  'bot_token_plus_app_token',
  'app_id_secret_tenant',
  'oauth_browser_pkce',
  'oauth_download_client_secret',
  'service_account_json',
  'webhook_secret_plus_bot',
  'basic_username_password',
  'local_config_wizard',
  'local_permission_grant',
  'no_credentials',
  'hosted_service_ref',
])
export type AuthKind = z.infer<typeof AuthKindSchema>

export const CredentialDeclSchema = z.object({
  /** Canonical credential name; becomes the vault key. */
  name: z.string().min(1),
  /** Auth shape; see Phase F doc §5. */
  kind: AuthKindSchema,
  /** OAuth scopes (omit for non-oauth kinds). */
  scopes: z.array(z.string().min(1)).optional(),
  /**
   * Env-var name used as the operator-facing SecretRef. Must not
   * shadow a name on PROVIDER_ENV_BLOCKLIST: declared at the
   * substrate, not opt-out-able via frontmatter.
   */
  env_var: z
    .string()
    .min(1)
    .refine((v) => !PROVIDER_ENV_BLOCKLIST.has(v), {
      message:
        'auth.env_var shadows a substrate-level reserved name (host LLM provider key, platform token, or known secret-manager variable). Pick a Capability-scoped name (e.g., GMAIL_OAUTH_REF instead of GOOGLE_API_KEY).',
    }),
  /** URL where the operator obtains the credential. */
  obtain_url: z.url().optional(),
})
export type CredentialDecl = z.infer<typeof CredentialDeclSchema>

// ---------------------------------------------------------------------------
// Trust + behavior fields
// ---------------------------------------------------------------------------

/**
 * Publisher identity. Default `first-party` (2200-shipped catalog).
 * `local` reserved for operator-authored entries under
 * `~/.2200/catalog/capabilities/`. Any other string is a future
 * external-publisher identity, validated by the External-Publisher
 * Epic when that ships.
 */
export const PublisherSchema = z.string().min(1).default('first-party')

/**
 * Network egress declaration. v1 default `'unrestricted'` ... no
 * enforcement at v1; declared so the External-Publisher Epic's
 * runtime enforcement is additive, not retrofit.
 */
export const NetworkEgressSchema = z.object({
  domains: z.union([z.literal('unrestricted'), z.array(z.string().min(1))]).default('unrestricted'),
})

/**
 * What this Capability unlocks once provisioned. Each list is the
 * canonical name (tools by registry id, skills by slug, extensions
 * by id, providers by id). The preview UI's sub-toggle support
 * filters these lists per service when bundled Capabilities are
 * partially selected (post-task-7 polish per Phase F §7).
 */
export const UnlocksSchema = z.object({
  tools: z.array(z.string().min(1)).default([]),
  skills: z.array(z.string().min(1)).default([]),
  extensions: z.array(z.string().min(1)).default([]),
  providers: z.array(z.string().min(1)).default([]),
})

/**
 * Discovery + dependency surface. `bins` lists binaries that must
 * exist on PATH. `os` constrains to specific platforms (empty = all).
 * `capabilities` lists other Capabilities this one depends on
 * (walkthrough-runner enforces dependency ordering).
 */
export const RequiresSchema = z.object({
  bins: z.array(z.string().min(1)).default([]),
  os: z.array(z.enum(['darwin', 'linux', 'windows'])).default([]),
  capabilities: z.array(z.string().min(1)).default([]),
})

/**
 * UX hints for the operator-facing walkthrough. Estimated minutes is
 * advisory (used in the preview to set operator expectations).
 * Difficulty drives the recommended approval mode default for novice
 * operators.
 */
export const WalkthroughMetaSchema = z.object({
  estimated_minutes: z.number().int().positive().optional(),
  difficulty: z.enum(['easy', 'medium', 'hard']).optional(),
})

/**
 * Attribution + provenance. `attribution` names the source-of-record
 * for the entry's content. Each external source carries a path / URL
 * for audit (so we can re-trace what was lifted and from where).
 */
export const SourceSchema = z.object({
  attribution: z.enum(['original', 'openclaw', 'hermes', 'other']).default('original'),
  openclaw_path: z.string().optional(),
  hermes_path: z.string().optional(),
  other_url: z.url().optional(),
  notes: z.string().optional(),
})

// ---------------------------------------------------------------------------
// The full Capability frontmatter
// ---------------------------------------------------------------------------

/**
 * Capability frontmatter shape. Validated at Capability load time;
 * malformed entries are rejected with structured errors that point at
 * the offending field. The body of the markdown file is the
 * acquisition walkthrough prose (rendered separately by the
 * walkthrough runner).
 *
 * Defaults applied per the Phase F §0a locks (publisher → first-party,
 * network_egress.domains → unrestricted, source.attribution → original).
 */
export const CapabilityFrontmatterSchema = z.object({
  // Identity
  id: z
    .string()
    .min(1)
    .regex(
      /^[a-z][a-z0-9-]*$/,
      'Capability id must be lowercase letters/digits/dashes, starting with a letter',
    ),
  label: z.string().min(1),
  category: z.string().min(1),
  description: z.string().superRefine((val, ctx) => {
    const reject = validateDescription(val)
    if (reject) {
      switch (reject.kind) {
        case 'too-long':
          ctx.addIssue({
            code: 'custom',
            message: `description is ${String(reject.length)} chars; hardline is ≤60`,
          })
          break
        case 'no-period':
          ctx.addIssue({
            code: 'custom',
            message: 'description must end with a period',
          })
          break
        case 'multi-sentence':
          ctx.addIssue({
            code: 'custom',
            message: `description must be a single sentence (got ${String(reject.count)} sentence terminators)`,
          })
          break
        case 'marketing-word':
          ctx.addIssue({
            code: 'custom',
            message: `description contains marketing word "${reject.word}"; rephrase concretely`,
          })
          break
      }
    }
  }),
  homepage: z.url().optional(),

  // Trust + provenance
  publisher: PublisherSchema,
  source: SourceSchema.default({ attribution: 'original' }),

  // Acquisition
  auth: z.array(CredentialDeclSchema).default([]),

  // What this Capability unlocks once provisioned
  unlocks: UnlocksSchema.default({
    tools: [],
    skills: [],
    extensions: [],
    providers: [],
  }),

  // Behavior + scope
  network_egress: NetworkEgressSchema.default({ domains: 'unrestricted' }),

  // Discovery
  tags: z.array(z.string().min(1)).default([]),
  requires: RequiresSchema.default({ bins: [], os: [], capabilities: [] }),

  // UX hints
  walkthrough: WalkthroughMetaSchema.default({}),
})

export type CapabilityFrontmatter = z.infer<typeof CapabilityFrontmatterSchema>
