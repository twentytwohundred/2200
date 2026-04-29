import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  findProvider,
  knownProviders,
  PROVIDERS,
  readClientCredentials,
} from '../../../src/runtime/oauth/providers.js'

describe('PROVIDERS registry', () => {
  it('declares google, github, slack', () => {
    const names = knownProviders()
    expect(names).toContain('google')
    expect(names).toContain('github')
    expect(names).toContain('slack')
  })

  it('every entry has an HTTPS authUrl + tokenUrl', () => {
    for (const name of knownProviders()) {
      const cfg = PROVIDERS[name]
      expect(cfg).toBeDefined()
      expect(cfg?.authUrl.startsWith('https://')).toBe(true)
      expect(cfg?.tokenUrl.startsWith('https://')).toBe(true)
      expect(cfg?.defaultScopes.length).toBeGreaterThan(0)
    }
  })

  it('Google config requests a refresh token via access_type + prompt', () => {
    const g = findProvider('google')
    expect(g?.extraAuthParams?.['access_type']).toBe('offline')
    expect(g?.extraAuthParams?.['prompt']).toBe('consent')
  })
})

describe('readClientCredentials', () => {
  const ID = '_2200_OAUTH_GOOGLE_CLIENT_ID'
  const SECRET = '_2200_OAUTH_GOOGLE_CLIENT_SECRET'

  function clearEnv(): void {
    Reflect.deleteProperty(process.env, ID)
    Reflect.deleteProperty(process.env, SECRET)
  }

  beforeEach(() => {
    clearEnv()
  })

  afterEach(() => {
    clearEnv()
  })

  it('reports both null when neither env var is set', () => {
    const r = readClientCredentials('google')
    expect(r.clientId).toBeNull()
    expect(r.clientSecret).toBeNull()
    expect(r.envVarHints.id).toBe(ID)
    expect(r.envVarHints.secret).toBe(SECRET)
  })

  it('returns the env var values when set', () => {
    process.env[ID] = 'my-client-id'
    process.env[SECRET] = 'my-client-secret'
    const r = readClientCredentials('google')
    expect(r.clientId).toBe('my-client-id')
    expect(r.clientSecret).toBe('my-client-secret')
  })
})
