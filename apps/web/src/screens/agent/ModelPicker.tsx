/**
 * Agent identity model picker.
 *
 * Lists every model the operator has registered, grouped by source:
 *   - Built-in providers (Anthropic, DeepSeek, xAI, OpenAI, …)
 *   - Custom endpoints registered via Settings → Endpoints
 *
 * Selecting a model writes the (provider, model_id) pair into the
 * Agent's Identity via `api.agentModelSet`. The Agent restarts on the
 * next loop cycle to pick up the change.
 *
 * Renders as a small mono-styled button showing the current model;
 * clicking it surfaces a native `<select>` with optgroups. Native
 * select is intentional here: the grouped list is the right ergonomic
 * fit, and the browser's accessibility surface comes for free.
 */
import type { ChangeEvent, ReactElement } from 'react'
import { useMemo } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiError, NetworkError, api } from '../../lib/api'
import { cx } from '../../primitives'
import styles from './ModelPicker.module.css'

function formatPickerError(err: unknown): string {
  if (err instanceof ApiError) return err.message
  if (err instanceof NetworkError) return 'runtime unreachable'
  return err instanceof Error ? err.message : 'unknown error'
}

export interface ModelPickerProps {
  agentName: string
  currentProvider: string
  currentModelId: string
}

interface ModelOption {
  value: string // `<provider>::<model_id>`
  label: string
  provider: string
  modelId: string
}

interface ModelGroup {
  label: string
  options: ModelOption[]
}

function encodePair(provider: string, modelId: string): string {
  return `${provider}::${modelId}`
}

function decodePair(value: string): { provider: string; modelId: string } | null {
  const i = value.indexOf('::')
  if (i < 0) return null
  return { provider: value.slice(0, i), modelId: value.slice(i + 2) }
}

export function ModelPicker({
  agentName,
  currentProvider,
  currentModelId,
}: ModelPickerProps): ReactElement {
  const queryClient = useQueryClient()
  const providers = useQuery({
    queryKey: ['settings', 'providers'],
    queryFn: () => api.settingsProvidersList(),
    staleTime: 30_000,
  })
  const endpoints = useQuery({
    queryKey: ['settings', 'endpoints'],
    queryFn: () => api.endpointsList(),
    staleTime: 30_000,
  })

  const groups = useMemo<ModelGroup[]>(() => {
    // Order subscriptions first so they sit at the top of the picker.
    // Within each category, providers appear in their catalog order
    // (the runtime returns them with subscriptions sorted naturally
    // first inside OPENAI_COMPATIBLE_VENDORS).
    const out: ModelGroup[] = []
    const builtins = providers.data?.items ?? []
    const subs = builtins.filter((p) => p.category === 'subscription')
    const apiKey = builtins.filter((p) => p.category === 'api-key')
    const local = builtins.filter((p) => p.category === 'local')

    const pushProvider = (p: (typeof builtins)[number], categoryPrefix?: string): void => {
      if (p.suggested_models.length === 0) return
      if (!p.key_set && !p.keyOptional) return
      const label = categoryPrefix !== undefined ? `${categoryPrefix} › ${p.label}` : p.label
      out.push({
        label,
        options: p.suggested_models.map((id) => ({
          value: encodePair(p.name, id),
          label: id,
          provider: p.name,
          modelId: id,
        })),
      })
    }

    for (const p of subs) pushProvider(p, 'Subscriptions')
    for (const p of apiKey) pushProvider(p)
    for (const p of local) pushProvider(p)

    const items = endpoints.data?.items ?? []
    for (const e of items) {
      if (e.models.length === 0) continue
      out.push({
        label: `Custom endpoints › ${e.name}`,
        options: e.models.map((m) => ({
          value: encodePair(`endpoint:${e.id}`, m.id),
          label: m.label ?? m.id,
          provider: `endpoint:${e.id}`,
          modelId: m.id,
        })),
      })
    }
    return out
  }, [providers.data, endpoints.data])

  const currentValue = encodePair(currentProvider, currentModelId)
  // If the current model isn't in any group, surface it as a synthetic
  // "current (out of catalog)" option so it's still selectable in the
  // dropdown without dropping the user's existing binding.
  const inCatalog = groups.some((g) => g.options.some((o) => o.value === currentValue))

  // Switching the model writes the Identity, but the Agent process
  // holds its LLMProvider in memory ... it was constructed at boot
  // and won't pick up the new binding (especially a credential-source
  // change like xai → xai-subscription) until it restarts. Per Doug:
  // auto-restart so the new model is the one actually serving the
  // next request, without surprising the operator with a stale binding.
  //
  // Restart is best-effort. If stop or start fails (Agent already
  // stopped, restart races a manual restart, ...) the model edit
  // still landed on disk; the operator can manually restart later.
  const setModel = useMutation({
    mutationFn: async ({ provider, modelId }: { provider: string; modelId: string }) => {
      const edit = await api.agentModelSet(agentName, { provider, model_id: modelId })
      try {
        await api.agentStop(agentName, 'model_switch')
      } catch {
        // Already stopped, or stop race ... ignore; start below is the
        // load-bearing step.
      }
      // Bubbles up on failure so the picker UI surfaces the case
      // where the Identity changed but the Agent did not come back up.
      await api.agentStart(agentName)
      return edit
    },
    onSettled: () => {
      // Always refresh; the AgentDetail screen polls per-Agent state
      // off this query key, including the run state pill that flips
      // back from 'starting' to 'running'.
      void queryClient.invalidateQueries({ queryKey: ['agents', agentName] })
      void queryClient.invalidateQueries({ queryKey: ['agents'] })
    },
  })

  const onChange = (e: ChangeEvent<HTMLSelectElement>): void => {
    const decoded = decodePair(e.target.value)
    if (!decoded) return
    if (decoded.provider === currentProvider && decoded.modelId === currentModelId) return
    setModel.mutate({ provider: decoded.provider, modelId: decoded.modelId })
  }

  const switching = setModel.isPending
  const switchError = setModel.error

  return (
    <>
      <label
        className={cx(styles.wrap, switching && styles.switching)}
        title={
          switching
            ? 'Switching model and restarting the Agent...'
            : "Change this Agent's model (auto-restarts to pick up the new binding)"
        }
      >
        <select
          className={styles.select}
          value={currentValue}
          onChange={onChange}
          disabled={switching}
        >
          {!inCatalog && (
            <option value={currentValue}>
              {currentProvider} › {currentModelId} · current
            </option>
          )}
          {groups.map((g) => (
            <optgroup key={g.label} label={g.label}>
              {g.options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        {switching ? (
          <span className={styles.spinner} aria-hidden="true" />
        ) : (
          <span className={styles.chevron} aria-hidden="true">
            ▾
          </span>
        )}
      </label>
      {switchError && (
        <span className={styles.errorTip} role="alert">
          model edit saved, but the Agent restart failed: {formatPickerError(switchError)}. Restart
          manually with `2200 agent start {agentName}`.
        </span>
      )}
    </>
  )
}
