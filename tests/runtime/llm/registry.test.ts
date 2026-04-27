/**
 * Tests for the provider registry.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveProvider } from '../../../src/runtime/llm/registry.js'
import { LlmError } from '../../../src/runtime/llm/errors.js'
import { OpenAIProvider } from '../../../src/runtime/llm/openai.js'

const ALL_KEYS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'DEEPSEEK_API_KEY',
  'KIMI_API_KEY',
  'OPENROUTER_API_KEY',
  'GEMINI_API_KEY',
]

function clearKeys(): void {
  for (const k of ALL_KEYS) Reflect.deleteProperty(process.env, k)
}

beforeEach(clearKeys)
afterEach(clearKeys)

describe('resolveProvider', () => {
  it('returns an AnthropicProvider for "anthropic" using the default env var', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-anthropic'
    const provider = await resolveProvider({ providerName: 'anthropic' })
    expect(provider.name).toBe('anthropic')
    expect(provider.baseUrl).toBe('https://api.anthropic.com')
  })

  it('returns an OpenAIProvider for "openai" using the default env var', async () => {
    process.env['OPENAI_API_KEY'] = 'sk-openai'
    const provider = await resolveProvider({ providerName: 'openai' })
    expect(provider.name).toBe('openai')
    expect(provider.baseUrl).toBe('https://api.openai.com')
  })

  it('routes "deepseek" to OpenAIProvider with deepseek baseUrl', async () => {
    process.env['DEEPSEEK_API_KEY'] = 'sk-deepseek'
    const provider = await resolveProvider({ providerName: 'deepseek' })
    expect(provider).toBeInstanceOf(OpenAIProvider)
    expect(provider.name).toBe('deepseek')
    expect(provider.baseUrl).toBe('https://api.deepseek.com')
    expect((provider as OpenAIProvider).endpointUrl).toBe(
      'https://api.deepseek.com/v1/chat/completions',
    )
  })

  it('routes "kimi" to OpenAIProvider with moonshot baseUrl', async () => {
    process.env['KIMI_API_KEY'] = 'sk-kimi'
    const provider = await resolveProvider({ providerName: 'kimi' })
    expect(provider).toBeInstanceOf(OpenAIProvider)
    expect(provider.name).toBe('kimi')
    expect(provider.baseUrl).toBe('https://api.moonshot.ai')
  })

  it('routes "openrouter" to OpenAIProvider with openrouter baseUrl', async () => {
    process.env['OPENROUTER_API_KEY'] = 'sk-or'
    const provider = await resolveProvider({ providerName: 'openrouter' })
    expect(provider).toBeInstanceOf(OpenAIProvider)
    expect(provider.name).toBe('openrouter')
    expect(provider.baseUrl).toBe('https://openrouter.ai/api')
    expect((provider as OpenAIProvider).endpointUrl).toBe(
      'https://openrouter.ai/api/v1/chat/completions',
    )
  })

  it('routes "gemini" to OpenAIProvider with the custom OpenAI-compat endpoint path', async () => {
    process.env['GEMINI_API_KEY'] = 'sk-gemini'
    const provider = await resolveProvider({ providerName: 'gemini' })
    expect(provider).toBeInstanceOf(OpenAIProvider)
    expect(provider.name).toBe('gemini')
    // Gemini's compat layer is not at /v1/chat/completions; the registry
    // sets the full endpointUrl override for it.
    expect((provider as OpenAIProvider).endpointUrl).toBe(
      'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    )
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
    expect((err as LlmError).message).toContain('Known providers')
    Reflect.deleteProperty(process.env, 'UNKNOWN_API_KEY')
  })

  it('propagates SecretResolveError when the env var is missing', async () => {
    await expect(resolveProvider({ providerName: 'anthropic' })).rejects.toMatchObject({
      name: 'SecretResolveError',
      code: 'ENV_MISSING',
    })
  })

  it('propagates SecretResolveError for new providers when their env var is missing', async () => {
    await expect(resolveProvider({ providerName: 'kimi' })).rejects.toMatchObject({
      name: 'SecretResolveError',
      code: 'ENV_MISSING',
    })
  })
})
