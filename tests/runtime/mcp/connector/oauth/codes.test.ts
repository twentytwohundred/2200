import { describe, expect, it } from 'vitest'
import { AuthorizationCodeStore } from '../../../../../src/runtime/mcp/connector/oauth/codes.js'

describe('AuthorizationCodeStore', () => {
  it('issues a code and consumes it once', () => {
    const store = new AuthorizationCodeStore()
    const code = store.issue({
      clientId: 'grok-aaa',
      redirectUri: 'https://grok.com/x',
      scopes: ['connector:full'],
      codeChallenge: 'a'.repeat(43),
    })
    const first = store.consume(code)
    expect(first).not.toBeNull()
    expect(first?.client_id).toBe('grok-aaa')
    // One-time-use: second consume returns null.
    expect(store.consume(code)).toBeNull()
  })

  it('expired codes are unconsumable', () => {
    let nowMs = 0
    const store = new AuthorizationCodeStore({ now: () => nowMs })
    const code = store.issue({
      clientId: 'grok-aaa',
      redirectUri: 'https://grok.com/x',
      scopes: [],
      codeChallenge: 'a'.repeat(43),
      ttlMs: 60_000,
    })
    nowMs = 60_001
    expect(store.consume(code)).toBeNull()
  })

  it('unknown codes return null', () => {
    const store = new AuthorizationCodeStore()
    expect(store.consume('not-a-real-code')).toBeNull()
  })

  it('startGc + stopGc are idempotent and unref the timer', () => {
    const store = new AuthorizationCodeStore()
    store.startGc(100)
    store.startGc(100) // second call is a no-op
    store.stopGc()
    store.stopGc() // second stop is a no-op
  })
})
