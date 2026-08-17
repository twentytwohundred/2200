/**
 * Auth gate.
 *
 * With cookie auth, page JS can't read the token (it's HttpOnly), so the gate
 * doesn't guess whether you're logged in ... it just makes an authed probe. The
 * browser attaches the session cookie automatically; a 401 means "no valid
 * session" → show the paste-your-token screen. Pasting the token POSTs it to
 * `/auth/login`, the server sets the cookie, and the probe re-runs clean. No
 * token in the URL, ever.
 */
import { useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ApiError, api } from '../lib/api'
import { login } from '../lib/auth'
import { Button, Input } from '../primitives'
import styles from './AuthGate.module.css'

export function AuthGate({ children }: { children: ReactNode }): ReactNode {
  // A cheap authed probe. The cookie (if any) is sent automatically.
  // `retry: false` so a missing/invalid session surfaces at once.
  const probe = useQuery({
    queryKey: ['auth', 'probe'],
    queryFn: () => api.agents(),
    retry: false,
    staleTime: 30_000,
  })

  if (probe.isLoading) {
    return (
      <div className={styles.center}>
        <div className={styles.muted}>Connecting...</div>
      </div>
    )
  }

  if (probe.isError) {
    const status = probe.error instanceof ApiError ? probe.error.status : 0
    if (status === 401 || status === 403) {
      return (
        <TokenScreen
          onSuccess={() => {
            void probe.refetch()
          }}
        />
      )
    }
    // A non-auth failure (daemon down, network) is NOT a session problem.
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

function TokenScreen({ onSuccess }: { onSuccess: () => void }): ReactNode {
  const [value, setValue] = useState('')
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)
  const trimmed = value.trim()

  const submit = async (): Promise<void> => {
    if (trimmed.length === 0 || pending) return
    setPending(true)
    setFailed(false)
    const ok = await login(trimmed)
    setPending(false)
    if (ok) onSuccess()
    else setFailed(true)
  }

  return (
    <div className={styles.center}>
      <form
        className={styles.panel}
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <div className={styles.mark}>● 2200</div>
        <h1 className={styles.title}>Enter your access token</h1>
        <p className={styles.muted}>
          Paste the token for this 2200 instance to sign in. It&rsquo;s stored as a secure,
          browser-only cookie ... not in this page, not in the URL.
        </p>
        <Input
          type="password"
          value={value}
          autoFocus
          placeholder="paste your token"
          aria-label="Access token"
          onChange={(e) => {
            setValue(e.target.value)
            if (failed) setFailed(false)
          }}
        />
        {failed && (
          <p className={styles.muted}>That token wasn&rsquo;t accepted. Check it and try again.</p>
        )}
        <Button
          variant="primary"
          onClick={() => void submit()}
          disabled={trimmed.length === 0 || pending}
        >
          {pending ? 'Signing in...' : 'Connect'}
        </Button>
        <p className={styles.hint}>
          Get a token with <code>2200 web token rotate</code> ... it prints the URL and the token.
        </p>
      </form>
    </div>
  )
}
