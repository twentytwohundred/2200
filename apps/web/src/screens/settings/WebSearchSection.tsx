/**
 * Web Search settings.
 *
 * Agents search the web via Brave (the default), Gemini grounding, or Google
 * Programmable Search ... bring-your-own-key, the same model OpenClaw uses.
 * Gemini is a single key (OpenClaw's "google" provider, what an OpenClaw
 * migration carries); Google Programmable Search needs a key + engine id.
 * Keys persist to runtime.env (carried over on an OpenClaw migration when
 * present, or pasted here). With nothing configured, web_search returns an
 * actionable status; once a key is in, Agents get real results.
 */
import { useState, type ReactElement } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ApiError,
  NetworkError,
  api,
  type WebSearchSettings,
  type WebSearchUpdate,
} from '../../lib/api'
import {
  Button,
  Card,
  ErrorState,
  Input,
  LoadingState,
  Pill,
  SectionHeader,
} from '../../primitives'
import styles from './WebSearchSection.module.css'

function formatError(err: unknown): string {
  if (err instanceof ApiError) return `${err.code}: ${err.message}`
  if (err instanceof NetworkError) return 'Cannot reach the runtime.'
  return err instanceof Error ? err.message : String(err)
}

export function WebSearchSection(): ReactElement {
  const query = useQuery({
    queryKey: ['settings', 'web-search'],
    queryFn: () => api.settingsWebSearchGet(),
    staleTime: 10_000,
  })
  if (query.isLoading) {
    return (
      <Card padding={20}>
        <LoadingState rows={2} />
      </Card>
    )
  }
  if (query.isError) {
    return (
      <Card padding={0}>
        <ErrorState title="Could not load web search settings" body={formatError(query.error)} />
      </Card>
    )
  }
  const data = query.data
  if (!data) return <></>
  return <WebSearchCard settings={data} />
}

function WebSearchCard({ settings }: { settings: WebSearchSettings }): ReactElement {
  const qc = useQueryClient()
  // All key/cx inputs start empty and reset to empty on save. None is seeded
  // from server state ... that avoids a stale-prop-into-state bug where an
  // externally-changed value (another tab, the daemon) would let a Save
  // resubmit the old value. The current cx (a non-secret id) shows in the
  // field's placeholder instead; an empty input means "leave unchanged".
  const [brave, setBrave] = useState('')
  const [gemini, setGemini] = useState('')
  const [gKey, setGKey] = useState('')
  const [gCx, setGCx] = useState('')

  const save = useMutation({
    mutationFn: (body: WebSearchUpdate) => api.settingsWebSearchSet(body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['settings', 'web-search'] })
      setBrave('')
      setGemini('')
      setGKey('')
      setGCx('')
    },
  })

  // Google needs BOTH a key and a cx to function, so we only PIN provider
  // 'google' when the save will leave both present ... otherwise the pin is
  // inert (resolveSearchProvider ignores google without a cx) and silently
  // defeats the operator's choice.
  const googleWillHaveKey = settings.google.key_set || gKey.trim() !== ''
  const googleWillHaveCx = settings.google.cx_set || gCx.trim() !== ''

  // Which providers are fully configured (so we offer a "prefer" toggle).
  const configured: ('brave' | 'gemini' | 'google')[] = []
  if (settings.brave.key_set) configured.push('brave')
  if (settings.gemini.key_set) configured.push('gemini')
  if (settings.google.key_set && settings.google.cx_set) configured.push('google')

  return (
    <section>
      <SectionHeader title="WEB SEARCH" />
      <Card padding={20}>
        <div className={styles.body}>
          <p className={styles.note}>
            Agents search the web via Brave (default), Gemini, or Google. Bring your own key (each
            has a free tier); it lives in your runtime.env. Active right now:{' '}
            {settings.active_provider ? <code>{settings.active_provider}</code> : 'none yet'}.
          </p>

          <div className={styles.provider}>
            <div className={styles.head}>
              <span className={styles.label}>Brave Search</span>
              {settings.brave.key_set ? (
                <Pill variant="info" size="sm" dot>
                  key set
                </Pill>
              ) : (
                <Pill variant="attention" size="sm" dot>
                  no key
                </Pill>
              )}
            </div>
            <div className={styles.row}>
              <Input
                type="password"
                placeholder={
                  settings.brave.key_set
                    ? `set (${settings.brave.key_masked ?? '••••'}) — paste to replace`
                    : 'paste Brave Search API key'
                }
                value={brave}
                onChange={(e) => {
                  setBrave(e.target.value)
                }}
                aria-label="Brave Search API key"
              />
              <Button
                variant="primary"
                disabled={brave.trim() === '' || save.isPending}
                onClick={() => {
                  save.mutate({ brave_api_key: brave.trim(), provider: 'brave' })
                }}
              >
                Save
              </Button>
            </div>
          </div>

          <div className={styles.provider}>
            <div className={styles.head}>
              <span className={styles.label}>Gemini (Google Search grounding)</span>
              {settings.gemini.key_set ? (
                <Pill variant="info" size="sm" dot>
                  key set
                </Pill>
              ) : (
                <Pill variant="idle" size="sm" dot>
                  no key
                </Pill>
              )}
            </div>
            <div className={styles.row}>
              <Input
                type="password"
                placeholder={
                  settings.gemini.key_set
                    ? `set (${settings.gemini.key_masked ?? '••••'}) — paste to replace`
                    : 'paste Gemini API key (aistudio.google.com/apikey)'
                }
                value={gemini}
                onChange={(e) => {
                  setGemini(e.target.value)
                }}
                aria-label="Gemini API key"
              />
              <Button
                variant="primary"
                disabled={gemini.trim() === '' || save.isPending}
                onClick={() => {
                  save.mutate({ gemini_search_api_key: gemini.trim(), provider: 'gemini' })
                }}
              >
                Save
              </Button>
            </div>
          </div>

          <div className={styles.provider}>
            <div className={styles.head}>
              <span className={styles.label}>Google Programmable Search</span>
              {settings.google.key_set && settings.google.cx_set ? (
                <Pill variant="info" size="sm" dot>
                  configured
                </Pill>
              ) : (
                <Pill variant="idle" size="sm" dot>
                  needs key + engine id
                </Pill>
              )}
            </div>
            <div className={styles.row}>
              <Input
                type="password"
                placeholder={
                  settings.google.key_set
                    ? `key set (${settings.google.key_masked ?? '••••'})`
                    : 'Google API key'
                }
                value={gKey}
                onChange={(e) => {
                  setGKey(e.target.value)
                }}
                aria-label="Google Search API key"
              />
              <Input
                placeholder={
                  settings.google.cx_set
                    ? `engine id set (${settings.google.cx ?? ''}) — type to replace`
                    : 'Search engine ID (cx)'
                }
                value={gCx}
                onChange={(e) => {
                  setGCx(e.target.value)
                }}
                aria-label="Google Search engine ID"
              />
              <Button
                variant="primary"
                disabled={(gKey.trim() === '' && gCx.trim() === '') || save.isPending}
                onClick={() => {
                  save.mutate({
                    ...(gKey.trim() === '' ? {} : { google_search_api_key: gKey.trim() }),
                    ...(gCx.trim() === '' ? {} : { google_search_cx: gCx.trim() }),
                    // Only pin Google when it'll actually be usable (key + cx),
                    // else the pin is inert and silently defeats the choice.
                    ...(googleWillHaveKey && googleWillHaveCx
                      ? { provider: 'google' as const }
                      : {}),
                  })
                }}
              >
                Save
              </Button>
            </div>
          </div>

          {configured.length >= 2 ? (
            <div className={styles.prefer}>
              <span>Prefer:</span>
              {configured.map((p) => (
                <Button
                  key={p}
                  size="sm"
                  variant={settings.active_provider === p ? 'primary' : 'default'}
                  onClick={() => {
                    save.mutate({ provider: p })
                  }}
                >
                  {p === 'brave' ? 'Brave' : p === 'gemini' ? 'Gemini' : 'Google'}
                </Button>
              ))}
            </div>
          ) : null}

          {save.isError ? <ErrorState title="Save failed" body={formatError(save.error)} /> : null}
          {save.isSuccess ? (
            <div className={styles.saved}>
              Saved. Live on your Agents' next search ... no restart needed.
            </div>
          ) : null}
        </div>
      </Card>
    </section>
  )
}
