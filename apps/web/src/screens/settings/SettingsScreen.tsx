/**
 * Settings ... v0.1.
 *
 * Theme picker, About panel (runtime version + principal + WS
 * status), and a CLI reference for the management surfaces that
 * don't yet have a web UI (token rotation, OAuth login, agent
 * editing, daemon ops).
 *
 * What's intentionally NOT here at v1:
 *   - Token CRUD (the runtime exposes tokens via the CLI's
 *     `2200 web token` family; web-side rotation is a later add
 *     because it changes the bearer the user is currently using).
 *   - Default model picker. The model registry's surface
 *     (`2200 model ...`) is the v1 management point.
 *   - Daily-cap defaults. The Identity per-Agent value is what
 *     ships today; an instance default is a separate decision.
 *
 * Anything in 'WHAT YOU CAN DO IN THE CLI' is what the user types
 * in their shell to manage the things this screen does NOT have a
 * UI for yet.
 */
import { useState, type ReactElement } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiError, NetworkError, api, type ProviderSettingsItem } from '../../lib/api'
import {
  Card,
  cx,
  ErrorState,
  KV,
  LoadingState,
  PageHeader,
  Pill,
  SectionHeader,
} from '../../primitives'
import { useTheme } from '../../theme/ThemeProvider'
import { useLiveSignal } from '../../ws/useLiveSignal'
import styles from './SettingsScreen.module.css'

const CLI_REFERENCE: { command: string; description: string }[] = [
  { command: '2200 web token list', description: 'list bearer tokens' },
  { command: '2200 web token rotate', description: 'rotate the default token' },
  { command: '2200 oauth login google', description: 'log into Google for Gmail / Calendar' },
  { command: '2200 oauth login github', description: 'log into GitHub' },
  { command: '2200 oauth status', description: 'show OAuth credential status' },
  { command: '2200 agent edit <name>', description: 'open the Identity in your $EDITOR' },
  { command: '2200 agent spawn', description: 'CLI conversational onboarding' },
  { command: '2200 daemon status', description: 'check the supervisor process' },
  { command: '2200 daemon restart', description: 'restart the supervisor' },
]

function formatError(err: unknown): string {
  if (err instanceof ApiError) return `${err.code}: ${err.message}`
  if (err instanceof NetworkError) return 'Cannot reach the runtime.'
  return err instanceof Error ? err.message : String(err)
}

export function SettingsScreen(): ReactElement {
  const { theme, setTheme } = useTheme()
  const live = useLiveSignal()

  const meQuery = useQuery({
    queryKey: ['me'],
    queryFn: () => api.me(),
    staleTime: 60_000,
  })

  const versionQuery = useQuery({
    queryKey: ['runtime', 'version'],
    queryFn: () => api.version(),
    staleTime: 60_000,
  })

  const healthQuery = useQuery({
    queryKey: ['runtime', 'health'],
    queryFn: () => api.health(),
    staleTime: 30_000,
  })

  const eyebrow = `2200 · SETTINGS · ${theme.toUpperCase()} · WS ${live.status.toUpperCase()}`

  return (
    <main className={styles.shell}>
      <PageHeader
        eyebrow={eyebrow}
        title="Settings"
        subtitle="Theme, runtime info, and a reference for management surfaces still on the CLI."
        actions={
          <Link
            to="/"
            style={{
              fontFamily: 'var(--type-family-mono)',
              fontSize: '11px',
              letterSpacing: '0.08em',
              color: 'var(--color-text-muted)',
              textDecoration: 'none',
            }}
          >
            ← FLEET
          </Link>
        }
      />

      <section>
        <SectionHeader title="THEME" />
        <Card padding={20}>
          <div className={styles.themeRow}>
            <button
              type="button"
              className={styles.themeChip}
              data-active={theme === 'default-dark'}
              onClick={() => {
                setTheme('default-dark')
              }}
            >
              DARK
            </button>
            <button
              type="button"
              className={styles.themeChip}
              data-active={theme === 'default-light'}
              onClick={() => {
                setTheme('default-light')
              }}
            >
              LIGHT
            </button>
          </div>
        </Card>
      </section>

      <section>
        <SectionHeader title="ABOUT" />
        {meQuery.isLoading || versionQuery.isLoading || healthQuery.isLoading ? (
          <Card padding={20}>
            <LoadingState rows={3} />
          </Card>
        ) : meQuery.isError || versionQuery.isError ? (
          <Card padding={0}>
            <ErrorState
              title="Could not load runtime info"
              body={formatError(meQuery.error ?? versionQuery.error)}
            />
          </Card>
        ) : (
          <Card padding={20}>
            <div className={styles.statusGrid}>
              <KV
                k="API"
                v={
                  <span style={{ fontFamily: 'var(--type-family-mono)' }}>
                    {versionQuery.data?.api ?? '?'}
                  </span>
                }
              />
              <KV
                k="RUNTIME"
                v={
                  <span style={{ fontFamily: 'var(--type-family-mono)' }}>
                    {versionQuery.data?.runtime ?? '?'}
                  </span>
                }
              />
              <KV
                k="HEALTHY"
                v={
                  healthQuery.data?.healthy ? (
                    <Pill variant="info">YES</Pill>
                  ) : (
                    <Pill variant="error">NO</Pill>
                  )
                }
              />
              <KV
                k="PRINCIPAL"
                v={
                  <span style={{ fontFamily: 'var(--type-family-mono)' }}>
                    {meQuery.data ? `${meQuery.data.kind}/${meQuery.data.name}` : '?'}
                  </span>
                }
              />
              <KV
                k="WS"
                v={
                  <Pill variant={live.status === 'open' ? 'info' : 'idle'}>
                    {live.status.toUpperCase()}
                  </Pill>
                }
              />
            </div>
          </Card>
        )}
      </section>

      <section>
        <SectionHeader title="MODELS & API KEYS" />
        <ProvidersSection />
      </section>

      <section>
        <SectionHeader title="WHAT YOU CAN DO IN THE CLI" />
        <div className={styles.cliCallout}>
          <div className={styles.cliLabel}>v1 management</div>
          <div className={styles.cliBody}>
            Token rotation, OAuth login, and Identity edits live in the CLI for now. A web surface
            for these will land in a later phase.
          </div>
          <div className={styles.cliList}>
            {CLI_REFERENCE.map((row) => (
              <div key={row.command} className={styles.cliRow}>
                <code>{row.command}</code>
                <span>{row.description}</span>
              </div>
            ))}
          </div>
        </div>
      </section>
    </main>
  )
}

function ProvidersSection(): ReactElement {
  const query = useQuery({
    queryKey: ['settings', 'providers'],
    queryFn: () => api.settingsProvidersList(),
    staleTime: 10_000,
  })

  if (query.isLoading) {
    return (
      <Card padding={20}>
        <LoadingState rows={3} />
      </Card>
    )
  }
  if (query.isError) {
    return (
      <Card padding={0}>
        <ErrorState title="Could not load providers" body={formatError(query.error)} />
      </Card>
    )
  }
  const data = query.data
  if (!data) return <></>
  return (
    <div className={styles.providersGrid}>
      {data.items.map((p) => (
        <ProviderCard key={p.name} provider={p} />
      ))}
    </div>
  )
}

function ProviderCard({ provider }: { provider: ProviderSettingsItem }): ReactElement {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [draftKey, setDraftKey] = useState('')
  const [draftUrl, setDraftUrl] = useState(provider.baseUrl)

  const setKey = useMutation({
    mutationFn: (key: string) => api.settingsProviderKeySet(provider.name, key),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['settings', 'providers'] })
      setDraftKey('')
      setOpen(false)
    },
  })
  const clearKey = useMutation({
    mutationFn: () => api.settingsProviderKeyClear(provider.name),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['settings', 'providers'] })
    },
  })
  const setUrl = useMutation({
    mutationFn: (url: string) => api.settingsLocalUrlSet(url),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['settings', 'providers'] })
    },
  })

  const error = setKey.error ?? clearKey.error ?? setUrl.error
  return (
    <div className={styles.providerCard}>
      <div className={styles.providerHead}>
        <div className={styles.providerLabel}>{provider.label}</div>
        {provider.key_set ? (
          <Pill variant="info">KEY SET</Pill>
        ) : provider.keyOptional ? (
          <Pill variant="idle">OPTIONAL</Pill>
        ) : (
          <Pill variant="attention">NO KEY</Pill>
        )}
        <button
          type="button"
          className={styles.providerBtn}
          onClick={() => {
            setOpen((v) => !v)
          }}
        >
          {open ? 'CLOSE' : provider.key_set ? 'CHANGE' : 'ADD KEY'}
        </button>
        {provider.key_set ? (
          <button
            type="button"
            className={styles.providerBtn}
            onClick={() => {
              if (window.confirm(`Remove ${provider.defaultEnvKey} from runtime.env?`)) {
                clearKey.mutate()
              }
            }}
            disabled={clearKey.isPending}
          >
            CLEAR
          </button>
        ) : null}
      </div>

      <div className={styles.providerMeta}>
        <div className={styles.providerMetaRow}>
          <span className={styles.providerMetaKey}>env var</span>
          <span className={styles.providerMetaValue}>{provider.defaultEnvKey}</span>
        </div>
        <div className={styles.providerMetaRow}>
          <span className={styles.providerMetaKey}>base url</span>
          <span className={styles.providerMetaValue}>{provider.baseUrl}</span>
        </div>
        {provider.key_masked ? (
          <div className={styles.providerMetaRow}>
            <span className={styles.providerMetaKey}>key</span>
            <span className={styles.providerMetaValue}>{provider.key_masked}</span>
          </div>
        ) : null}
        {provider.agents_using.length > 0 ? (
          <div className={styles.providerMetaRow}>
            <span className={styles.providerMetaKey}>agents</span>
            <span className={styles.providerMetaValue}>{provider.agents_using.join(', ')}</span>
          </div>
        ) : null}
        {provider.suggested_models.length > 0 ? (
          <div className={styles.providerMetaRow}>
            <span className={styles.providerMetaKey}>models</span>
            <span className={styles.providerMetaValue}>
              <span className={styles.providerSuggestions}>
                {provider.suggested_models.map((m) => (
                  <span key={m} className={styles.providerSuggestion}>
                    {m}
                  </span>
                ))}
              </span>
            </span>
          </div>
        ) : null}
      </div>

      {open ? (
        <div className={styles.providerActions}>
          <input
            type="password"
            className={styles.providerInput}
            placeholder={`paste ${provider.defaultEnvKey} value`}
            value={draftKey}
            onChange={(e) => {
              setDraftKey(e.target.value)
            }}
            autoComplete="off"
            spellCheck={false}
          />
          <button
            type="button"
            className={cx(styles.providerBtn, styles.providerBtnPrimary)}
            onClick={() => {
              if (draftKey.length > 0) setKey.mutate(draftKey)
            }}
            disabled={setKey.isPending || draftKey.length === 0}
          >
            {setKey.isPending ? 'SAVING…' : 'SAVE KEY'}
          </button>
        </div>
      ) : null}

      {provider.baseUrlEditable ? (
        <div className={styles.providerActions}>
          <input
            type="url"
            className={styles.providerInput}
            placeholder="http://localhost:11434/v1"
            value={draftUrl}
            onChange={(e) => {
              setDraftUrl(e.target.value)
            }}
            spellCheck={false}
          />
          <button
            type="button"
            className={styles.providerBtn}
            onClick={() => {
              if (draftUrl.length > 0 && draftUrl !== provider.baseUrl) setUrl.mutate(draftUrl)
            }}
            disabled={setUrl.isPending || draftUrl === provider.baseUrl}
          >
            {setUrl.isPending ? 'SAVING…' : 'SAVE URL'}
          </button>
        </div>
      ) : null}

      {provider.key_set || provider.agents_using.length > 0 ? (
        <div className={styles.providerNote}>
          Restart agents using this provider to pick up key/URL changes.
        </div>
      ) : null}

      {error ? <ErrorState title="Save failed" body={formatError(error)} /> : null}
    </div>
  )
}
