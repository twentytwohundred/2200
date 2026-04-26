/**
 * Tests for the provider registry.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveProvider } from '../../../src/runtime/llm/registry.js'
import { LlmError } from '../../../src/runtime/llm/errors.js'

const ANTHROPIC_KEY = 'ANTHROPIC_API_KEY'
const OPENAI_KEY = 'OPENAI_API_KEY'

beforeEach(() => {
  Reflect.deleteProperty(process.env, ANTHROPIC_KEY)
  Reflect.deleteProperty(process.env, OPENAI_KEY)
})

afterEach(() => {
  Reflect.deleteProperty(process.env, ANTHROPIC_KEY)
  Reflect.deleteProperty(process.env, OPENAI_KEY)
})

describe('resolveProvider', () => {
  it('returns an AnthropicProvider for "anthropic" using the default env var', async () => {
    process.env[ANTHROPIC_KEY] = 'sk-anthropic'
    const provider = await resolveProvider({ providerName: 'anthropic' })
    expect(provider.name).toBe('anthropic')
    expect(provider.baseUrl).toBe('https://api.anthropic.com')
  })

  it('returns an OpenAIProvider for "openai" using the default env var', async () => {
    process.env[OPENAI_KEY] = 'sk-openai'
    const provider = await resolveProvider({ providerName: 'openai' })
    expect(provider.name).toBe('openai')
    expect(provider.baseUrl).toBe('https://api.openai.com')
  })

  it('honors an explicit secret reference over the default', async () => {
    process.env['CUSTOM_KEY_VAR'] = 'sk-custom'
    const provider = await resolveProvider({
      providerName: 'anthropic',
      secret: { source: 'env', id: 'CUSTOM_KEY_VAR' },
    })
    expect(provider.name).toBe('anthropic')
    Reflect.deleteProperty(process.env, 'CUSTOM_KEY_VAR')
  })

  it('throws CONFIG_ERROR for an unsupported provider', async () => {
    process.env['UNKNOWN_API_KEY'] = 'irrelevant'
    const err = await resolveProvider({ providerName: 'unknown' }).catch(
      (e: unknown) => e as LlmError,
    )
    expect(err).toBeInstanceOf(LlmError)
    expect((err as LlmError).code).toBe('CONFIG_ERROR')
    Reflect.deleteProperty(process.env, 'UNKNOWN_API_KEY')
  })

  it('propagates SecretResolveError when the env var is missing', async () => {
    await expect(resolveProvider({ providerName: 'anthropic' })).rejects.toMatchObject({
      name: 'SecretResolveError',
      code: 'ENV_MISSING',
    })
  })
})
