/**
 * Auth bootstrap.
 *
 * v1 stores a single bearer token in localStorage. The CLI prints the
 * URL with `?token=<value>` appended once on first start; the web app
 * reads the query param, persists the token, and strips the param so
 * page reloads don't keep it in the URL bar. After that, all requests
 * carry `Authorization: Bearer <token>` from local storage.
 *
 * `localStorage` access is wrapped in try/catch because Safari private
 * mode and some jsdom builds raise on every storage call.
 */
const STORAGE_KEY = '2200.auth.token'

function readStorage(): string | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

function writeStorage(value: string | null): void {
  if (typeof window === 'undefined') return
  try {
    if (value === null) {
      window.localStorage.removeItem(STORAGE_KEY)
    } else {
      window.localStorage.setItem(STORAGE_KEY, value)
    }
  } catch {
    /* storage unavailable; the caller will see a missing token next reload */
  }
}

/**
 * Run once at startup. If the URL has a `?token=` query, persist it
 * and strip the query from the URL bar; otherwise leave existing
 * storage alone.
 */
export function bootstrapAuth(): void {
  if (typeof window === 'undefined') return
  const params = new URLSearchParams(window.location.search)
  const fromUrl = params.get('token')
  if (fromUrl && fromUrl.length > 0) {
    writeStorage(fromUrl)
    params.delete('token')
    const remaining = params.toString()
    const next =
      window.location.pathname + (remaining ? `?${remaining}` : '') + window.location.hash
    window.history.replaceState(null, '', next)
  }
}

export function getToken(): string | null {
  return readStorage()
}

export function setToken(value: string): void {
  writeStorage(value)
}

export function clearToken(): void {
  writeStorage(null)
}
