/**
 * Settings → Endpoints.
 *
 * Lets the operator register N OpenAI-compatible LLM endpoints
 * (DGX Spark, Ollama, LM Studio, vLLM, llama.cpp-server, any local
 * inference appliance). The form:
 *
 *   + Add endpoint  →  Name / Base URL / Bearer (optional) /
 *                      [Discover] → checkbox list of models → Save
 *
 * Endpoints persist to `<home>/config/endpoints.json` (server side).
 * Each endpoint's selected models then appear in the Agent identity
 * model picker as `endpoint:<slug> › <model-id>`.
 */
import { useEffect, useRef, useState, type ReactElement } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ApiError,
  NetworkError,
  api,
  type CustomEndpointDto,
  type CustomEndpointModelDto,
} from '../../lib/api'
import { Button, Card, ErrorState, Field, KV, LoadingState, Meta, Pill } from '../../primitives'
import styles from './EndpointsSection.module.css'

function formatError(err: unknown): string {
  if (err instanceof ApiError) return `${err.code}: ${err.message}`
  if (err instanceof NetworkError) return 'Cannot reach the runtime.'
  return err instanceof Error ? err.message : String(err)
}

export function EndpointsSection(): ReactElement {
  const queryClient = useQueryClient()
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)

  const list = useQuery({
    queryKey: ['settings', 'endpoints'],
    queryFn: () => api.endpointsList(),
    staleTime: 10_000,
  })

  if (list.isLoading) {
    return (
      <Card padding={20}>
        <LoadingState rows={2} />
      </Card>
    )
  }
  if (list.isError) {
    return (
      <Card padding={0}>
        <ErrorState title="Could not load endpoints" body={formatError(list.error)} />
      </Card>
    )
  }

  const items = list.data?.items ?? []

  return (
    <div className={styles.section}>
      {items.length === 0 && !adding && (
        <Card padding={20}>
          <p className={styles.empty}>
            No custom endpoints. Add a homelab box (DGX Spark, Ollama, LM Studio, vLLM, …) below and
            the models it serves become available to every Agent.
          </p>
        </Card>
      )}

      {items.length > 0 && (
        <div className={styles.list}>
          {items.map((e) =>
            editing === e.id ? (
              <EndpointForm
                key={e.id}
                initial={e}
                onCancel={() => {
                  setEditing(null)
                }}
                onSaved={() => {
                  setEditing(null)
                  void queryClient.invalidateQueries({ queryKey: ['settings', 'endpoints'] })
                }}
              />
            ) : (
              <EndpointRow
                key={e.id}
                endpoint={e}
                onEdit={() => {
                  setEditing(e.id)
                }}
                onDeleted={() => {
                  void queryClient.invalidateQueries({ queryKey: ['settings', 'endpoints'] })
                }}
              />
            ),
          )}
        </div>
      )}

      {adding ? (
        <EndpointForm
          onCancel={() => {
            setAdding(false)
          }}
          onSaved={() => {
            setAdding(false)
            void queryClient.invalidateQueries({ queryKey: ['settings', 'endpoints'] })
          }}
        />
      ) : (
        <div className={styles.addRow}>
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              setAdding(true)
            }}
          >
            + Add endpoint
          </Button>
        </div>
      )}
    </div>
  )
}

// ── EndpointRow ────────────────────────────────────────────────────────────

function EndpointRow({
  endpoint,
  onEdit,
  onDeleted,
}: {
  endpoint: CustomEndpointDto
  onEdit: () => void
  onDeleted: () => void
}): ReactElement {
  const del = useMutation({
    mutationFn: () => api.endpointDelete(endpoint.id),
    onSuccess: onDeleted,
  })

  // Live model poll: hit the endpoint's /v1/models every 30s so the
  // operator sees what the upstream server is currently serving. The
  // saved `endpoint.models` is what the operator selected to expose
  // to Agent identities; this query is what's *available right now*.
  // A model that's available but unselected is rendered as a ghost
  // chip; a selected model that's no longer being served is flagged.
  const liveModels = useQuery({
    queryKey: ['settings', 'endpoints', endpoint.id, 'models'],
    queryFn: () => api.endpointModels(endpoint.id),
    refetchInterval: 30_000,
    staleTime: 15_000,
  })

  const liveIds = new Set<string>(
    liveModels.data?.ok === true ? liveModels.data.models.map((m) => m.id) : [],
  )
  const selectedIds = new Set<string>(endpoint.models.map((m) => m.id))
  const liveOnly = [...liveIds].filter((id) => !selectedIds.has(id))
  const missingFromUpstream = endpoint.models.filter((m) => !liveIds.has(m.id))

  return (
    <Card padding={20}>
      <div className={styles.rowHead}>
        <span className={styles.rowName}>{endpoint.name}</span>
        <span className={styles.rowId}>endpoint:{endpoint.id}</span>
        <span className={styles.rowSpacer} />
        <Pill variant={endpoint.api_key_set ? 'info' : 'idle'}>
          {endpoint.api_key_set ? 'key set' : 'no key'}
        </Pill>
        <Pill
          variant={
            liveModels.data?.ok === true ? 'running' : liveModels.isLoading ? 'idle' : 'error'
          }
        >
          {liveModels.data?.ok === true
            ? `${String(liveModels.data.models.length)} live`
            : liveModels.isLoading
              ? 'probing'
              : 'unreachable'}
        </Pill>
        <Button size="sm" variant="ghost" onClick={onEdit}>
          Edit
        </Button>
        <ConfirmingDestructiveButton
          label="Remove"
          onConfirm={() => {
            del.mutate()
          }}
        />
      </div>
      <div className={styles.rowMeta}>
        <KV
          k="BASE URL"
          v={<span style={{ fontFamily: 'var(--ds-font-mono)' }}>{endpoint.base_url}</span>}
        />
        <KV
          k="SELECTED"
          v={
            endpoint.models.length === 0 ? (
              <span className={styles.rowMutedValue}>none selected (edit to pick)</span>
            ) : (
              <div className={styles.modelChips}>
                {endpoint.models.map((m) => {
                  const stillServed = liveIds.has(m.id)
                  return (
                    <code
                      key={m.id}
                      className={styles.modelChip}
                      style={
                        !stillServed && liveModels.data?.ok === true
                          ? {
                              borderColor: 'var(--danger)',
                              color: 'var(--danger)',
                              opacity: 0.8,
                            }
                          : undefined
                      }
                      title={
                        !stillServed && liveModels.data?.ok === true
                          ? 'Saved but not currently served by this endpoint'
                          : undefined
                      }
                    >
                      {m.label ?? m.id}
                      {!stillServed && liveModels.data?.ok === true ? ' (missing)' : ''}
                    </code>
                  )
                })}
              </div>
            )
          }
        />
        {liveModels.data?.ok === true && (
          <KV
            k="AVAILABLE NOW"
            v={
              liveModels.data.models.length === 0 ? (
                <span className={styles.rowMutedValue}>endpoint reports no models</span>
              ) : (
                <div className={styles.modelChips}>
                  {liveModels.data.models.map((m) => {
                    const isSelected = selectedIds.has(m.id)
                    return (
                      <code
                        key={m.id}
                        className={styles.modelChip}
                        style={
                          isSelected
                            ? undefined
                            : {
                                opacity: 0.55,
                                borderStyle: 'dashed',
                              }
                        }
                        title={
                          isSelected
                            ? 'Served and currently selected'
                            : 'Served by this endpoint but not yet selected for Agent use ... edit to enable'
                        }
                      >
                        {m.id}
                      </code>
                    )
                  })}
                </div>
              )
            }
          />
        )}
        {liveModels.data?.ok === false && (
          <KV
            k="POLL ERROR"
            v={
              <span style={{ color: 'var(--danger)', fontSize: 12 }}>
                {liveModels.data.error.kind}: {liveModels.data.error.message}
              </span>
            }
          />
        )}
        {liveModels.data?.ok === true &&
          (liveOnly.length > 0 || missingFromUpstream.length > 0) && (
            <div
              style={{
                gridColumn: '1 / -1',
                fontSize: 11,
                color: 'var(--text-3)',
                marginTop: 4,
              }}
            >
              {liveOnly.length > 0 && (
                <>
                  {String(liveOnly.length)} unselected model{liveOnly.length === 1 ? '' : 's'}{' '}
                  available.{' '}
                </>
              )}
              {missingFromUpstream.length > 0 && (
                <span style={{ color: 'var(--danger)' }}>
                  {String(missingFromUpstream.length)} selected model
                  {missingFromUpstream.length === 1 ? '' : 's'} no longer served.
                </span>
              )}
            </div>
          )}
      </div>
    </Card>
  )
}

// ── EndpointForm ───────────────────────────────────────────────────────────

interface DiscoveredModel {
  id: string
}

function EndpointForm({
  initial,
  onCancel,
  onSaved,
}: {
  initial?: CustomEndpointDto
  onCancel: () => void
  onSaved: () => void
}): ReactElement {
  const isEdit = initial !== undefined
  const [name, setName] = useState(initial?.name ?? '')
  const [baseUrl, setBaseUrl] = useState(initial?.base_url ?? '')
  const [apiKey, setApiKey] = useState('')
  const [apiKeyTouched, setApiKeyTouched] = useState(false)
  const [discovered, setDiscovered] = useState<DiscoveredModel[] | null>(null)
  const [discoverError, setDiscoverError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(initial?.models.map((m) => m.id) ?? []),
  )

  const discoverMutation = useMutation({
    mutationFn: () =>
      api.endpointDiscover({
        base_url: baseUrl,
        ...(apiKeyTouched && apiKey.length > 0 ? { api_key: apiKey } : {}),
      }),
    onSuccess: (res) => {
      if (res.ok) {
        setDiscovered(res.models)
        setDiscoverError(null)
        // Auto-select all discovered if no prior selection.
        if (!isEdit && selected.size === 0) {
          setSelected(new Set(res.models.map((m) => m.id)))
        }
      } else {
        setDiscovered(null)
        setDiscoverError(res.error.message)
      }
    },
    onError: (err) => {
      setDiscoverError(formatError(err))
    },
  })

  const saveMutation = useMutation({
    mutationFn: async () => {
      const models: CustomEndpointModelDto[] = Array.from(selected).map((id) => ({ id }))
      if (initial) {
        return api.endpointUpdate(initial.id, {
          name,
          base_url: baseUrl,
          ...(apiKeyTouched ? { api_key: apiKey } : {}),
          models,
        })
      }
      return api.endpointCreate({
        name,
        base_url: baseUrl,
        ...(apiKeyTouched && apiKey.length > 0 ? { api_key: apiKey } : {}),
        models,
        discover: false,
      })
    },
    onSuccess: onSaved,
  })

  const canDiscover = baseUrl.trim().length > 0 && !discoverMutation.isPending
  const canSave = name.trim().length > 0 && baseUrl.trim().length > 0 && !saveMutation.isPending

  return (
    <Card padding={20}>
      <div className={styles.formHead}>
        <Meta>{initial ? `edit endpoint · ${initial.id}` : 'new endpoint'}</Meta>
      </div>
      <div className={styles.formGrid}>
        <Field
          label="Name"
          placeholder="DGX Spark"
          value={name}
          onChange={(e) => {
            setName(e.target.value)
          }}
        />
        <Field
          label="Base URL"
          mono
          placeholder="http://192.168.1.42:8000/v1"
          value={baseUrl}
          onChange={(e) => {
            setBaseUrl(e.target.value)
          }}
          hint="OpenAI-compatible /v1 endpoint. Examples: vLLM, TGI, LM Studio, llama.cpp-server, Ollama (with /v1)."
        />
        <Field
          label={`Bearer token${initial ? ' (leave blank to keep existing)' : ' (optional)'}`}
          mono
          type="password"
          placeholder={initial?.api_key_set ? '••••••' : ''}
          value={apiKey}
          onChange={(e) => {
            setApiKey(e.target.value)
            setApiKeyTouched(true)
          }}
        />
      </div>

      <div className={styles.discoverRow}>
        <Button
          size="sm"
          variant="default"
          onClick={() => {
            discoverMutation.mutate()
          }}
          disabled={!canDiscover}
        >
          {discoverMutation.isPending ? 'Discovering…' : 'Discover models'}
        </Button>
        {discoverError && <span className={styles.error}>{discoverError}</span>}
        {discovered !== null && discoverError === null && (
          <span className={styles.discoverNote}>
            Found {String(discovered.length)} model{discovered.length === 1 ? '' : 's'}. Check the
            ones you want to expose.
          </span>
        )}
      </div>

      {discovered !== null && discovered.length > 0 && (
        <div className={styles.modelList}>
          {discovered.map((m) => (
            <label key={m.id} className={styles.modelLine}>
              <input
                type="checkbox"
                checked={selected.has(m.id)}
                onChange={(e) => {
                  setSelected((prev) => {
                    const next = new Set(prev)
                    if (e.target.checked) next.add(m.id)
                    else next.delete(m.id)
                    return next
                  })
                }}
              />
              <code className={styles.modelLineId}>{m.id}</code>
            </label>
          ))}
        </div>
      )}

      {initial && initial.models.length > 0 && discovered === null && (
        <div className={styles.modelList}>
          <Meta>currently selected</Meta>
          {initial.models.map((m) => (
            <label key={m.id} className={styles.modelLine}>
              <input
                type="checkbox"
                checked={selected.has(m.id)}
                onChange={(e) => {
                  setSelected((prev) => {
                    const next = new Set(prev)
                    if (e.target.checked) next.add(m.id)
                    else next.delete(m.id)
                    return next
                  })
                }}
              />
              <code className={styles.modelLineId}>{m.id}</code>
            </label>
          ))}
        </div>
      )}

      {saveMutation.isError && <p className={styles.error}>{formatError(saveMutation.error)}</p>}

      <div className={styles.formActions}>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="sm"
          variant="primary"
          onClick={() => {
            saveMutation.mutate()
          }}
          disabled={!canSave}
        >
          {saveMutation.isPending ? 'Saving…' : isEdit ? 'Save' : 'Add endpoint'}
        </Button>
      </div>
    </Card>
  )
}

// ── ConfirmingDestructiveButton ──────────────────────────────────────────────

/**
 * Two-step button for destructive actions. First click arms (label
 * flips to "Click to confirm"); a second click within 3 seconds
 * commits via `onConfirm`. Mouse-leave or timeout cancels.
 *
 * Replaces window.confirm everywhere in the web app per the
 * "no browser popups" rule.
 */
function ConfirmingDestructiveButton({
  label,
  onConfirm,
}: {
  label: string
  onConfirm: () => void
}): ReactElement {
  const [armed, setArmed] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const arm = (): void => {
    setArmed(true)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      setArmed(false)
    }, 3000)
  }

  const disarm = (): void => {
    setArmed(false)
    if (timer.current) {
      clearTimeout(timer.current)
      timer.current = null
    }
  }

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [])

  return (
    <Button
      size="sm"
      variant="destructive"
      onClick={() => {
        if (armed) {
          disarm()
          onConfirm()
        } else {
          arm()
        }
      }}
      onMouseLeave={armed ? disarm : undefined}
    >
      {armed ? 'Click to confirm' : label}
    </Button>
  )
}
