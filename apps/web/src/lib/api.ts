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

export interface Agent {
  name: string
  status: string
  pid: number | null
  current_task_id: string | null
  identity_path: string
  spawned_at: string | null
  last_heartbeat: string | null
  errored_at: string | null
  errored_reason: string | null
  pulse: Pulse | null
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

export interface OnboardingPreview {
  transcript: OnboardingTranscript
  /** Opaque to the web client; surfaced via summary + agent_name. */
  handoff: { frontmatter: { agent_name: string; [k: string]: unknown }; body: string }
  tools: OnboardingToolSuggestion[]
  schedules: OnboardingScheduleSuggestion[]
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

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'
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
  budget: (name: string) =>
    request<BudgetResponse>(`/api/v1/agents/${encodeURIComponent(name)}/budget`),
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
  onboardingConfirm: (id: string) =>
    request<OnboardingConfirmResponse>(`/api/v1/onboarding/${encodeURIComponent(id)}/confirm`, {
      method: 'POST',
    }),
  onboardingCancel: (id: string) =>
    request<{ session_id: string; state: 'cancelled' }>(
      `/api/v1/onboarding/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    ),
}

/** Internal handle for tests and hooks that need to share the request helper. */
export { request as __request }
