/**
 * Maps an agent id to a deterministic palette slot (0-5).
 *
 * The v1.1 design system uses six distinct agent hues, hashed by the
 * sum of the agent name's char codes mod 6 (per
 * `wiki/design-system/tokens.json::agentHues.description`).
 *
 * The returned class is `agent-c0` ... `agent-c5`; the matching
 * class blocks in `agent-palette.css` set `--agent-color` to the
 * resolved `var(--agent-N)` for that slot, so component CSS can read
 * `var(--agent-color)` regardless of which agent is being rendered.
 *
 * Edge cases:
 * - Empty id maps to slot 0 (sum is 0).
 * - Non-ASCII code points contribute the full code unit value.
 */
export function agentColorClass(id: string): string {
  let sum = 0
  for (let i = 0; i < id.length; i += 1) {
    sum += id.charCodeAt(i)
  }
  return `agent-c${String(sum % 6)}`
}
