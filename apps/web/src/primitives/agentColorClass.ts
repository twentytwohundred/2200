/**
 * Maps an agent id to a deterministic palette slot (0-11).
 *
 * The component contract calls for this exact algorithm:
 *
 *     agentColorClass(id) -> 'agent-c' + (sumOfCharCodes * 31 mod 12)
 *
 * "Mirror this in the production codebase verbatim." (See
 * wiki/design-system/component-contract.md.) Determinism matters
 * across services: a given agent must hash to the same slot
 * everywhere, in every theme, on every machine.
 *
 * Edge cases:
 * - Empty id maps to slot 0 (sum is 0).
 * - Non-ASCII code points are summed via the full code unit value
 *   (matches the reference implementation's iteration).
 */
export function agentColorClass(id: string): string {
  let sum = 0
  for (let i = 0; i < id.length; i += 1) {
    sum += id.charCodeAt(i)
  }
  return `agent-c${String((sum * 31) % 12)}`
}
