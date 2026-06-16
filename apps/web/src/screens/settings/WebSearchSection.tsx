/**
 * Web Search settings.
 *
 * Agents search the web via Brave (the default) or Google Programmable
 * Search ... bring-your-own-key, the same model OpenClaw uses. Keys persist
 * to runtime.env (carried over on an OpenClaw migration when present, or
 * pasted here). With nothing configured, web_search returns an actionable
 * status; once a key is in, Agents get real results.
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
  const [brave, setBrave] = useState('')
  const [gKey, setGKey] = useState('')
  const [gCx, setGCx] = useState(settings.google.cx ?? '')

  const save = useMutation({
    mutationFn: (body: WebSearchUpdate) => api.settingsWebSearchSet(body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['settings', 'web-search'] })
      setBrave('')
      setGKey('')
    },
  })

  const bothConfigured = settings.brave.key_set && settings.google.key_set && settings.google.cx_set

  return (
    <section>
      <SectionHeader title="WEB SEARCH" />
      <Card padding={20}>
        <div className={styles.body}>
          <p className={styles.note}>
            Agents search the web via Brave (default) or Google. Bring your own key (each has a free
            tier); it lives in your runtime.env. Active right now:{' '}
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
                placeholder="Search engine ID (cx)"
                value={gCx}
                onChange={(e) => {
                  setGCx(e.target.value)
                }}
                aria-label="Google Search engine ID"
              />
              <Button
                variant="primary"
                disabled={
                  (gKey.trim() === '' && gCx.trim() === (settings.google.cx ?? '')) ||
                  save.isPending
                }
                onClick={() => {
                  save.mutate({
                    ...(gKey.trim() === '' ? {} : { google_search_api_key: gKey.trim() }),
                    ...(gCx.trim() === '' ? {} : { google_search_cx: gCx.trim() }),
                    provider: 'google',
                  })
                }}
              >
                Save
              </Button>
            </div>
          </div>

          {bothConfigured ? (
            <div className={styles.prefer}>
              <span>Prefer:</span>
              <Button
                size="sm"
                variant={settings.active_provider === 'brave' ? 'primary' : 'default'}
                onClick={() => {
                  save.mutate({ provider: 'brave' })
                }}
              >
                Brave
              </Button>
              <Button
                size="sm"
                variant={settings.provider === 'google' ? 'primary' : 'default'}
                onClick={() => {
                  save.mutate({ provider: 'google' })
                }}
              >
                Google
              </Button>
            </div>
          ) : null}

          {save.isError ? <ErrorState title="Save failed" body={formatError(save.error)} /> : null}
          {save.isSuccess ? (
            <div className={styles.saved}>
              Saved. Restart the daemon (or it applies on next launch) for Agents to use it.
            </div>
          ) : null}
        </div>
      </Card>
    </section>
  )
}
