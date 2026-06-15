/**
 * Auth gate.
 *
 * The install / CLI hand the user a URL with `?token=` (consumed once by
 * bootstrapAuth). But a URL isn't always how someone gets back in: after
 * `2200 web token rotate`, or after the instance state was reset, the saved
 * token stops working and the only recovery used to be hand-editing
 * `?token=...` back into the address bar.
 *
 * This gate makes the bare token enough: when there is no token, or the
 * stored one no longer authenticates, it shows a paste-your-token screen.
 * Paste the value the CLI printed and you're back in ... no URL surgery.
 */
import { useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ApiError, api } from '../lib/api'
import { getToken, setToken } from '../lib/auth'
import { Button, Input } from '../primitives'
import styles from './AuthGate.module.css'

export function AuthGate({ children }: { children: ReactNode }): ReactNode {
  const hasToken = getToken() !== null

  // A cheap authed probe. Disabled when there's no token (we go straight to
  // the entry screen). `retry: false` so an invalid token surfaces at once.
  const probe = useQuery({
    queryKey: ['auth', 'probe'],
    queryFn: () => api.agents(),
    enabled: hasToken,
    retry: false,
    staleTime: 30_000,
  })

  if (!hasToken) return <TokenScreen reason="missing" />

  if (probe.isLoading) {
    return (
      <div className={styles.center}>
        <div className={styles.muted}>Connecting...</div>
      </div>
    )
  }

  if (probe.isError) {
    const status = probe.error instanceof ApiError ? probe.error.status : 0
    if (status === 401 || status === 403) return <TokenScreen reason="invalid" />
    // A non-auth failure (daemon down, network) is NOT a token problem ...
    // don't make the user re-enter a token that's fine.
    return (
      <div className={styles.center}>
        <div className={styles.panel}>
          <div className={styles.mark}>● 2200</div>
          <p className={styles.muted}>Can&rsquo;t reach 2200. Is the daemon running?</p>
          <Button
            onClick={() => {
              void probe.refetch()
            }}
          >
            Retry
          </Button>
        </div>
      </div>
    )
  }

  return <>{children}</>
}

function TokenScreen({ reason }: { reason: 'missing' | 'invalid' }): ReactNode {
  const [value, setValue] = useState('')
  const trimmed = value.trim()

  const submit = (): void => {
    if (trimmed.length === 0) return
    setToken(trimmed)
    // Reload so bootstrapAuth + the gate re-run cleanly against the new token.
    window.location.reload()
  }

  return (
    <div className={styles.center}>
      <form
        className={styles.panel}
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <div className={styles.mark}>● 2200</div>
        <h1 className={styles.title}>
          {reason === 'invalid' ? 'Your access token expired' : 'Enter your access token'}
        </h1>
        <p className={styles.muted}>
          {reason === 'invalid'
            ? 'The saved token no longer works (it was rotated, or the instance was reset). Paste a fresh one to get back in.'
            : 'Paste the bearer token for this 2200 instance to continue.'}
        </p>
        <Input
          type="password"
          value={value}
          autoFocus
          placeholder="paste your token"
          aria-label="Access token"
          onChange={(e) => {
            setValue(e.target.value)
          }}
        />
        <Button variant="primary" onClick={submit} disabled={trimmed.length === 0}>
          Connect
        </Button>
        <p className={styles.hint}>
          Get a token with <code>2200 web token rotate</code> ... it prints the URL and the token.
        </p>
      </form>
    </div>
  )
}
