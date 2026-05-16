/**
 * Task continuation rendering.
 *
 * When the supervisor's inbound router matches an event to a task
 * parked on a `wait_for` block, it appends a markdown section to the
 * task body so the next loop iteration sees the original task + the
 * response that arrived. This module owns the rendering so every
 * inbound surface (connector, pub wake, chat) produces consistent
 * continuation prose the Agent's loop can rely on.
 *
 * Decision: [[2026-05-16-task-continuation-primitive]]
 */

export interface ContinuationSectionArgs {
  /** Where the response arrived ... pub, connector, or chat. */
  source_kind: 'pub' | 'connector' | 'chat'
  /** Human-readable sender label (display name, @username, etc). */
  sender_label: string
  /** Free-text note the Agent left when calling await_response. */
  context_note: string
  /** The response body text. May be empty for media-only events. */
  body_text: string
  /** Optional attachment lines (already formatted). */
  attachments?: string[]
  /** How the Agent should reply if they need to forward / acknowledge. */
  reply_hint: string
}

/**
 * Render the markdown section appended to a resumed task's body. The
 * section is intentionally explicit: it names the wait that just
 * resolved, restates the Agent's context_note (so they remember what
 * they were doing), and ends with a clear "what to do next" prompt.
 *
 * Format is wire-stable; downstream tests assert on the section
 * boundary `---\n## Continuation:`.
 */
export function buildContinuationSection(args: ContinuationSectionArgs): string {
  const lines: string[] = [
    '---',
    '',
    '## Continuation: response arrived',
    '',
    `**Source:** ${args.source_kind} ... from **${args.sender_label}**`,
    '',
    `**Your earlier note:** ${args.context_note}`,
    '',
    '**Their response:**',
    '',
    args.body_text || '_(empty / media-only)_',
  ]
  if (args.attachments && args.attachments.length > 0) {
    lines.push('', '**Attachments:**')
    for (const a of args.attachments) lines.push(`- ${a}`)
  }
  lines.push(
    '',
    '**What to do now:** decide whether this answers what you were waiting for. ' +
      'If yes, relay the substance back to whoever you originally promised ' +
      '(use the reply hint below). If you need a follow-up question, ask it and ' +
      'call `await_response` again. If this does not answer, decide whether to ' +
      'press, give up, or escalate.',
    '',
    args.reply_hint,
  )
  return lines.join('\n')
}

/**
 * Render the continuation appended when a wait_for times out without
 * a matching response. Different shape: there's no inbound to quote,
 * just the timeout itself. The Agent decides whether to give up,
 * retry, or report the timeout to the original requester.
 */
export function buildTimeoutContinuationSection(args: {
  context_note: string
  expected_from: string
  source_kind: 'pub' | 'connector' | 'chat'
  waited_for_seconds: number
  reply_hint: string
}): string {
  return [
    '---',
    '',
    '## Continuation: response timed out',
    '',
    `You were waiting on a ${args.source_kind} response from **${args.expected_from}**. ` +
      `No matching reply arrived within ${String(args.waited_for_seconds)} seconds.`,
    '',
    `**Your earlier note:** ${args.context_note}`,
    '',
    '**What to do now:** decide whether to give up, retry the question (call ' +
      'the appropriate `*_send` tool and `await_response` again), or report the ' +
      'timeout to whoever you originally promised so they know the chain stalled.',
    '',
    args.reply_hint,
  ].join('\n')
}
