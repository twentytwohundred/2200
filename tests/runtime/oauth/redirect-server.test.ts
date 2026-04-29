import { afterEach, describe, expect, it } from 'vitest'
import { startRedirectServer } from '../../../src/runtime/oauth/redirect-server.js'
import { OAuthError } from '../../../src/runtime/oauth/types.js'

const handles: { close: () => Promise<void> }[] = []

afterEach(async () => {
  for (const h of handles.splice(0)) {
    await h.close()
  }
})

describe('startRedirectServer', () => {
  it('binds to an ephemeral port and exposes /callback', async () => {
    const handle = await startRedirectServer({ port: 0 })
    handles.push(handle)
    expect(handle.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)
    expect(handle.port).toBeGreaterThan(0)
  })

  it('resolves the result on a valid callback (code + state)', async () => {
    const handle = await startRedirectServer({ port: 0, timeoutMs: 5000 })
    handles.push(handle)
    const cb = fetch(`${handle.url}?code=abc123&state=mystate`).then((r) => r.text())
    const r = await handle.result
    expect(r.code).toBe('abc123')
    expect(r.state).toBe('mystate')
    const html = await cb
    expect(html).toMatch(/2200 oauth complete/)
  })

  it('rejects when the provider redirects with error', async () => {
    const handle = await startRedirectServer({ port: 0, timeoutMs: 5000 })
    handles.push(handle)
    const cb = fetch(`${handle.url}?error=access_denied&error_description=user+said+no`).then((r) =>
      r.text(),
    )
    const errCaught = handle.result.catch((e: unknown) => e)
    await cb
    const err = await errCaught
    expect(err).toBeInstanceOf(OAuthError)
    expect((err as OAuthError).code).toBe('PROVIDER_DENIED')
  })

  it('returns 404 for non-/callback paths', async () => {
    const handle = await startRedirectServer({ port: 0 })
    handles.push(handle)
    const res = await fetch(`http://127.0.0.1:${String(handle.port)}/somethingelse`)
    expect(res.status).toBe(404)
  })

  it('rejects on timeout', async () => {
    const handle = await startRedirectServer({ port: 0, timeoutMs: 100 })
    handles.push(handle)
    const err = await handle.result.catch((e: unknown) => e)
    expect(err).toBeInstanceOf(OAuthError)
    expect((err as OAuthError).code).toBe('CALLBACK_TIMEOUT')
  })

  it('rejects on abort', async () => {
    const ctl = new AbortController()
    const handle = await startRedirectServer({ port: 0, timeoutMs: 5000, signal: ctl.signal })
    handles.push(handle)
    setTimeout(() => {
      ctl.abort()
    }, 50)
    const err = await handle.result.catch((e: unknown) => e)
    expect(err).toBeInstanceOf(OAuthError)
    expect((err as OAuthError).code).toBe('CALLBACK_TIMEOUT')
  })
})
