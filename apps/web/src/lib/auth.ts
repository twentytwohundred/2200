/**
 * Auth ... HttpOnly session cookie.
 *
 * The pasted 64-char token is exchanged, once, for a session cookie via
 * `POST /api/v1/auth/login`. After that the browser attaches the cookie to
 * every same-origin request automatically ... including the WebSocket handshake
 * and `<img>` loads ... so page JavaScript never holds the token (it's
 * `HttpOnly`, so an XSS bug can't exfiltrate it) and the token never rides in a
 * URL, history, or access log.
 */

/** Exchange a pasted token for a session cookie. Returns true on success. */
export async function login(token: string): Promise<boolean> {
  try {
    const res = await fetch('/api/v1/auth/login', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    })
    return res.ok
  } catch {
    return false
  }
}

/** Clear the session cookie (best-effort). */
export async function logout(): Promise<void> {
  try {
    await fetch('/api/v1/auth/logout', { method: 'POST', credentials: 'include' })
  } catch {
    /* best-effort; the cookie clears on the server or expires regardless */
  }
}
