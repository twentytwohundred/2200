/**
 * One-shot localhost redirect server (Epic 9 Phase B-2).
 *
 * Binds to a free port on 127.0.0.1, exposes `/callback`, waits for
 * the provider to redirect back with `code` + `state` query params.
 * Returns those + the bound URL to the caller. Closes itself on the
 * first successful callback OR on timeout / abort.
 *
 * The server intentionally serves only `/callback` and returns 404
 * for any other path. The body returned to the user is a tiny "you
 * can close this tab" page; it does NOT echo the code (the code
 * stays in the URL, which the user is supposed to close).
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { URL } from 'node:url'
import { OAuthError } from './types.js'

export interface RedirectResult {
  code: string
  state: string
}

export interface RedirectServerHandle {
  url: string
  port: number
  /** Resolves on a valid callback. Rejects on timeout / error. */
  result: Promise<RedirectResult>
  /** Force-close the server. Idempotent. */
  close: () => Promise<void>
}

export interface StartRedirectServerOptions {
  /** Bind host. Default 127.0.0.1. */
  host?: string
  /** Specific port; 0 = random free. Default 0. */
  port?: number
  /** Timeout in ms for the user to complete the flow. Default 5 min. */
  timeoutMs?: number
  /** Optional AbortSignal that resolves the result with an error. */
  signal?: AbortSignal
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000

const SUCCESS_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>2200 oauth complete</title></head>
<body style="font-family:ui-monospace,monospace;padding:48px;background:#111;color:#eee">
<h1 style="margin:0 0 12px;font-size:20px">2200 oauth complete</h1>
<p style="margin:0 0 6px">You can close this tab. The runtime captured the credential.</p>
<p style="margin:0;color:#888;font-size:12px">If anything looked wrong, run <code>2200 oauth status &lt;agent&gt;</code> to inspect.</p>
</body></html>`

const ERROR_HTML = (msg: string): string => `<!doctype html>
<html><head><meta charset="utf-8"><title>2200 oauth error</title></head>
<body style="font-family:ui-monospace,monospace;padding:48px;background:#111;color:#eee">
<h1 style="margin:0 0 12px;font-size:20px;color:#f88">oauth error</h1>
<pre style="white-space:pre-wrap;background:#222;padding:12px;border-radius:6px">${escapeHtml(msg)}</pre>
</body></html>`

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function startRedirectServer(
  opts: StartRedirectServerOptions = {},
): Promise<RedirectServerHandle> {
  const host = opts.host ?? '127.0.0.1'
  const requestedPort = opts.port ?? 0
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS

  return new Promise((resolveOuter, rejectOuter) => {
    let resultResolve: ((v: RedirectResult) => void) | null = null
    let resultReject: ((e: Error) => void) | null = null
    const result = new Promise<RedirectResult>((r, j) => {
      resultResolve = r
      resultReject = j
    })

    let resolved = false
    let timer: NodeJS.Timeout | null = null
    let abortListener: (() => void) | null = null

    const server: Server = createServer((req, res) => {
      const reqUrl = req.url ?? '/'
      if (!reqUrl.startsWith('/callback')) {
        res.statusCode = 404
        res.setHeader('content-type', 'text/plain; charset=utf-8')
        res.end('not found')
        return
      }
      let parsed: URL
      try {
        parsed = new URL(reqUrl, `http://${host}:${String(boundPort)}`)
      } catch {
        res.statusCode = 400
        res.setHeader('content-type', 'text/html; charset=utf-8')
        res.end(ERROR_HTML('malformed callback URL'))
        return
      }
      const error = parsed.searchParams.get('error')
      if (error) {
        const desc = parsed.searchParams.get('error_description') ?? ''
        res.statusCode = 200
        res.setHeader('content-type', 'text/html; charset=utf-8')
        res.end(ERROR_HTML(`provider returned error: ${error}\n${desc}`))
        finishWithError(new OAuthError(`provider returned ${error}`, 'PROVIDER_DENIED'))
        return
      }
      const code = parsed.searchParams.get('code')
      const state = parsed.searchParams.get('state')
      if (!code || !state) {
        res.statusCode = 400
        res.setHeader('content-type', 'text/html; charset=utf-8')
        res.end(ERROR_HTML('callback is missing code or state'))
        return
      }
      res.statusCode = 200
      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.end(SUCCESS_HTML)
      finishWithSuccess({ code, state })
    })

    server.on('error', (err) => {
      if (resolved) return
      rejectOuter(err)
    })

    let boundPort = requestedPort
    server.listen(requestedPort, host, () => {
      const addr = server.address() as AddressInfo
      boundPort = addr.port
      const url = `http://${host}:${String(boundPort)}/callback`
      timer = setTimeout(() => {
        finishWithError(
          new OAuthError('callback did not arrive within the timeout', 'CALLBACK_TIMEOUT'),
        )
      }, timeoutMs)
      if (opts.signal) {
        abortListener = () => {
          finishWithError(new OAuthError('oauth flow aborted', 'CALLBACK_TIMEOUT'))
        }
        opts.signal.addEventListener('abort', abortListener, { once: true })
      }
      resolveOuter({
        url,
        port: boundPort,
        result,
        close: closeServer,
      })
    })

    function finishWithSuccess(r: RedirectResult): void {
      if (resolved) return
      resolved = true
      cleanup()
      resultResolve?.(r)
      void closeServer()
    }

    function finishWithError(err: Error): void {
      if (resolved) return
      resolved = true
      cleanup()
      resultReject?.(err)
      void closeServer()
    }

    function cleanup(): void {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      if (abortListener && opts.signal) {
        opts.signal.removeEventListener('abort', abortListener)
        abortListener = null
      }
    }

    function closeServer(): Promise<void> {
      return new Promise((resolveClose) => {
        server.close(() => {
          resolveClose()
        })
      })
    }
  })
}
