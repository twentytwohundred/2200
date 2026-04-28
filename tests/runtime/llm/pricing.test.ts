/**
 * Tests for the LLM pricing module.
 *
 * Covers:
 *  - Default-table loads and validates against the schema.
 *  - Lookup hit: known model returns a numeric cost.
 *  - Lookup miss: unknown model returns null.
 *  - Math: input + output rates apply correctly.
 *  - Cache: cached tokens billed at cached_input_per_mtok_usd when set.
 *  - Cache fallback: cached tokens fall through to standard input rate
 *    when the table entry has no cached_input_per_mtok_usd column.
 *  - Provider name normalization to lowercase.
 *  - Zero token counts produce zero cost.
 */
import { describe, expect, it } from 'vitest'
import {
  computeCostUsd,
  defaultPricingTable,
  loadPricingTable,
  pricingKey,
  PricingTableSchema,
  type PricingTable,
} from '../../../src/runtime/llm/pricing.js'

describe('default pricing table', () => {
  it('loads, validates against the schema, and returns a non-empty models map', () => {
    const table = loadPricingTable()
    expect(() => PricingTableSchema.parse(table)).not.toThrow()
    expect(table.schema_version).toBe(1)
    expect(Object.keys(table.models).length).toBeGreaterThan(0)
  })

  it('caches the parsed default across calls', () => {
    const a = defaultPricingTable()
    const b = defaultPricingTable()
    expect(a).toBe(b)
  })

  it('contains entries for the six wired providers', () => {
    const table = loadPricingTable()
    const keys = Object.keys(table.models)
    // At least one model per major provider in v1.
    expect(keys.some((k) => k.startsWith('anthropic/'))).toBe(true)
    expect(keys.some((k) => k.startsWith('openai/'))).toBe(true)
    expect(keys.some((k) => k.startsWith('deepseek/'))).toBe(true)
    expect(keys.some((k) => k.startsWith('gemini/'))).toBe(true)
    expect(keys.some((k) => k.startsWith('kimi/'))).toBe(true)
  })
})

describe('pricingKey', () => {
  it('composes <provider>/<model_id>', () => {
    expect(pricingKey('anthropic', 'claude-opus-4-7')).toBe('anthropic/claude-opus-4-7')
  })

  it('lowercases the provider', () => {
    expect(pricingKey('Anthropic', 'claude-opus-4-7')).toBe('anthropic/claude-opus-4-7')
    expect(pricingKey('DEEPSEEK', 'deepseek-chat')).toBe('deepseek/deepseek-chat')
  })
})

describe('computeCostUsd (lookup behavior)', () => {
  const TABLE: PricingTable = PricingTableSchema.parse({
    schema_version: 1,
    as_of: '2026-04-28',
    currency: 'USD',
    models: {
      'anthropic/claude-opus-4-7': {
        input_per_mtok_usd: 15,
        output_per_mtok_usd: 75,
        cached_input_per_mtok_usd: 1.5,
      },
      'kimi/moonshot-v1-128k': {
        input_per_mtok_usd: 0.45,
        output_per_mtok_usd: 0.55,
      },
    },
  })

  it('returns null for unknown provider', () => {
    expect(
      computeCostUsd(
        { provider: 'unknown', modelId: 'whatever', inputTokens: 1000, outputTokens: 100 },
        TABLE,
      ),
    ).toBeNull()
  })

  it('returns null for unknown model under known provider', () => {
    expect(
      computeCostUsd(
        {
          provider: 'anthropic',
          modelId: 'claude-future-99',
          inputTokens: 1000,
          outputTokens: 100,
        },
        TABLE,
      ),
    ).toBeNull()
  })

  it('returns 0 when both token counts are zero (still a known model)', () => {
    expect(
      computeCostUsd(
        { provider: 'anthropic', modelId: 'claude-opus-4-7', inputTokens: 0, outputTokens: 0 },
        TABLE,
      ),
    ).toBe(0)
  })

  it('lowercases provider for lookup', () => {
    expect(
      computeCostUsd(
        { provider: 'ANTHROPIC', modelId: 'claude-opus-4-7', inputTokens: 0, outputTokens: 0 },
        TABLE,
      ),
    ).toBe(0)
  })
})

describe('computeCostUsd (math)', () => {
  const TABLE: PricingTable = PricingTableSchema.parse({
    schema_version: 1,
    as_of: '2026-04-28',
    currency: 'USD',
    models: {
      'anthropic/claude-opus-4-7': {
        input_per_mtok_usd: 15,
        output_per_mtok_usd: 75,
        cached_input_per_mtok_usd: 1.5,
      },
      'kimi/moonshot-v1-128k': {
        input_per_mtok_usd: 0.45,
        output_per_mtok_usd: 0.55,
      },
    },
  })

  it('charges input + output proportionally', () => {
    // 1M input * $15 + 1M output * $75 = 90.00
    const cost = computeCostUsd(
      {
        provider: 'anthropic',
        modelId: 'claude-opus-4-7',
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
      },
      TABLE,
    )
    expect(cost).toBeCloseTo(90, 6)
  })

  it('scales linearly with token count', () => {
    // 100K input + 10K output:
    //   100_000/1M * 15 = 1.50
    //    10_000/1M * 75 = 0.75
    //   total           = 2.25
    const cost = computeCostUsd(
      {
        provider: 'anthropic',
        modelId: 'claude-opus-4-7',
        inputTokens: 100_000,
        outputTokens: 10_000,
      },
      TABLE,
    )
    expect(cost).toBeCloseTo(2.25, 6)
  })

  it('cached tokens billed at cached_input_per_mtok_usd when set', () => {
    // Anthropic Opus: input 100K (uncached) + cached 900K + output 50K
    //   100K * $15 / 1M     = 1.5
    //   900K * $1.50 / 1M   = 1.35
    //    50K * $75 / 1M     = 3.75
    //   total                = 6.60
    const cost = computeCostUsd(
      {
        provider: 'anthropic',
        modelId: 'claude-opus-4-7',
        inputTokens: 100_000,
        cachedTokens: 900_000,
        outputTokens: 50_000,
      },
      TABLE,
    )
    expect(cost).toBeCloseTo(6.6, 6)
  })

  it('cached tokens fall through to standard input rate when cached_input_per_mtok_usd is absent', () => {
    // Kimi has no cached column; cached tokens billed at $0.45 / Mtok like uncached input.
    // 1K uncached + 1K cached + 1K output:
    //   1K * $0.45 / 1M = 0.00045  (uncached input)
    //   1K * $0.45 / 1M = 0.00045  (cached, fall-through rate)
    //   1K * $0.55 / 1M = 0.00055  (output)
    //   total            = 0.00145
    const cost = computeCostUsd(
      {
        provider: 'kimi',
        modelId: 'moonshot-v1-128k',
        inputTokens: 1_000,
        cachedTokens: 1_000,
        outputTokens: 1_000,
      },
      TABLE,
    )
    expect(cost).toBeCloseTo(0.00145, 8)
  })

  it('is monotonic: more tokens never costs less', () => {
    const small = computeCostUsd(
      {
        provider: 'anthropic',
        modelId: 'claude-opus-4-7',
        inputTokens: 1000,
        outputTokens: 100,
      },
      TABLE,
    )
    const big = computeCostUsd(
      {
        provider: 'anthropic',
        modelId: 'claude-opus-4-7',
        inputTokens: 100_000,
        outputTokens: 10_000,
      },
      TABLE,
    )
    expect(small).not.toBeNull()
    expect(big).not.toBeNull()
    expect(big!).toBeGreaterThan(small!)
  })
})

describe('PricingTableSchema validation', () => {
  it('rejects negative rates', () => {
    expect(() =>
      PricingTableSchema.parse({
        schema_version: 1,
        as_of: '2026-04-28',
        models: {
          'bad/model': {
            input_per_mtok_usd: -1,
            output_per_mtok_usd: 1,
          },
        },
      }),
    ).toThrow()
  })

  it('rejects a non-1 schema_version', () => {
    expect(() =>
      PricingTableSchema.parse({
        schema_version: 99,
        as_of: '2026-04-28',
        models: {},
      }),
    ).toThrow()
  })
})
