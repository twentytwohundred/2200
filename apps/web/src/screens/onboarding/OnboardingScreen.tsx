/**
 * Onboarding screen ... Card Stack variant per
 * wiki/design-system/decision-log.md and wiki/epics/15-web-app.md
 * Phase B.
 *
 * Drives the runtime's server-side onboarding state machine over the
 * /api/v1/onboarding endpoints. Shape of the flow:
 *
 *   1. Intro card    user clicks Begin to POST /onboarding
 *   2. Question card current question is shown; submit POSTs answer
 *      (loops until done)
 *   3. Preview card  summary, agent name, suggested tools + schedules
 *   4. Confirmed     materialized agent name + paths, link to Fleet
 *
 * The server holds the session; this component is a thin driver. A
 * page reload mid-interview will lose the session_id (no persistence
 * is intentional v1 per the API design); it can be added later via
 * URL fragment or storage if the UX warrants it.
 */
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactElement } from 'react'
import { Link, useNavigate } from 'react-router-dom'
// Link kept for inline Settings link inside the body; header back-link uses ScreenNavLink.
import { useMutation, useQueries, useQuery } from '@tanstack/react-query'
import {
  ApiError,
  NetworkError,
  api,
  type OnboardingConfirmResponse,
  type OnboardingPreview,
  type OnboardingQuestion,
  type OnboardingScheduleSuggestion,
  type OnboardingSessionResponse,
  type OnboardingToolSuggestion,
  type OnboardingTranscriptEntry,
} from '../../lib/api'
import { Button, Card, Screen, ScreenNavLink, SectionHeader } from '../../primitives'
import styles from './OnboardingScreen.module.css'

type Phase =
  | { kind: 'intro' }
  | {
      kind: 'interview'
      sessionId: string
      question: OnboardingQuestion
      transcript: OnboardingTranscriptEntry[]
    }
  | {
      kind: 'preview'
      sessionId: string
      preview: OnboardingPreview
    }
  | { kind: 'confirmed'; result: OnboardingConfirmResponse }

function formatError(err: unknown): string {
  if (err instanceof ApiError) return `${err.code}: ${err.message}`
  if (err instanceof NetworkError) {
    return 'Cannot reach the runtime. The supervisor may not be running.'
  }
  return err instanceof Error ? err.message : String(err)
}

export function OnboardingScreen(): ReactElement {
  const navigate = useNavigate()
  const [phase, setPhase] = useState<Phase>({ kind: 'intro' })
  const [draft, setDraft] = useState<string>('')
  const [providerName, setProviderName] = useState<string>('')
  const [modelId, setModelId] = useState<string>('')

  const providersQuery = useQuery({
    queryKey: ['settings', 'providers'],
    queryFn: () => api.settingsProvidersList(),
    staleTime: 30_000,
  })
  const endpointsQuery = useQuery({
    queryKey: ['settings', 'endpoints'],
    queryFn: () => api.endpointsList(),
    staleTime: 30_000,
  })

  // Live-poll each saved endpoint for its actual /v1/models output.
  // The dropdown uses the live list (union'd with operator-selected
  // models, in case the upstream is briefly unreachable). This means
  // a newly-added endpoint that the operator hasn't yet "Edit"-ed
  // still appears as long as it's serving anything.
  const endpointIds = (endpointsQuery.data?.items ?? []).map((e) => e.id)
  const liveEndpointQueries = useQueries({
    queries: endpointIds.map((id) => ({
      queryKey: ['settings', 'endpoints', id, 'models'],
      queryFn: () => api.endpointModels(id),
      refetchInterval: 30_000,
      staleTime: 15_000,
    })),
  })

  // Pickable options: built-in providers with a key configured PLUS
  // custom endpoints (Settings -> Endpoints). The runtime resolves
  // the `endpoint:<id>` provider form to the matching endpoint's
  // base_url + sealed api_key on the agent process side; the new
  // Agent's identity binds via `provider: "endpoint:<id>"`.
  interface PickableOption {
    kind: 'provider' | 'endpoint'
    name: string
    label: string
    models: string[]
  }
  const pickableOptions = useMemo<PickableOption[]>(() => {
    const providers = (providersQuery.data?.items ?? [])
      .filter((p) => p.key_set || p.keyOptional)
      .map(
        (p): PickableOption => ({
          kind: 'provider',
          name: p.name,
          label: p.label,
          models: p.suggested_models,
        }),
      )
    const endpoints = (endpointsQuery.data?.items ?? []).map((e, i): PickableOption => {
      const live = liveEndpointQueries[i]?.data
      const liveModels = live && 'ok' in live && live.ok ? live.models.map((m) => m.id) : []
      const selectedModels = e.models.map((m) => m.id)
      // Union: live first (operator probably wants the currently-
      // served model), then any selected-but-not-currently-live as
      // a fallback. Deduped while preserving order.
      const seen = new Set<string>()
      const merged: string[] = []
      for (const m of [...liveModels, ...selectedModels]) {
        if (seen.has(m)) continue
        seen.add(m)
        merged.push(m)
      }
      const liveLabel =
        live && 'ok' in live && live.ok
          ? ` (${String(liveModels.length)} live)`
          : selectedModels.length > 0
            ? ` (saved)`
            : ' (unreachable)'
      return {
        kind: 'endpoint',
        name: `endpoint:${e.id}`,
        label: `${e.name}${liveLabel}`,
        models: merged,
      }
    })
    return [...providers, ...endpoints]
  }, [providersQuery.data, endpointsQuery.data, liveEndpointQueries])

  // Auto-pick the first option's first model so the user can hit
  // Begin without touching the dropdowns. They can override before
  // clicking Begin.
  useEffect(() => {
    if (providerName !== '' || pickableOptions.length === 0) return
    const first = pickableOptions[0]
    if (!first) return
    setProviderName(first.name)
    setModelId(first.models[0] ?? '')
  }, [pickableOptions, providerName])

  const selectedOption = useMemo(
    () => pickableOptions.find((p) => p.name === providerName),
    [pickableOptions, providerName],
  )

  // Re-sync modelId when the selected option's model list lands
  // asynchronously. Common case: operator picks a custom endpoint
  // BEFORE the live /v1/models query has resolved (models[] is
  // empty at click time, so modelId stays ''). The live query then
  // resolves and the dropdown shows the served model, but the
  // controlled value is stale at '' until we sync here. Without
  // this effect, the operator sees the model "selected" visually
  // but Begin stays disabled because modelId === ''.
  useEffect(() => {
    if (!selectedOption) return
    if (selectedOption.models.length === 0) return
    if (modelId !== '' && selectedOption.models.includes(modelId)) return
    setModelId(selectedOption.models[0] ?? '')
  }, [selectedOption, modelId])

  const handleSessionResponse = useCallback(
    (sessionId: string, transcript: OnboardingTranscriptEntry[], answer: string | null) =>
      (res: OnboardingSessionResponse): void => {
        const nextTranscript =
          answer === null ? transcript : appendAnswer(transcript, answer, phase)
        if (res.preview) {
          setPhase({ kind: 'preview', sessionId, preview: res.preview })
          return
        }
        if (!res.question) {
          setPhase({ kind: 'intro' })
          return
        }
        setPhase({
          kind: 'interview',
          sessionId,
          question: res.question,
          transcript: nextTranscript,
        })
        setDraft('')
      },
    [phase],
  )

  const startMutation = useMutation({
    mutationFn: ({ provider, model }: { provider: string; model: string }) =>
      api.onboardingStart({ provider, model }),
    onSuccess: (res: OnboardingSessionResponse): void => {
      handleSessionResponse(res.session_id, [], null)(res)
    },
  })

  const answerMutation = useMutation({
    mutationFn: ({ id, answer }: { id: string; answer: string }) =>
      api.onboardingAnswer(id, answer),
    onSuccess: (res: OnboardingSessionResponse, variables): void => {
      const transcript = phase.kind === 'interview' ? phase.transcript : []
      handleSessionResponse(variables.id, transcript, variables.answer)(res)
    },
  })

  const confirmMutation = useMutation({
    mutationFn: (id: string) => api.onboardingConfirm(id),
    onSuccess: (result: OnboardingConfirmResponse): void => {
      setPhase({ kind: 'confirmed', result })
    },
  })

  const cancelMutation = useMutation({
    mutationFn: (id: string) => api.onboardingCancel(id),
    onSuccess: (): void => {
      setPhase({ kind: 'intro' })
      setDraft('')
    },
  })

  const submitAnswer = useCallback(
    (e: FormEvent<HTMLFormElement>): void => {
      e.preventDefault()
      if (phase.kind !== 'interview') return
      const answer = draft.trim()
      if (answer.length === 0) return
      answerMutation.mutate({ id: phase.sessionId, answer })
    },
    [answerMutation, draft, phase],
  )

  return (
    <Screen
      crumbs={['2200', 'onboarding']}
      title="Build an Agent"
      lede="Answer a few questions; 2200 will assemble an Identity, suggest tools and schedules, and stand the Agent up on this instance."
      actions={<ScreenNavLink to="/">← Fleet</ScreenNavLink>}
    >
      {phase.kind === 'intro' ? (
        <Card padding={20}>
          <div className={styles.intro}>
            <p className={styles.introBody}>
              The interview takes a few minutes. You will see a preview of the resulting Agent ...
              summary, name, suggested MCP tools, schedules ... before anything is written to disk.
              Confirm only when the preview matches what you intended.
            </p>

            <div className={styles.pickerBlock}>
              <div className={styles.pickerLabel}>MODEL FOR THIS INTERVIEW</div>
              <p className={styles.pickerHelp}>
                The provider that runs the interview is also a strong default for the new Agent's
                day-to-day model. You can change the Agent's model later from its Identity.
              </p>
              {providersQuery.isLoading || endpointsQuery.isLoading ? (
                <div className={styles.pickerMeta}>Loading available providers...</div>
              ) : providersQuery.isError ? (
                <div className={styles.errorMessage}>{formatError(providersQuery.error)}</div>
              ) : pickableOptions.length === 0 ? (
                <div className={styles.errorMessage}>
                  No LLM provider or custom endpoint is configured. Visit{' '}
                  <Link to="/settings" className={styles.tag}>
                    Settings
                  </Link>{' '}
                  to add a provider key or register a custom endpoint before spawning.
                </div>
              ) : (
                <div className={styles.pickerRow}>
                  <label className={styles.pickerField}>
                    <span className={styles.pickerFieldLabel}>PROVIDER</span>
                    <select
                      className={styles.pickerSelect}
                      value={providerName}
                      onChange={(e) => {
                        const next = e.target.value
                        setProviderName(next)
                        const p = pickableOptions.find((cp) => cp.name === next)
                        setModelId(p?.models[0] ?? '')
                      }}
                    >
                      {pickableOptions.some((p) => p.kind === 'provider') && (
                        <optgroup label="Providers">
                          {pickableOptions
                            .filter((p) => p.kind === 'provider')
                            .map((p) => (
                              <option key={p.name} value={p.name}>
                                {p.label}
                              </option>
                            ))}
                        </optgroup>
                      )}
                      {pickableOptions.some((p) => p.kind === 'endpoint') && (
                        <optgroup label="Custom endpoints">
                          {pickableOptions
                            .filter((p) => p.kind === 'endpoint')
                            .map((p) => (
                              <option key={p.name} value={p.name}>
                                {p.label}
                              </option>
                            ))}
                        </optgroup>
                      )}
                    </select>
                  </label>
                  <label className={styles.pickerField}>
                    <span className={styles.pickerFieldLabel}>MODEL</span>
                    {selectedOption && selectedOption.models.length > 0 ? (
                      <select
                        className={styles.pickerSelect}
                        value={modelId}
                        onChange={(e) => {
                          setModelId(e.target.value)
                        }}
                      >
                        {selectedOption.models.map((m) => (
                          <option key={m} value={m}>
                            {m}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        type="text"
                        className={styles.pickerInput}
                        value={modelId}
                        placeholder="model id (e.g. deepseek-chat)"
                        onChange={(e) => {
                          setModelId(e.target.value)
                        }}
                      />
                    )}
                  </label>
                </div>
              )}
            </div>

            {startMutation.error ? (
              <div className={styles.errorMessage}>{formatError(startMutation.error)}</div>
            ) : null}
            <div className={styles.introActions}>
              <Button
                variant="primary"
                onClick={() => {
                  startMutation.mutate({ provider: providerName, model: modelId })
                }}
                disabled={
                  startMutation.isPending ||
                  providersQuery.isLoading ||
                  providerName === '' ||
                  modelId === ''
                }
              >
                {startMutation.isPending ? 'Starting...' : 'Begin'}
              </Button>
            </div>
          </div>
        </Card>
      ) : null}

      {phase.kind === 'interview' ? (
        <>
          <Card padding={20}>
            <div className={styles.cardStack}>
              <div className={styles.questionMeta}>
                <span>
                  Q{String(phase.question.index + 1)}
                  {phase.question.total !== null
                    ? ` of ${String(phase.question.total)}`
                    : ' (routing)'}
                </span>
                {phase.question.question.intent_tag ? (
                  <span className={styles.tag}>{phase.question.question.intent_tag}</span>
                ) : null}
              </div>
              <div className={styles.questionText}>{phase.question.question.text}</div>
              <form onSubmit={submitAnswer} className={styles.answerForm}>
                <textarea
                  className={styles.answerInput}
                  value={draft}
                  onChange={(e) => {
                    setDraft(e.target.value)
                  }}
                  placeholder="Type your answer..."
                  autoFocus
                  disabled={answerMutation.isPending}
                />
                {answerMutation.error ? (
                  <div className={styles.errorMessage}>{formatError(answerMutation.error)}</div>
                ) : null}
                <div className={styles.answerActions}>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      cancelMutation.mutate(phase.sessionId)
                    }}
                    disabled={answerMutation.isPending || cancelMutation.isPending}
                  >
                    Cancel
                  </Button>
                  <Button
                    variant="primary"
                    type="submit"
                    disabled={answerMutation.isPending || draft.trim().length === 0}
                    kbd="↵"
                  >
                    {answerMutation.isPending ? 'Working...' : 'Next'}
                  </Button>
                </div>
              </form>
            </div>
          </Card>

          {phase.transcript.length > 0 ? (
            <section>
              <SectionHeader title="ANSWERED" />
              <Card padding={20}>
                <div className={styles.transcript}>
                  {phase.transcript.map((entry) => (
                    <div key={entry.question_id} className={styles.transcriptEntry}>
                      <div className={styles.transcriptQ}>{entry.question_text}</div>
                      <div className={styles.transcriptA}>{entry.answer}</div>
                    </div>
                  ))}
                </div>
              </Card>
            </section>
          ) : null}
        </>
      ) : null}

      {phase.kind === 'preview' ? (
        <PreviewView
          preview={phase.preview}
          onConfirm={() => {
            confirmMutation.mutate(phase.sessionId)
          }}
          onCancel={() => {
            cancelMutation.mutate(phase.sessionId)
          }}
          confirmDisabled={confirmMutation.isPending || cancelMutation.isPending}
          confirmPending={confirmMutation.isPending}
          error={confirmMutation.error}
        />
      ) : null}

      {phase.kind === 'confirmed' ? (
        <Card padding={20}>
          <div className={styles.confirmedHero}>
            <div className={styles.confirmedTitle}>
              {phase.result.agent_name} is on this instance.
            </div>
            <div className={styles.confirmedMeta}>IDENTITY · {phase.result.identity_path}</div>
            {phase.result.transcript_path ? (
              <div className={styles.confirmedMeta}>
                TRANSCRIPT · {phase.result.transcript_path}
              </div>
            ) : null}
            {phase.result.continuity_note_slug ? (
              <div className={styles.confirmedMeta}>
                BRAIN NOTE · {phase.result.continuity_note_slug}
              </div>
            ) : null}
            {phase.result.auto_started ? (
              <div className={styles.confirmedMeta}>
                AGENT STARTED · running the orientation task now (read shared brain → write first
                brain note → introduce in the Studio → chat back to you)
              </div>
            ) : (
              <div className={styles.confirmedMeta}>
                AGENT NOT STARTED · auto-start failed
                {phase.result.auto_start_error ? `: ${phase.result.auto_start_error}` : ''}. Run
                `2200 agent start {phase.result.agent_name}` once the underlying issue is addressed.
              </div>
            )}
            <div className={styles.confirmActions}>
              <Button
                variant="primary"
                onClick={() => {
                  void navigate(`/agent/${phase.result.agent_name}`)
                }}
              >
                Open Agent
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setPhase({ kind: 'intro' })
                  setDraft('')
                }}
              >
                Spawn another
              </Button>
            </div>
          </div>
        </Card>
      ) : null}
    </Screen>
  )
}

function appendAnswer(
  prev: OnboardingTranscriptEntry[],
  answer: string,
  phase: Phase,
): OnboardingTranscriptEntry[] {
  if (phase.kind !== 'interview') return prev
  const q = phase.question
  return [
    ...prev,
    {
      question_id: q.question.id,
      question_text: q.question.text,
      answer,
      ...(q.question.intent_tag ? { intent_tag: q.question.intent_tag } : {}),
      asked_at: new Date().toISOString(),
    },
  ]
}

interface PreviewViewProps {
  preview: OnboardingPreview
  onConfirm: () => void
  onCancel: () => void
  confirmDisabled: boolean
  confirmPending: boolean
  error: unknown
}

function PreviewView({
  preview,
  onConfirm,
  onCancel,
  confirmDisabled,
  confirmPending,
  error,
}: PreviewViewProps): ReactElement {
  return (
    <>
      <section>
        <SectionHeader title="AGENT" />
        <Card padding={20}>
          <div className={styles.previewName}>{preview.agent_name}</div>
          <div className={styles.previewMeta}>
            CHOSEN BRANCH · {preview.transcript.chosen_branch}
          </div>
        </Card>
      </section>

      <section>
        <SectionHeader title="SUMMARY" />
        <Card padding={20}>
          <div className={styles.summary}>{preview.transcript.summary}</div>
        </Card>
      </section>

      <section>
        <SectionHeader title={`SUGGESTED TOOLS · ${String(preview.tools.length)}`} />
        <Card padding={20}>
          {preview.tools.length === 0 ? (
            <div className={styles.suggestionMeta}>
              No tool integrations suggested. You can wire MCP servers later via 2200 agent edit.
            </div>
          ) : (
            <div className={styles.suggestionList}>
              {preview.tools.map((t: OnboardingToolSuggestion) => (
                <div key={t.server.name} className={styles.suggestion}>
                  <div className={styles.suggestionTitle}>{t.server.name}</div>
                  <div className={styles.suggestionMeta}>{t.env_hint}</div>
                  <div className={styles.suggestionRationale}>{t.rationale}</div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </section>

      <section>
        <SectionHeader title={`SUGGESTED SCHEDULES · ${String(preview.schedules.length)}`} />
        <Card padding={20}>
          {preview.schedules.length === 0 ? (
            <div className={styles.suggestionMeta}>
              No schedules suggested. The Agent will run on demand or via tasks you queue later.
            </div>
          ) : (
            <div className={styles.suggestionList}>
              {preview.schedules.map((s: OnboardingScheduleSuggestion) => (
                <div key={s.id} className={styles.suggestion}>
                  <div className={styles.suggestionTitle}>{s.task}</div>
                  <div className={styles.suggestionMeta}>
                    CRON {s.cron} · TZ {s.tz}
                  </div>
                  <div className={styles.suggestionRationale}>{s.rationale}</div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </section>

      {error ? (
        <Card padding={20}>
          <div className={styles.errorMessage}>{formatError(error)}</div>
        </Card>
      ) : null}

      <div className={styles.confirmActions}>
        <Button variant="ghost" onClick={onCancel} disabled={confirmDisabled}>
          Cancel
        </Button>
        <Button variant="primary" onClick={onConfirm} disabled={confirmDisabled}>
          {confirmPending ? 'Building...' : 'Confirm + build'}
        </Button>
      </div>
    </>
  )
}
