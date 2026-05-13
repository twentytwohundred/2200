/**
 * Custom OpenAI-compatible LLM endpoint config.
 *
 * Persisted at `<home>/config/endpoints.json` (mode 0600). Each entry
 * is one server the operator has registered ... typically a local
 * appliance like a DGX Spark running vLLM, an Ollama box, an LM Studio
 * instance, or any other OpenAI-compatible chat-completions endpoint.
 *
 * The endpoint's `id` is a slug; the Identity references it via
 * `provider: "endpoint:<id>"` so the LLM registry can dispatch to the
 * right base URL + key. `name` is the human label for the settings UI.
 *
 * Auth: optional bearer at v1. Stored in plaintext in the same file
 * (mode 0600), consistent with the existing runtime.env posture for
 * provider API keys. mTLS / OAuth deferred.
 */
import { z } from 'zod'

/**
 * Endpoint id slug. Lowercase alphanumeric + dashes; first character
 * must be a letter or digit. Used in the Identity's provider field
 * (`endpoint:<id>`) and in URL paths, so the slug rule is restrictive
 * on purpose.
 */
export const EndpointIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,49}$/, {
  message:
    'endpoint id must be a lowercase alphanumeric slug (dashes ok), 1..50 chars, starting with a letter or digit',
})
export type EndpointId = z.infer<typeof EndpointIdSchema>

export const EndpointModelSchema = z.object({
  /** Model id as returned by the endpoint's /v1/models response. */
  id: z.string().min(1).max(200),
  /** Optional human label. Defaults to `id` when absent in the UI. */
  label: z.string().max(200).optional(),
})
export type EndpointModel = z.infer<typeof EndpointModelSchema>

export const CustomEndpointSchema = z.object({
  schema_version: z.literal(1),
  id: EndpointIdSchema,
  /** Human display name. */
  name: z.string().min(1).max(80),
  /** Base URL, including the `/v1` segment when the server uses one. */
  base_url: z.url().max(500),
  /** Optional bearer token. Empty string when the server requires no auth. */
  api_key: z.string().max(2000).default(''),
  /** Selected models the user has chosen to expose to Agents. */
  models: z.array(EndpointModelSchema).default([]),
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
})
export type CustomEndpoint = z.infer<typeof CustomEndpointSchema>

export const EndpointsFileSchema = z.object({
  schema_version: z.literal(1),
  endpoints: z.array(CustomEndpointSchema).default([]),
})
export type EndpointsFile = z.infer<typeof EndpointsFileSchema>

export const EMPTY_ENDPOINTS_FILE: EndpointsFile = {
  schema_version: 1,
  endpoints: [],
}
