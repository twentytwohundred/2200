import type { CheckImpl } from '../types.js'

/**
 * `command_pattern`: applies only to `shell_run` per
 * [[2026-04-25-tool-baseline]]. v1 stub passes all commands; the
 * full first-time-prompt and approved-pattern register lands in a
 * follow-up PR (the Behavior dashboard surface needs UI to
 * approve/remember patterns).
 *
 * For all other tools, the check is `not_applicable`.
 */
export const commandPattern: CheckImpl = (ctx) => {
  if (ctx.tool.name !== 'shell_run') {
    return { type: 'command_pattern', result: 'not_applicable', detail: null }
  }
  // v1: trust the command. Approval-by-pattern lands when the Behavior
  // dashboard surfaces a UI to approve and remember patterns. The
  // check fires for every shell.run call so the perm record carries
  // a proof point that the command was inspected.
  return {
    type: 'command_pattern',
    result: 'pass',
    detail: ctx.shellCommand ? `command: ${truncate(ctx.shellCommand, 200)}` : null,
  }
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + '...'
}
