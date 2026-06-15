/**
 * Typed HTTP client over the runtime's v1 API.
 *
 * The frontend never imports runtime types ... it talks to the runtime
 * over the documented HTTP+WebSocket surface only. The wire shapes
 * defined here are the frontend's view of the contract; the runtime's
 * types are independent (see wiki/conventions/runtime-api.md).
 */
import { getToken } from './auth'

export interface ListEnvelope<T> {
  items: T[]
  cursor: { next: string | null; limit: number }
}

export interface ApiErrorBody {
  code: string
  message: string
  status: number
  details?: Record<string, unknown>
  request_id: string
}

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly requestId: string
  readonly details: Record<string, unknown> | undefined

  constructor(body: ApiErrorBody) {
    super(body.message)
    this.status = body.status
    this.code = body.code
    this.requestId = body.request_id
    this.details = body.details
  }
}

export class NetworkError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause))
    this.name = 'NetworkError'
  }
}

/**
 * Pulse v2 sub-document carried with every Agent DTO. `null` when the
 * Agent has never run on this home (no pulse.json yet) or when the
 * pulse file failed to parse. Pulse data is observability, not
 * load-bearing for the screen ... a missing pulse should still render
 * the row.
 *
 * - `state` is one of: 'resting' | 'working_light' | 'working_medium'
 *   | 'working_hard' | 'redlined' | 'stopped'.
 * - `intensity` is a smoothed activity metric in [0, 1].
 * - `detector_kind` and `trip_id` are populated only when the Agent
 *   is paused by a detector trip (state === 'redlined').
 */
export interface Pulse {
  state: 'resting' | 'working_light' | 'working_medium' | 'working_hard' | 'redlined' | 'stopped'
  intensity: number
  detector_kind: string | null
  trip_id: string | null
  updated_at: string
}

export interface AgentModel {
  provider: string
  model_id: string
  followup_model_id: string | null
}

export interface Agent {
  name: string
  status: string
  pid: number | null
  current_task_id: string | null
  identity_path: string
  created_at: string | null
  last_heartbeat: string | null
  errored_at: string | null
  errored_reason: string | null
  pulse: Pulse | null
  model: AgentModel | null
  /** Optional emoji / short glyph the user set on the Identity. */
  avatar: string | null
  /**
   * URL to fetch the Agent's uploaded portrait (cropped + compressed
   * webp). `null` when the operator hasn't uploaded one. When set,
   * the image takes precedence over `avatar` in the AgentMark.
   * Includes a cache-busting `?v=<mtime>` so updates land instantly.
   */
  avatar_image_url: string | null
  /**
   * Archive metadata. Present when the Agent has been archived
   * (directory renamed to `<name>-archived-<YYYY-MM-DD>`, status
   * `archived`). The UI uses `at` to display the archive date and
   * `reason` (when set) for the operator's note. `null` for live
   * Agents.
   */
  archived: { at: string; reason?: string } | null
}

/**
 * Per-day budget state surfaced by `GET /api/v1/agents/:name/budget`.
 * Sourced from `<home>/state/budget/<agent>/<day>.json` which the
 * Agent's BudgetTracker writes after each model call (Epic 4.5).
 *
 * `cumulative_usd` is today's spend so far. `cap_usd` is the
 * configured daily cap from the Agent's identity. `blocked` is true
 * when the cap has been crossed and new tasks are being refused.
 */
export interface BudgetState {
  day: string
  agent: string
  cumulative_usd: number
  cap_usd: number
  warn_at_pct: number
  warned_today: boolean
  blocked: boolean
  last_recorded_at: string | null
}

/**
 * Optional override that lifts the daily block until the named ISO
 * timestamp. Set via `2200 agent budget override <agent>` (Epic 4.5
 * PR E). Null when no override is in effect.
 */
export interface BudgetOverride {
  until: string
  reason: string | null
}

/**
 * Aggregate response from the budget endpoint: today's state, any
 * active override, and the full per-day history (oldest-first).
 * History is intended to drive the Sparkline + per-day breakdown on
 * the Budget screen.
 */
export interface BudgetResponse {
  today: BudgetState | null
  override: BudgetOverride | null
  history: BudgetState[]
  /**
   * Operator-set values read from identity.md (cost_caps). The
   * runtime keeps these separate from `today.cap_usd` (the cap the
   * live BudgetTracker is enforcing); they only converge after the
   * Agent restarts. The UI should display `configured.daily_usd` as
   * the "cap" so a fresh PUT shows up immediately.
   */
  configured: { daily_usd: number; warn_at_pct: number } | null
}

/**
 * Schedule (Epic 6 + Epic 15 Phase C) wire shapes.
 *
 * Cron form: 5-field cron + IANA timezone.
 * Interval form: every N seconds (>=5).
 */
export type ScheduleTiming =
  | { kind: 'cron'; expression: string; timezone: string }
  | { kind: 'interval'; interval_seconds: number }

export interface ScheduleEntry {
  id: string
  agent: string
  description: string
  prompt: string
  timing: ScheduleTiming
  enabled: boolean
  created_at: string
  last_fired_at: string | null
  next_fire_at: string | null
}

export interface ScheduleCreateBody {
  description?: string
  prompt: string
  timing: ScheduleTiming
  enabled?: boolean
}

/**
 * Tools (Epic 9 + Epic 15 Phase C) wire shapes. The runtime exposes
 * per-Agent MCP roster + tool-health summary at /api/v1/agents/:name/tools.
 */
export interface McpServerInfo {
  name: string
  transport: 'stdio' | 'http'
  command?: string
  arg_count?: number
  url?: string
  env_keys?: string[]
  auth_kind?: 'none' | 'bearer'
}

export interface ToolHealthEntry {
  tool: string
  total_calls: number
  ok_calls: number
  error_calls: number
  last_called_at: string | null
  last_error_at: string | null
  recent_failure_rate: number
  mean_duration_ms: number
  dormant: boolean
}

export interface ToolHealthSummary {
  agent: string
  generated_at: string
  total_records: number
  tools: ToolHealthEntry[]
  dormant: ToolHealthEntry[]
  failing: ToolHealthEntry[]
  options: {
    dormant_threshold_days: number
    recent_failure_window: number
  }
}

export interface AgentToolsResponse {
  agent: string
  mcp_servers: McpServerInfo[]
  health: ToolHealthSummary | null
}

/**
 * Skill ingest API ... see
 * wiki/decisions/2026-05-14-skill-ingest-substrate.md for the wire
 * shape and the wizard flow this drives.
 */
export type SkillToolClass =
  | 'file_create'
  | 'file_read'
  | 'external_send'
  | 'tool_invoke'
  | 'process_count'

export type SkillRequiredSecretKind = 'stdio_env' | 'http_bearer' | 'http_header'

export interface SkillRequiredSecret {
  key: string
  kind: SkillRequiredSecretKind
}

export type SkillExtractedServer =
  | {
      name: string
      transport: 'stdio'
      command: string
      args: string[]
      required_secrets: SkillRequiredSecret[]
      source: 'frontmatter' | 'body'
    }
  | {
      name: string
      transport: 'http'
      url: string
      auth_kind: 'none' | 'bearer'
      required_secrets: SkillRequiredSecret[]
      source: 'frontmatter' | 'body'
    }

export interface SkillPreview {
  name: string
  description: string
  body_preview: string
  tags: string[]
  declared_tools: string[]
  mcp_servers: SkillExtractedServer[]
  tool_classes: Record<string, SkillToolClass>
  tool_classes_warnings: string[]
  source_kind: 'local' | 'github' | 'skill_url'
}

export interface SkillInstallResult {
  skill: { name: string; description: string; path: string }
  mcp_installed_for: string[]
  requires_restart: string[]
  warnings: string[]
}

export interface SkillListEntry {
  name: string
  description: string
  tags: string[]
  status: 'ok' | 'invalid'
  reason?: string
}

export interface SkillUninstallResult {
  removed: boolean
  removed_from_agents: string[]
  requires_restart: string[]
}

export interface SkillCredentialEntry {
  env_key: string
  credential_name: string
  set_at: string | null
}

export interface SkillCredentialAgentGroup {
  agent: string
  server_name: string
  credentials: SkillCredentialEntry[]
}

export interface SkillCredentialsResponse {
  skill_name: string
  agents: SkillCredentialAgentGroup[]
}

export interface SkillCredentialUpdateResult {
  credential_name: string
  set_at: string
  requires_restart: string
}

/**
 * Task interaction (Epic 15 Phase C). Posting `{ body }` enqueues a
 * pending task; the running Agent's loop picks it up.
 */
export interface TaskCreateBody {
  title?: string
  body: string
  priority?: number
  idempotency?: 'pure' | 'checkpointed' | 'destructive'
}

export interface TaskCreateResponse {
  id: string
  agent: string
  state: string
  title: string
  created: string
}

/**
 * Brain note write (Epic 15 Phase C). POST `{ title, body, slug?, type?,
 * tags? }` creates or upserts a note. Returns the resulting BrainNote.
 */
export interface BrainNoteCreateBody {
  title: string
  body: string
  slug?: string
  type?: string
  tags?: string[]
}

/**
 * Chat (Epic 15 Phase C). Persistent conversation thread per Agent.
 * GET returns the full message log; POST appends a user message and
 * starts a task whose outcome lands as the assistant reply.
 */
export interface ChatMessage {
  id: string
  ts: string
  role: 'user' | 'assistant' | 'system'
  content: string
  task_id: string | null
}

export interface ChatPostResponse {
  message: ChatMessage
  task_id: string
}

// ── Custom LLM endpoints (Settings → Endpoints) ────────────────────────────

export interface CustomEndpointModelDto {
  id: string
  label?: string
}

export interface CustomEndpointDto {
  id: string
  name: string
  base_url: string
  api_key_set: boolean
  models: CustomEndpointModelDto[]
  created_at: string
  updated_at: string
}

// ── Multi-chat (design-system v1.1) ────────────────────────────────────────

export interface ChatThread {
  id: string
  title: string
  created_at: string
  updated_at: string
  unread: boolean
  archived: boolean
  snippet: string
  last_user_at: string | null
}

export type ChatSendMode = 'pure' | 'checkpointed' | 'destructive'
export type ChatAttachmentKind = 'file' | 'image'

export interface ChatAttachmentRef {
  id: string
  kind: ChatAttachmentKind
  name: string
  size: number
  mime: string
}

export interface ChatAttachmentUploaded extends ChatAttachmentRef {
  url: string
}

/**
 * Runtime-side discriminator for system-authored messages. Used by the
 * renderer to swap the message body for a specialized card:
 *   - `audit`              ... claim-vs-evidence audit card
 *   - `credential_request` ... operator-paste credential prompt
 */
export type ChatMessageKind = 'audit' | 'credential_request'

/**
 * Structured audit card payload. The runtime serializes this into the
 * `body` field of an audit message as a JSON envelope; the renderer
 * parses it back. Stable wire shape across the runtime ↔ web boundary
 * so a runtime upgrade can't silently break the renderer.
 */
export interface AuditCardClaim {
  category:
    | 'file_create'
    | 'file_read'
    | 'external_send'
    | 'tool_invoke'
    | 'process_count'
    | 'refusal'
    | 'credential_request'
  verb: string
  object: string
  status: 'verified' | 'unverified' | 'contradicted'
  note: string
  path?: string
  tool?: string
  target?: string
  count?: number
  reason?: string
  credential_name?: string
}

export interface AuditCardEnvelope {
  envelope: 'audit_card_v1'
  task_id: string
  severity: 'silent' | 'passive' | 'normal' | 'important'
  summary: string
  destructive: boolean
  at: string
  claims: AuditCardClaim[]
}

/**
 * Frozen wire shape for credential_request system-role messages and
 * WS event payloads. v1 ships with the runtime as
 * `credential_request_v1`; new fields go on a `v2` envelope rather
 * than in-place. See decision:
 * wiki/decisions/2026-05-14-request-credential-substrate.md
 */
export type CredentialRequestKind = 'value' | 'secret' | 'file'
export type CredentialRequestState = 'pending' | 'fulfilled' | 'declined' | 'expired'
export type CredentialExpiredReason = 'timeout' | 'agent_crashed' | 'agent_archived'

export interface CredentialRequestEnvelopeV1 {
  envelope: 'credential_request_v1'
  request_id: string
  label: string
  help: string
  kind: CredentialRequestKind
  reason: string
  destination_credential_name: string
  expires_at: string
  state: CredentialRequestState
}

/** Full record shape as returned by GET /api/v1/agents/:name/credential-requests. */
export interface CredentialRequest {
  id: string
  agent: string
  chat_id: string
  state: CredentialRequestState
  label: string
  help: string
  kind: CredentialRequestKind
  reason: string
  credential_name: string
  created_at: string
  expires_at: string
  fulfilled_at: string | null
  declined_at: string | null
  decline_reason: string | null
  expired_at: string | null
  expired_reason: CredentialExpiredReason | null
}

export interface ChatThreadMessage {
  id: string
  chat_id: string
  ts: string
  role: 'user' | 'assistant' | 'system'
  body: string
  mode: ChatSendMode | null
  attachments: ChatAttachmentRef[]
  task_id: string | null
  /** System-role discriminator; see ChatMessageKind. */
  kind: ChatMessageKind | null
}

export interface ChatThreadPostBody {
  body: string
  mode?: ChatSendMode
  attachments?: ChatAttachmentRef[]
}

export interface ChatThreadPostResponse {
  message: ChatThreadMessage
  task_id: string
}

/**
 * Task list item (Epic 15 Phase C). Surfaces just enough to render a
 * "what has this Agent been working on" panel without leaking the
 * full task body / checkpoint payload.
 */
export type TaskState =
  | 'pending'
  | 'running'
  | 'blocked_on_user'
  | 'blocked_on_agent'
  | 'blocked_on_detector'
  | 'done'
  | 'errored'

export interface TaskListItem {
  id: string
  agent: string
  state: TaskState
  title: string
  created: string
  last_at: string | null
  detector_kind: string | null
  iterations: number | null
  outcome_preview: string | null
  source: 'chat' | 'other'
}

export interface TaskDetail extends TaskListItem {
  body: string
  outcome_summary: string | null
  error_message: string | null
  error_class: string | null
  detector_detail: string | null
  detector_trip_id: string | null
  checkpoint_iteration: number | null
  checkpoint_taken_at: string | null
  idempotency: string
  priority: number
}

/**
 * Brain (Epic 15 Phase C) wire shapes. The runtime exposes per-Agent
 * note list, FTS5 search, and single-note fetch via three endpoints
 * under /api/v1/agents/:name/brain.
 */
export interface BrainNoteListItem {
  slug: string
  title: string
  type: string
  tags: string[]
  created: string
  updated: string
  links: string[]
  preview: string
}

export interface BrainNote extends BrainNoteListItem {
  body: string
}

export interface BrainSearchHit {
  slug: string
  title: string
  type: string
  tags: string[]
  snippet: string
  score: number
}

export interface BrainSearchResponse {
  items: BrainSearchHit[]
  cursor: { next: string | null; limit: number }
  /** 'fts' = SQLite FTS5; 'fallback' = in-memory list scan when no index exists. */
  mode: 'fts' | 'fallback'
}

/**
 * Onboarding (Epic 14 Phase A + Epic 15 Phase B) wire shapes.
 *
 * Driven by the server-side state machine at /api/v1/onboarding (the
 * runtime's OnboardingSession). The web Card Stack consumes these
 * directly; field shapes mirror what session.ts returns but are
 * declared here independently per the runtime/client boundary.
 */
export type OnboardingState =
  | 'awaiting_opening'
  | 'awaiting_branch_question'
  | 'summarizing'
  | 'done'
  | 'confirmed'
  | 'cancelled'
  | 'errored'

export interface OnboardingQuestion {
  index: number
  /** Total once a branch is chosen; null while the opening is in flight. */
  total: number | null
  question: {
    id: string
    text: string
    /** 'free_form' today; left as string for forward-compat with future expects kinds. */
    expects: string
    intent_tag?: string
  }
}

export interface OnboardingTranscriptEntry {
  question_id: string
  question_text: string
  answer: string
  intent_tag?: string
  asked_at: string
}

export interface OnboardingTranscript {
  interview_schema_version: number
  script_name: string
  chosen_branch: string
  entries: OnboardingTranscriptEntry[]
  summary: string
  started_at: string
  finished_at: string
}

export interface OnboardingToolSuggestion {
  server: { name: string }
  env_hint: string
  rationale: string
  source_tag: string
}

export interface OnboardingScheduleSuggestion {
  id: string
  cron: string
  tz: string
  task: string
  rationale: string
  source_tag: string
}

/**
 * One Capability suggestion ranked against the interview transcript
 * (Phase F §2/§7). `default_on=true` entries were auto-applied into
 * the handoff by the session; the wizard's picker lets the operator
 * deselect them or opt-in to the speculative ones.
 */
export interface OnboardingCapabilitySuggestion {
  capability: {
    frontmatter: {
      id: string
      label: string
      category: string
      description: string
      walkthrough?: { estimated_minutes?: number; difficulty?: string }
      auth?: { name: string }[]
      [k: string]: unknown
    }
  }
  matched_tags: string[]
  overlap_count: number
  confidence: 'high' | 'speculative'
  default_on: boolean
}

/**
 * An external service the Agent needs that 2200 doesn't have a connector
 * for yet (Spotify, Instagram, ...), extracted from the free-form
 * interview. The runtime also records each as a catalog gap (demand
 * signal). Surfaced so the operator sees what was heard, not a blank "0".
 */
export interface OnboardingNeededIntegration {
  name: string
  purpose: string
}

export interface OnboardingPreview {
  transcript: OnboardingTranscript
  /** Opaque to the web client; surfaced via summary + agent_name. */
  handoff: { frontmatter: { agent_name: string; [k: string]: unknown }; body: string }
  tools: OnboardingToolSuggestion[]
  schedules: OnboardingScheduleSuggestion[]
  capabilities: OnboardingCapabilitySuggestion[]
  needed_integrations?: OnboardingNeededIntegration[]
  agent_name: string
}

export interface OnboardingSessionResponse {
  session_id: string
  state: OnboardingState
  question: OnboardingQuestion | null
  preview?: OnboardingPreview | null
}

export interface OnboardingConfirmResponse {
  session_id: string
  agent_name: string
  identity_path: string
  continuity_note_slug: string | null
  transcript_path: string | null
  tools: { server: string; env_hint: string }[]
  schedules: OnboardingScheduleSuggestion[]
  /** True when the runtime auto-started the new Agent process. v1
   *  always attempts the start; auto_started=false means it failed. */
  auto_started: boolean
  /** Error message when auto_started=false; null on success. */
  auto_start_error: string | null
}

export interface Notification {
  id: string
  ts: string
  tier: string
  agent: string
  kind: string
  state: string
  requires_response: boolean
  response: string | null
  resolved_at: string | null
  body: string
}

export interface Me {
  kind: 'user' | 'agent'
  name: string
  token_id: string
}

export interface RuntimeHealth {
  healthy: boolean
  components: Record<string, string>
}

export interface RuntimeVersion {
  api: string
  runtime: string
}

/**
 * Settings page representation of a single LLM provider entry. Carries
 * static catalog metadata (name, label, default env key) plus the
 * runtime view (whether the key is set, masked tail, agents using it).
 */
export interface ProviderSettingsItem {
  name: string
  label: string
  defaultEnvKey: string
  kind: 'anthropic' | 'openai-compatible' | 'local'
  baseUrl: string
  baseUrlEditable: boolean
  baseUrlEnvKey: string
  keyOptional: boolean
  key_set: boolean
  key_masked: string | null
  agents_using: string[]
  suggested_models: string[]
  /**
   * Settings-UI category. Drives optgroup placement in the model picker
   * and section grouping in Settings ▸ Models & API Keys.
   *   - 'subscription': OAuth subscription credential (xAI / SuperGrok)
   *   - 'api-key':      Paste-an-API-key (Anthropic, OpenAI, xAI, ...)
   *   - 'local':        Self-hosted (Ollama / LM Studio / vLLM)
   */
  category: 'subscription' | 'api-key' | 'local'
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  body?: unknown
  signal?: AbortSignal
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const token = getToken()
  const headers: Record<string, string> = {
    accept: 'application/json',
  }
  if (token) headers.authorization = `Bearer ${token}`
  if (opts.body !== undefined) headers['content-type'] = 'application/json; charset=utf-8'

  const init: RequestInit = {
    method: opts.method ?? 'GET',
    headers,
  }
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body)
  if (opts.signal) init.signal = opts.signal

  let res: Response
  try {
    res = await fetch(path, init)
  } catch (err) {
    throw new NetworkError(err)
  }

  const text = await res.text()
  let parsed: unknown = text
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text)
    } catch {
      /* keep as text; the caller will surface */
    }
  }

  if (!res.ok) {
    const errorBody = extractErrorBody(parsed)
    if (errorBody) throw new ApiError(errorBody)
    throw new ApiError({
      code: 'http_error',
      message: typeof parsed === 'string' ? parsed : `HTTP ${String(res.status)}`,
      status: res.status,
      request_id: 'unknown',
    })
  }

  return parsed as T
}

function extractErrorBody(parsed: unknown): ApiErrorBody | null {
  if (!parsed || typeof parsed !== 'object' || !('error' in parsed)) return null
  const body: unknown = parsed.error
  if (!body || typeof body !== 'object') return null
  const fields = body as Partial<ApiErrorBody>
  if (typeof fields.code !== 'string') return null
  if (typeof fields.message !== 'string') return null
  if (typeof fields.status !== 'number') return null
  if (typeof fields.request_id !== 'string') return null
  return {
    code: fields.code,
    message: fields.message,
    status: fields.status,
    request_id: fields.request_id,
    ...(fields.details ? { details: fields.details } : {}),
  }
}

export const api = {
  me: () => request<Me>('/api/v1/me'),
  health: () => request<RuntimeHealth>('/api/v1/runtime/health'),
  version: () => request<RuntimeVersion>('/api/v1/runtime/version'),
  agents: () => request<ListEnvelope<Agent>>('/api/v1/agents'),
  agent: (name: string) => request<Agent>(`/api/v1/agents/${encodeURIComponent(name)}`),
  agentStart: (name: string) =>
    request<Agent>(`/api/v1/agents/${encodeURIComponent(name)}/start`, { method: 'POST' }),
  agentStop: (name: string, reason?: string) =>
    request<Agent>(`/api/v1/agents/${encodeURIComponent(name)}/stop`, {
      method: 'POST',
      body: reason ? { reason } : undefined,
    }),
  /**
   * Archive an Agent. Renames every per-Agent on-disk subtree to
   * `<name>-archived-<YYYY-MM-DD>` so the original name is freed for
   * a future Agent. Brain, chats, identity move with the rename;
   * scheduled tasks are cancelled. Returns the renamed Agent record.
   */
  agentArchive: (name: string, reason?: string) =>
    request<Agent>(`/api/v1/agents/${encodeURIComponent(name)}/archive`, {
      method: 'POST',
      body: reason ? { reason } : undefined,
    }),
  /**
   * Reverse archive. By default restores the pre-archive name; pass
   * `rename_to` to land on a different name (necessary if the
   * original is now in use). Does not auto-start the Agent ... the
   * operator brings it back up explicitly.
   */
  agentUnarchive: (name: string, rename_to?: string) =>
    request<Agent>(`/api/v1/agents/${encodeURIComponent(name)}/unarchive`, {
      method: 'POST',
      body: rename_to ? { rename_to } : undefined,
    }),
  budget: (name: string) =>
    request<BudgetResponse>(`/api/v1/agents/${encodeURIComponent(name)}/budget`),
  /**
   * Edit the Agent's daily cap and/or warn threshold. Writes to
   * identity.md; the running AgentProcess keeps its loaded cap until
   * restart, so `applies_on_restart=true` means the operator needs to
   * cycle the Agent to enforce the new value.
   */
  agentBudgetSet: (name: string, body: { daily_usd?: number; warn_at_pct?: number }) =>
    request<{
      path: string
      daily_usd: number
      warn_at_pct: number
      applies_on_restart: boolean
    }>(`/api/v1/agents/${encodeURIComponent(name)}/budget`, {
      method: 'PUT',
      body,
    }),
  agentTools: (name: string) =>
    request<AgentToolsResponse>(`/api/v1/agents/${encodeURIComponent(name)}/tools`),
  agentTasks: (name: string, params?: { state?: TaskState; limit?: number }) => {
    const qs = new URLSearchParams()
    if (params?.state) qs.set('state', params.state)
    if (params?.limit !== undefined) qs.set('limit', String(params.limit))
    const suffix = qs.toString() ? `?${qs.toString()}` : ''
    return request<ListEnvelope<TaskListItem>>(
      `/api/v1/agents/${encodeURIComponent(name)}/tasks${suffix}`,
    )
  },
  agentTask: (name: string, id: string) =>
    request<TaskDetail>(
      `/api/v1/agents/${encodeURIComponent(name)}/tasks/${encodeURIComponent(id)}`,
    ),
  brainList: (name: string, params?: { type?: string; tag?: string; limit?: number }) => {
    const qs = new URLSearchParams()
    if (params?.type) qs.set('type', params.type)
    if (params?.tag) qs.set('tag', params.tag)
    if (params?.limit !== undefined) qs.set('limit', String(params.limit))
    const suffix = qs.toString() ? `?${qs.toString()}` : ''
    return request<ListEnvelope<BrainNoteListItem>>(
      `/api/v1/agents/${encodeURIComponent(name)}/brain${suffix}`,
    )
  },
  brainSearch: (name: string, query: string, limit?: number) => {
    const qs = new URLSearchParams({ q: query })
    if (limit !== undefined) qs.set('limit', String(limit))
    return request<BrainSearchResponse>(
      `/api/v1/agents/${encodeURIComponent(name)}/brain/search?${qs.toString()}`,
    )
  },
  brainNote: (name: string, slug: string) =>
    request<BrainNote>(
      `/api/v1/agents/${encodeURIComponent(name)}/brain/note/${encodeURIComponent(slug)}`,
    ),
  brainWrite: (name: string, body: BrainNoteCreateBody) =>
    request<BrainNote>(`/api/v1/agents/${encodeURIComponent(name)}/brain`, {
      method: 'POST',
      body,
    }),
  brainEdit: (
    name: string,
    slug: string,
    body: { title: string; body: string; type?: string; tags?: string[] },
  ) =>
    request<BrainNote>(
      `/api/v1/agents/${encodeURIComponent(name)}/brain/note/${encodeURIComponent(slug)}`,
      { method: 'PATCH', body },
    ),
  brainDelete: (name: string, slug: string) =>
    request<{ slug: string; deleted: true }>(
      `/api/v1/agents/${encodeURIComponent(name)}/brain/note/${encodeURIComponent(slug)}`,
      { method: 'DELETE' },
    ),
  chatList: (name: string) =>
    request<ListEnvelope<ChatMessage>>(`/api/v1/agents/${encodeURIComponent(name)}/chat`),
  chatSend: (name: string, content: string) =>
    request<ChatPostResponse>(`/api/v1/agents/${encodeURIComponent(name)}/chat`, {
      method: 'POST',
      body: { content },
    }),
  chatsList: (name: string) =>
    request<ListEnvelope<ChatThread>>(`/api/v1/agents/${encodeURIComponent(name)}/chats`),
  chatThreadCreate: (name: string, title?: string) =>
    request<{ chat: ChatThread }>(`/api/v1/agents/${encodeURIComponent(name)}/chats`, {
      method: 'POST',
      body: title !== undefined ? { title } : {},
    }),
  chatThreadGet: (name: string, chatId: string) =>
    request<{ chat: ChatThread }>(
      `/api/v1/agents/${encodeURIComponent(name)}/chats/${encodeURIComponent(chatId)}`,
    ),
  chatThreadRename: (name: string, chatId: string, title: string) =>
    request<{ chat: ChatThread }>(
      `/api/v1/agents/${encodeURIComponent(name)}/chats/${encodeURIComponent(chatId)}`,
      { method: 'PATCH', body: { title } },
    ),
  chatThreadArchive: (name: string, chatId: string, archived: boolean) =>
    request<{ chat: ChatThread }>(
      `/api/v1/agents/${encodeURIComponent(name)}/chats/${encodeURIComponent(chatId)}/archive`,
      { method: 'POST', body: { archived } },
    ),
  chatThreadRead: (name: string, chatId: string) =>
    request<{ ok: true }>(
      `/api/v1/agents/${encodeURIComponent(name)}/chats/${encodeURIComponent(chatId)}/read`,
      { method: 'POST' },
    ),
  chatMessagesList: (name: string, chatId: string) =>
    request<ListEnvelope<ChatThreadMessage>>(
      `/api/v1/agents/${encodeURIComponent(name)}/chats/${encodeURIComponent(chatId)}/messages`,
    ),
  chatMessageSend: (name: string, chatId: string, body: ChatThreadPostBody) =>
    request<ChatThreadPostResponse>(
      `/api/v1/agents/${encodeURIComponent(name)}/chats/${encodeURIComponent(chatId)}/messages`,
      { method: 'POST', body },
    ),
  chatAttachmentUpload: (
    name: string,
    chatId: string,
    body: { name: string; mime: string; kind: ChatAttachmentKind; data_base64: string },
  ) =>
    request<{ attachment: ChatAttachmentUploaded }>(
      `/api/v1/agents/${encodeURIComponent(name)}/chats/${encodeURIComponent(chatId)}/attachments`,
      { method: 'POST', body },
    ),
  chatAttachmentUrl: (name: string, chatId: string, attId: string, filename: string): string =>
    `/api/v1/agents/${encodeURIComponent(name)}/chats/${encodeURIComponent(chatId)}/attachments/${encodeURIComponent(attId)}/${encodeURIComponent(filename)}`,
  endpointsList: () => request<ListEnvelope<CustomEndpointDto>>('/api/v1/settings/endpoints'),
  endpointCreate: (body: {
    id?: string
    name: string
    base_url: string
    api_key?: string
    models?: CustomEndpointModelDto[]
    discover?: boolean
  }) =>
    request<{
      endpoint: CustomEndpointDto
      discovered_models: { id: string }[]
      discover_error: { kind: string; message: string } | null
    }>('/api/v1/settings/endpoints', { method: 'POST', body }),
  endpointGet: (id: string) =>
    request<{ endpoint: CustomEndpointDto }>(
      `/api/v1/settings/endpoints/${encodeURIComponent(id)}`,
    ),
  endpointUpdate: (
    id: string,
    patch: {
      name?: string
      base_url?: string
      api_key?: string
      models?: CustomEndpointModelDto[]
    },
  ) =>
    request<{ endpoint: CustomEndpointDto }>(
      `/api/v1/settings/endpoints/${encodeURIComponent(id)}`,
      { method: 'PATCH', body: patch },
    ),
  endpointDelete: (id: string) =>
    request<{ id: string; deleted: true }>(`/api/v1/settings/endpoints/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
  endpointDiscover: (body: { base_url: string; api_key?: string }) =>
    request<
      | { ok: true; models: { id: string }[] }
      | { ok: false; error: { kind: string; message: string } }
    >('/api/v1/settings/endpoints/discover', { method: 'POST', body }),
  /**
   * Live-poll an already-saved endpoint's models without re-passing
   * the api_key. Used by the Endpoints UI to show what the upstream
   * server is currently serving (e.g. a homelab box swapping between
   * model loads). The runtime resolves the saved key on the server
   * side so the browser never re-handles it.
   */
  endpointModels: (id: string) =>
    request<
      | {
          ok: true
          endpoint_id: string
          models: { id: string }[]
          fetched_at: string
        }
      | {
          ok: false
          endpoint_id: string
          error: { kind: string; message: string }
          fetched_at: string
        }
    >(`/api/v1/settings/endpoints/${encodeURIComponent(id)}/models`),
  /**
   * Build an image-loadable URL for an endpoint that requires the
   * bearer token. The browser's `<img>` tag cannot set an
   * Authorization header, so the runtime accepts `?token=...` as an
   * equivalent (same trick the WebSocket uses). Returns null when
   * the input is null/empty so callers can do
   * `imageUrl={api.authedUrl(agent.avatar_image_url)}` without
   * extra guards.
   */
  authedUrl: (url: string | null | undefined): string | null => {
    if (!url) return null
    const token = getToken()
    if (!token) return url
    const sep = url.includes('?') ? '&' : '?'
    return `${url}${sep}token=${encodeURIComponent(token)}`
  },
  identityRead: (name: string) =>
    request<{ path: string; content: string }>(
      `/api/v1/agents/${encodeURIComponent(name)}/identity`,
    ),
  identityWrite: (name: string, content: string) =>
    request<{ path: string; bytes_written: number; restart_required: boolean }>(
      `/api/v1/agents/${encodeURIComponent(name)}/identity`,
      { method: 'PUT', body: { content } },
    ),
  agentAvatarSet: (name: string, avatar: string) =>
    request<{ path: string; avatar: string | null }>(
      `/api/v1/agents/${encodeURIComponent(name)}/avatar`,
      { method: 'PUT', body: { avatar } },
    ),
  agentAvatarImageSet: (name: string, body: { data_base64: string; mime: string }) =>
    request<{ path: string; bytes: number; url: string }>(
      `/api/v1/agents/${encodeURIComponent(name)}/avatar/image`,
      { method: 'PUT', body },
    ),
  agentAvatarImageDelete: (name: string) =>
    request<{ ok: true }>(`/api/v1/agents/${encodeURIComponent(name)}/avatar/image`, {
      method: 'DELETE',
    }),
  agentModelSet: (
    name: string,
    body: { provider: string; model_id: string; followup_model_id?: string | null },
  ) =>
    request<{
      path: string
      provider: string
      model_id: string
      followup_model_id: string | null
      restart_required: boolean
    }>(`/api/v1/agents/${encodeURIComponent(name)}/model`, { method: 'PUT', body }),
  settingsProvidersList: () =>
    request<{
      runtime_env_path: string
      items: ProviderSettingsItem[]
    }>('/api/v1/settings/providers'),
  settingsProviderKeySet: (id: string, key: string) =>
    request<{
      provider: string
      env_key: string
      key_set: boolean
      key_masked: string | null
      restart_required: boolean
    }>(`/api/v1/settings/providers/${encodeURIComponent(id)}/key`, {
      method: 'PUT',
      body: { key },
    }),
  settingsProviderKeyClear: (id: string) =>
    request<{ provider: string; env_key: string; key_set: boolean; restart_required: boolean }>(
      `/api/v1/settings/providers/${encodeURIComponent(id)}/key`,
      { method: 'DELETE' },
    ),
  settingsLocalUrlSet: (baseUrl: string) =>
    request<{ provider: 'local'; base_url: string; restart_required: boolean }>(
      '/api/v1/settings/providers/local/url',
      { method: 'PUT', body: { base_url: baseUrl } },
    ),
  taskCreate: (name: string, body: TaskCreateBody) =>
    request<TaskCreateResponse>(`/api/v1/agents/${encodeURIComponent(name)}/tasks`, {
      method: 'POST',
      body,
    }),
  schedulesList: (name: string) =>
    request<ListEnvelope<ScheduleEntry>>(`/api/v1/agents/${encodeURIComponent(name)}/schedules`),
  scheduleCreate: (name: string, body: ScheduleCreateBody) =>
    request<ScheduleEntry>(`/api/v1/agents/${encodeURIComponent(name)}/schedules`, {
      method: 'POST',
      body,
    }),
  scheduleSetEnabled: (name: string, id: string, enabled: boolean) =>
    request<ScheduleEntry>(
      `/api/v1/agents/${encodeURIComponent(name)}/schedules/${encodeURIComponent(id)}`,
      { method: 'PATCH', body: { enabled } },
    ),
  scheduleDelete: (name: string, id: string) =>
    request<{ id: string; deleted: true }>(
      `/api/v1/agents/${encodeURIComponent(name)}/schedules/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    ),
  notifications: (params?: { state?: string; tier?: string; agent?: string }) => {
    const qs = new URLSearchParams()
    if (params?.state) qs.set('state', params.state)
    if (params?.tier) qs.set('tier', params.tier)
    if (params?.agent) qs.set('agent', params.agent)
    const suffix = qs.toString() ? `?${qs.toString()}` : ''
    return request<ListEnvelope<Notification>>(`/api/v1/notifications${suffix}`)
  },
  notificationRespond: (id: string, response: string) =>
    request<Notification>(`/api/v1/notifications/${encodeURIComponent(id)}/respond`, {
      method: 'POST',
      body: { response },
    }),
  notificationDismiss: (id: string) =>
    request<Notification>(`/api/v1/notifications/${encodeURIComponent(id)}/dismiss`, {
      method: 'POST',
    }),
  credentialRequestList: (
    agent: string,
    params?: { state?: CredentialRequestState; chat_id?: string },
  ) => {
    const qs = new URLSearchParams()
    if (params?.state) qs.set('state', params.state)
    if (params?.chat_id) qs.set('chat_id', params.chat_id)
    const suffix = qs.toString() ? `?${qs.toString()}` : ''
    return request<{ items: CredentialRequest[] }>(
      `/api/v1/agents/${encodeURIComponent(agent)}/credential-requests${suffix}`,
    )
  },
  credentialRequestFulfill: (agent: string, id: string, value: string) =>
    request<CredentialRequest>(
      `/api/v1/agents/${encodeURIComponent(agent)}/credential-requests/${encodeURIComponent(id)}/fulfill`,
      { method: 'POST', body: { value } },
    ),
  credentialRequestDecline: (agent: string, id: string, reason?: string) =>
    request<CredentialRequest>(
      `/api/v1/agents/${encodeURIComponent(agent)}/credential-requests/${encodeURIComponent(id)}/decline`,
      {
        method: 'POST',
        body: reason !== undefined ? { reason } : {},
      },
    ),
  onboardingStart: (body?: { provider?: string; model?: string; script?: string }) =>
    request<OnboardingSessionResponse>('/api/v1/onboarding', {
      method: 'POST',
      body: body ?? {},
    }),
  onboardingGet: (id: string) =>
    request<OnboardingSessionResponse>(`/api/v1/onboarding/${encodeURIComponent(id)}`),
  onboardingAnswer: (id: string, answer: string) =>
    request<OnboardingSessionResponse>(`/api/v1/onboarding/${encodeURIComponent(id)}/answer`, {
      method: 'POST',
      body: { answer },
    }),
  onboardingConfirm: (id: string, body?: { selected_capabilities?: string[] }) =>
    request<OnboardingConfirmResponse>(`/api/v1/onboarding/${encodeURIComponent(id)}/confirm`, {
      method: 'POST',
      body: body ?? {},
    }),
  onboardingCancel: (id: string) =>
    request<{ session_id: string; state: 'cancelled' }>(
      `/api/v1/onboarding/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    ),
  fleet: () => request<FleetResponse>('/api/v1/fleet'),
  pubsList: () => request<ListEnvelope<PubSummary>>('/api/v1/pubs'),
  pub: (name: string) => request<PubDetail>(`/api/v1/pubs/${encodeURIComponent(name)}`),
  pubMessages: (name: string, opts?: { limit?: number; since?: string }) => {
    const qs = new URLSearchParams()
    if (opts?.limit !== undefined) qs.set('limit', String(opts.limit))
    if (opts?.since !== undefined) qs.set('since', opts.since)
    const suffix = qs.toString() ? `?${qs.toString()}` : ''
    return request<ListEnvelope<PubMessage>>(
      `/api/v1/pubs/${encodeURIComponent(name)}/messages${suffix}`,
    )
  },
  pubSend: (
    name: string,
    body: {
      content: string
      mentions?: string[]
      reply_to?: string | null
      attachments?: { filename: string; content_type: string; base64: string }[]
    },
  ) =>
    request<{ message_id: string; timestamp: string }>(
      `/api/v1/pubs/${encodeURIComponent(name)}/messages`,
      { method: 'POST', body },
    ),
  pubReact: (name: string, body: { message_id: string; emoji: string }) =>
    request<null>(`/api/v1/pubs/${encodeURIComponent(name)}/reactions`, {
      method: 'POST',
      body,
    }),
  /**
   * Create a new studio (pub) with custom membership. Each named
   * agent gets the new pub appended to its `pubs.md` file and is
   * restarted so the wake source attaches. Agents without
   * `pub.identity` set are rejected ... provision them via
   * `2200 agent identity provision` first.
   */
  pubCreate: (body: { name: string; members: string[]; description?: string }) =>
    request<{
      name: string
      port: number
      pub_md_path: string
      members: string[]
      restarted: { name: string; was_running: boolean }[]
    }>(`/api/v1/pubs`, { method: 'POST', body }),
  /**
   * Add / remove guests from an existing Room. Adds register the
   * agent with the pub-server and prepend it to pubs.md; removes
   * drop the pub from pubs.md (the pub-server roster entry stays
   * since OpenPub has no agent-deletion endpoint). Both restart the
   * affected agents so wake sources attach/detach.
   */
  pubUpdateGuests: (name: string, body: { add_guests?: string[]; remove_guests?: string[] }) =>
    request<{
      name: string
      added: string[]
      removed: string[]
      restarted: { name: string; was_running: boolean }[]
    }>(`/api/v1/pubs/${encodeURIComponent(name)}`, { method: 'PATCH', body }),
  /**
   * Destroy a Room. The canonical Studio pub is refused (returns
   * 409). Caller MUST pass `{ confirm: "DESTROY" }` ... the UI
   * surfaces this as a typed-confirm input.
   */
  pubDestroy: (name: string) =>
    request<{
      name: string
      destroyed: boolean
      restarted: { name: string; was_running: boolean }[]
    }>(`/api/v1/pubs/${encodeURIComponent(name)}?confirm=DESTROY`, {
      method: 'DELETE',
    }),
  /**
   * Build a fully-qualified URL for a pub attachment served by the
   * GET /api/v1/pubs/attachments/:attId/:filename route. Run through
   * `authedUrl` so `<img>` tags can fetch it without an Authorization
   * header (the runtime accepts `?token=` for read routes).
   */
  pubAttachmentUrl: (attId: string, filename: string): string =>
    `/api/v1/pubs/attachments/${encodeURIComponent(attId)}/${encodeURIComponent(filename)}`,

  skillsList: () => request<ListEnvelope<SkillListEntry>>('/api/v1/skills'),
  skillsPreview: (source: string) =>
    request<SkillPreview>('/api/v1/skills/preview', {
      method: 'POST',
      body: { source },
    }),
  skillsInstall: (body: {
    source: string
    agents: string[]
    secrets: Record<string, Record<string, Record<string, string>>>
    force?: boolean
  }) =>
    request<SkillInstallResult>('/api/v1/skills/install', {
      method: 'POST',
      body,
    }),
  skillsUninstall: (name: string, agents?: string[]) =>
    request<SkillUninstallResult>(`/api/v1/skills/${encodeURIComponent(name)}`, {
      method: 'DELETE',
      body: agents ? { agents } : undefined,
    }),
  skillCredentials: (name: string) =>
    request<SkillCredentialsResponse>(`/api/v1/skills/${encodeURIComponent(name)}/credentials`),
  skillCredentialUpdate: (name: string, agent: string, envKey: string, value: string) =>
    request<SkillCredentialUpdateResult>(
      `/api/v1/skills/${encodeURIComponent(name)}/credentials/${encodeURIComponent(agent)}/${encodeURIComponent(envKey)}`,
      { method: 'PUT', body: { value } },
    ),
}

export interface FleetResponse {
  markdown: string
  path: string
  generated_at: string | null
}

export interface PubSummary {
  name: string
  state: string
  port: number
  pid: number | null
  created_at: string | null
  errored_at: string | null
  errored_reason: string | null
}

export interface PubMember {
  agent_id: string
  display_name: string
  status: string
}

export interface PubAtmosphere {
  tone?: string
  energy?: string
  active_topics?: string[]
}

export interface PubDetail extends PubSummary {
  members: PubMember[]
  atmosphere: PubAtmosphere | null
}

export interface PubReactionDto {
  agent_id: string
  display_name: string
  emoji: string
  timestamp: string
}

export interface PubMessage {
  message_id: string
  agent_id: string
  display_name: string
  timestamp: string
  content: string
  type: string
  mentions: string[]
  mention_names: string[]
  directed_to: string | null
  reply_to: string | null
  reactions: PubReactionDto[]
}

/** Internal handle for tests and hooks that need to share the request helper. */
export { request as __request }

// ---------------------------------------------------------------------------
// Extensions catalog + install (decision: 2026-05-16-connector-store).
// ---------------------------------------------------------------------------

export type ConnectorAuthModel = 'qr_pair' | 'oauth' | 'bot_token' | 'api_key'

export type CatalogCategory = 'connector' | 'voice' | 'skill' | 'model_provider'

export type CatalogSource =
  | { type: 'workspace'; path: string }
  | { type: 'npm'; package: string; sha256: string }

export type ConnectorAccountScope = 'extension' | 'agent'

export interface CatalogEntry {
  id: string
  label: string
  blurb: string
  icon: string | null
  category: CatalogCategory
  auth_model: ConnectorAuthModel | null
  /**
   * 'extension' = pair-once-bind-to-Agent (WhatsApp Inbox);
   * 'agent' = per-Agent bot identity (Discord, Telegram, Slack).
   * Default 'extension' for catalog entries that omit the field.
   */
  account_scope: ConnectorAccountScope | null
  permissions: string[]
  tos_acknowledgment?: string
  docs_url?: string
  screenshots: string[]
  current_version: string
  min_2200_version?: string
  source: CatalogSource
}

export interface Catalog {
  schema_version: 1
  generated_at: string
  extensions: CatalogEntry[]
}

export type ExtensionInstallStage =
  | 'resolving'
  | 'copying'
  | 'validating_manifest'
  | 'running_install_hook'
  | 'completed'
  | 'failed'

export interface ExtensionInstallProgressPayload {
  install_id: string
  extension_id: string
  stage: ExtensionInstallStage
  percent: number
  message?: string
  error_code?: string
}

export type ExtensionPairState =
  | 'idle'
  | 'awaiting_qr_scan'
  | 'connecting'
  | 'paired'
  | 'disconnected'
  | 'errored'

export interface ExtensionPairStateResponse {
  extension_id: string
  agent_name?: string | null
  gateway_running: boolean
  state: ExtensionPairState
  qr_data_url?: string
  /** WhatsApp Inbox: bot's WhatsApp JID after pair. */
  self_jid?: string | null
  /** Discord: bot's Discord user (id, username) after connect. */
  self_user?: { id: string; username: string; discriminator?: string }
  detail?: string
  account: string
  updated_at: string
}

/**
 * Installed Extensions response (the "Installed" tab in the Store).
 * Each item is an Extension that has a manifest on disk under
 * `<home>/extensions/<id>/`, plus the per-Agent bindings reading from
 * each Identity's `connectors` block + live gateway state.
 */
export interface InstalledExtensionBinding {
  agent: string
  account: string
  bot_user_id?: string
  bot_username?: string
  gateway_running: boolean
  pair_state: ExtensionPairState
  pair_state_detail?: string
  pair_state_updated_at?: string
  allowlist_dm: string[]
  /**
   * Discord channel allowlist (and equivalent for future per-channel
   * connectors). For Discord per-Agent: a list of channel IDs the
   * Agent's bot is pinned to ... messages in any of these channels
   * wake the Agent without needing an @-mention.
   */
  allowlist_group: string[]
  dm_policy: 'open' | 'allowlist' | 'disabled' | 'pairing'
  group_policy: 'open' | 'allowlist' | 'disabled'
  require_mention: boolean
}

export interface InstalledExtensionGatewaySummary {
  running: boolean
  pair_state: ExtensionPairState
  self_jid?: string | null
}

export interface InstalledExtensionEntry {
  id: string
  manifest: {
    id: string
    label?: string
    name?: string
    version?: string
    description?: string
    permissions?: string[]
    [k: string]: unknown
  }
  bindings: InstalledExtensionBinding[]
  extension_gateway?: InstalledExtensionGatewaySummary
}

// ---------------------------------------------------------------------------
// Doctor (Settings -> Doctor tab) ... diagnose + fix endpoints.
// ---------------------------------------------------------------------------

export interface DoctorIssue {
  /** Stable id of form `<kind>:<scope>`; used by the fix endpoint. */
  id: string
  severity: 'info' | 'warn' | 'error'
  kind: string
  title: string
  description: string
  fix_available: boolean
  fix_label?: string
}

/**
 * `/api/v1/system/*` ... self-upgrade surface.
 *
 * `version` reports the current bundle version + the latest published
 * version on the npm registry; `update` triggers a detached upgrade
 * helper (the daemon shuts itself down within ~500ms, the helper
 * waits for it to exit, runs `npm install -g`, restarts the daemon);
 * `upgradeStatus` is what the web app polls during/after the
 * upgrade to surface progress and the final outcome.
 */
export type SystemVersionStatus = 'up-to-date' | 'update-available' | 'ahead' | 'registry-error'

export interface SystemVersion {
  current: string
  latest: string | null
  status: SystemVersionStatus
  install_source: 'npm-global' | 'source-checkout'
  registry_error: string | null
}

export type UpgradeStage =
  | 'pending'
  | 'stopping_daemon'
  | 'installing'
  | 'restarting'
  | 'completed'
  | 'failed'

export interface UpgradeStatus {
  schema_version: 1
  stage: UpgradeStage
  version_from: string
  version_to: string
  triggered_at: string
  updated_at: string
  finished_at: string | null
  error: string | null
}

export interface UpgradeStartResult {
  kind: 'started'
  current: string
  target: string
  daemon_pid: number
  helper_pid: number
}

export const apiSystem = {
  version: () => request<SystemVersion>('/api/v1/system/version'),
  update: (body?: { target_version?: string }) =>
    request<UpgradeStartResult>('/api/v1/system/update', {
      method: 'POST',
      body: body ?? {},
    }),
  upgradeStatus: () => request<{ status: UpgradeStatus | null }>('/api/v1/system/upgrade-status'),
}

/**
 * `/api/v1/oauth/xai/*` ... browser-driven device-code sign-in for the
 * SuperGrok / X Premium+ subscription credential. Mirrors the CLI
 * (`2200 oauth xai login`) over HTTP so the Settings page can drive
 * the flow inline. The Grok-First Settings tile is the primary
 * consumer.
 */
export type XaiOAuthLoginStatusResponse =
  | { status: 'pending'; poll_interval_sec: number; transient_error?: string }
  | {
      status: 'completed'
      access_token: string
      refresh_token: string
      expires_at_ms: number
      granted_scopes: string[]
    }
  | { status: 'failed'; error: string; description?: string }

export interface XaiOAuthStartResponse {
  session_id: string
  user_code: string
  verification_uri: string
  verification_uri_complete?: string
  expires_at: string
  poll_interval_sec: number
}

export type XaiOAuthStatusResponse =
  | { configured: false }
  | {
      configured: true
      provider: string
      granted_scopes: string[]
      expires_at: string
      expires_at_ms: number
      created_at: string
      refreshed_at: string | null
    }

export const apiOAuthXai = {
  status: () => request<XaiOAuthStatusResponse>('/api/v1/oauth/xai/status'),
  loginStart: () =>
    request<XaiOAuthStartResponse>('/api/v1/oauth/xai/login/start', {
      method: 'POST',
      body: {},
    }),
  loginStatus: (sessionId: string) =>
    request<XaiOAuthLoginStatusResponse>(
      `/api/v1/oauth/xai/login/status?session=${encodeURIComponent(sessionId)}`,
    ),
  logout: () => request<{ removed: boolean }>('/api/v1/oauth/xai/logout', { method: 'POST' }),
}

/**
 * `/api/v1/connector/*` ... operator controls for the MCP connector
 * endpoint that exposes 2200 to remote MCP clients (Grok via
 * grok.com/connectors, Claude Desktop, etc.). The actual remote-MCP
 * traffic lands on a separate listener (default :2201); these routes
 * live on the loopback web UI listener and are operator-only.
 */
export interface ConnectorStatusResponse {
  configured: boolean
  listening: boolean
  port: number | null
  bearer_present: boolean
  bearer_created_at: string | null
  bearer_regenerated_at: string | null
}

export const apiConnector = {
  status: () => request<ConnectorStatusResponse>('/api/v1/connector/status'),
  token: () => request<{ token: string | null }>('/api/v1/connector/token'),
  regenerate: () =>
    request<{ token: string }>('/api/v1/connector/regenerate', { method: 'POST', body: {} }),
  disable: () =>
    request<{ disabled: true }>('/api/v1/connector/disable', { method: 'POST', body: {} }),
}

/**
 * Work packages proposed by remote MCP callers (Grok). The operator
 * approval surface lives on the Settings page; these routes back it.
 * The CLI (`2200 connector work-package approve | reject`) drives
 * the same RPCs.
 */
export type WorkPackageStatus = 'proposed' | 'reviewable' | 'approved' | 'rejected'

export interface WorkPackageSummary {
  packageId: string
  slug: string
  title: string
  status: WorkPackageStatus
  primaryAgent: string
  targetKind: 'thread' | 'agent'
  targetName: string
  createdAt: string
  body: string
  approvedAt: string | null
  approvedFollowOnTaskIds: string[]
  rejectedAt: string | null
  rejectionReason: string | null
}

export interface OAuthClientSummary {
  clientId: string
  displayName: string
  redirectUris: string[]
  hasSecret: boolean
  scopesAllowed: string[]
  registeredAt: string
  lastAuthorizeAt: string | null
  revokedAt: string | null
}

export interface OAuthClientRegisterRequest {
  display_name: string
  redirect_uris?: string[]
  mint_secret?: boolean
  scopes_allowed?: string[]
}

export interface OAuthClientRegisterResponse {
  clientId: string
  clientSecret: string | null
  redirectUris: string[]
  scopesAllowed: string[]
  registeredAt: string
}

/**
 * OAuth client management routes (Phase 2 PR-A2). Backs the Settings
 * → MCP Connector → OAuth Clients sub-section. Same routes the CLI
 * verbs `2200 connector oauth-client ...` hit via the daemon's
 * loopback API.
 */
export const apiConnectorOAuthClients = {
  list: () => request<{ items: OAuthClientSummary[] }>('/api/v1/connector/oauth-clients'),
  register: (body: OAuthClientRegisterRequest) =>
    request<OAuthClientRegisterResponse>('/api/v1/connector/oauth-clients', {
      method: 'POST',
      body,
    }),
  revoke: (clientId: string) =>
    request<{ revoked: true; removed_refresh: number; removed_access: number }>(
      `/api/v1/connector/oauth-clients/${encodeURIComponent(clientId)}/revoke`,
      { method: 'POST', body: {} },
    ),
  rotateSecret: (clientId: string) =>
    request<{ client_id: string; client_secret: string }>(
      `/api/v1/connector/oauth-clients/${encodeURIComponent(clientId)}/rotate-secret`,
      { method: 'POST', body: {} },
    ),
  grokRedirectUri: () => request<{ redirect_uri: string }>('/api/v1/connector/grok-redirect-uri'),
}

/**
 * Embassy / conduit management (Phase 2 / PR-B5).
 *
 * The operator's "register a connection to Grok" mental model maps to
 * the atomic `register` call here — mints an OAuth client and registers
 * an embassy in one step. List + retire round out the lifecycle.
 */
export type ConduitMode = 'dedicated' | 'attached'

export interface ConduitSummary {
  schema_version: 1
  client_id: string
  external_model: string
  embassy_agent: string
  mode: ConduitMode
  display_name: string
  registered_at: string
  registered_by: string
  last_seen_at: string | null
  retired_at: string | null
}

export interface ConduitRegisterRequest {
  display_name: string
  external_model: string
  embassy_agent: string
  mode: ConduitMode
  redirect_uris?: string[]
  mint_secret?: boolean
  scopes_allowed?: string[]
  model?: {
    tier: string
    provider: string
    model_id: string
  }
  tools?: string[]
}

export interface ConduitRegisterResponse {
  conduit: ConduitSummary
  agentCreated: boolean
  clientId: string
  clientSecret: string | null
}

export const apiConnectorConduits = {
  list: () => request<{ items: ConduitSummary[] }>('/api/v1/connector/conduits'),
  register: (body: ConduitRegisterRequest) =>
    request<ConduitRegisterResponse>('/api/v1/connector/conduits', {
      method: 'POST',
      body,
    }),
  retire: (clientId: string) =>
    request<{ retired: true }>(
      `/api/v1/connector/conduits/${encodeURIComponent(clientId)}/retire`,
      { method: 'POST', body: {} },
    ),
}

export const apiConnectorWorkPackages = {
  list: (status?: WorkPackageStatus) =>
    request<{ items: WorkPackageSummary[] }>(
      status === undefined
        ? '/api/v1/connector/work-packages'
        : `/api/v1/connector/work-packages?status=${encodeURIComponent(status)}`,
    ),
  approve: (packageId: string) =>
    request<{ approved: true; follow_on_task_ids: string[] }>(
      `/api/v1/connector/work-packages/${encodeURIComponent(packageId)}/approve`,
      { method: 'POST', body: {} },
    ),
  reject: (packageId: string, reason?: string) =>
    request<{ rejected: true }>(
      `/api/v1/connector/work-packages/${encodeURIComponent(packageId)}/reject`,
      { method: 'POST', body: reason !== undefined ? { reason } : {} },
    ),
}

export const apiDoctor = {
  diagnose: () =>
    request<{ items: DoctorIssue[]; generated_at: string }>('/api/v1/doctor/diagnose'),
  fix: (id: string) =>
    request<{ applied: boolean; message: string }>('/api/v1/doctor/fix', {
      method: 'POST',
      body: { id },
    }),
}

export const apiExtensions = {
  catalog: () => request<Catalog>('/api/v1/extensions/catalog'),
  installed: () => request<{ items: InstalledExtensionEntry[] }>('/api/v1/extensions/installed'),
  install: (body: {
    source:
      | { type: 'catalog'; id: string }
      | { type: 'npm'; package: string }
      | { type: 'path'; path: string }
    permissions_acknowledged: string[]
    tos_acknowledged: boolean
  }) =>
    request<{ install_id: string; extension_id: string }>('/api/v1/extensions/install', {
      method: 'POST',
      body,
    }),
  pairStart: (id: string, agent?: string) => {
    const qs = agent ? `?agent=${encodeURIComponent(agent)}` : ''
    return request<{
      extension_id: string
      agent_name: string | null
      gateway: { pid: number; port: number; started_at: string }
    }>(`/api/v1/extensions/${encodeURIComponent(id)}/pair/start${qs}`, { method: 'POST' })
  },
  pairState: (id: string, agent?: string) => {
    const qs = agent ? `?agent=${encodeURIComponent(agent)}` : ''
    return request<ExtensionPairStateResponse>(
      `/api/v1/extensions/${encodeURIComponent(id)}/pair/state${qs}`,
    )
  },
  /**
   * Per-Agent connector setup (for account_scope: 'agent' connectors).
   * Seals credentials to the picked Agent's vault, writes the binding
   * into identity.md, restarts the Agent so the binding loads,
   * starts the gateway. One call = full setup.
   */
  agentSetup: (
    id: string,
    agent: string,
    body: {
      credentials: Record<string, string>
      allowlist_dm?: string[]
      /**
       * Channel allowlist. Required for Discord (the per-Agent bot
       * is pinned to one or more channels; messages in those
       * channels wake the Agent without an @-mention).
       */
      allowlist_group?: string[]
    },
  ) =>
    request<{
      extension_id: string
      agent_name: string
      gateway: { pid: number; port: number; started_at: string }
      credentials_sealed: string[]
    }>(`/api/v1/extensions/${encodeURIComponent(id)}/agents/${encodeURIComponent(agent)}/setup`, {
      method: 'POST',
      body,
    }),
  /**
   * Update only the policy + allowlist block on an existing binding
   * (no credential change, no Agent restart). Used by the Configure
   * view to change the Discord channel without re-pasting the token.
   */
  policyUpdate: (
    id: string,
    agent: string,
    body: { allowlist_dm?: string[]; allowlist_group?: string[] },
  ) =>
    request<{
      extension_id: string
      agent_name: string
      allowlist: { dm: string[]; group: string[] }
      policies: { dm_policy: string; group_policy: string; require_mention: boolean }
    }>(`/api/v1/extensions/${encodeURIComponent(id)}/agents/${encodeURIComponent(agent)}/policy`, {
      method: 'PATCH',
      body,
    }),
}
