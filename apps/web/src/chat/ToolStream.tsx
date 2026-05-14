/**
 * Canonical "agent is working" surface, per design-system-v1.1
 * ds-chat.jsx ToolStream + Doug's "2200 Thinking States" doc.
 *
 * Three phases:
 *
 *   1. phase="tools"     ... chips render in sequence; current step has a
 *                            spinning ring, completed steps a green check
 *   2. phase="streaming" ... chips fade out (~320ms) and a streaming reply
 *                            takes their place, ending with a blinking caret
 *   3. phase="done"      ... fully written reply, no caret (this is the
 *                            beat right before ToolStream gets replaced by
 *                            the real ChatMessage)
 *
 * The component is stateless about which steps belong to which task; the
 * caller (AgentDetailScreen) collects tool_call_start / tool_call_end
 * events per pending task and feeds them in. When the final assistant
 * message lands we transition to phase="streaming" and let the existing
 * typewriter (streamingChars) advance through the reply body.
 */
import type { ReactElement } from 'react'
import { AgentMark } from '../primitives/AgentMark'
import { cx } from '../primitives/cx'
import styles from './ToolStream.module.css'

export interface ToolStep {
  /** Tool name verb-ish. E.g. "read", "check", "call", "draft". */
  what: string
  /** Short argument label. E.g. "supervisor.log", "spotify.api/refresh". */
  arg?: string
  /** `done` shows the green check; `active` shows the spinner. */
  state: 'active' | 'done'
}

export type ToolStreamPhase = 'tools' | 'streaming' | 'done'

export interface ToolStreamProps {
  who: string
  /** Tool steps so far, in order. */
  steps: readonly ToolStep[]
  /** Phase ... see file header. */
  phase: ToolStreamPhase
  /** The reply body. Visible in `streaming` (with caret) and `done` (no caret). */
  reply?: string
  /** Optional glyph/portrait for the avatar. */
  agentGlyph?: string | null | undefined
  agentImageUrl?: string | null | undefined
}

export function ToolStream({
  who,
  steps,
  phase,
  reply = '',
  agentGlyph,
  agentImageUrl,
}: ToolStreamProps): ReactElement {
  return (
    <article className={styles.row}>
      <AgentMark
        id={who}
        name={who}
        size="md"
        glyph={agentGlyph ?? undefined}
        imageUrl={agentImageUrl ?? undefined}
      />
      <div className={styles.col}>
        <div className={styles.name}>{who}</div>

        {phase === 'tools' && (
          <div className={styles.chips}>
            {steps.map((s, i) => (
              <ToolChip key={`${String(i)}-${s.what}-${s.arg ?? ''}`} step={s} />
            ))}
            {steps.length === 0 && <ToolChip step={{ what: 'thinking', state: 'active' }} />}
          </div>
        )}

        {phase === 'streaming' && (
          <>
            <div className={cx(styles.chips, styles.chipsFading)}>
              {steps.map((s, i) => (
                <ToolChip
                  key={`${String(i)}-${s.what}-${s.arg ?? ''}`}
                  step={{ ...s, state: 'done' }}
                />
              ))}
            </div>
            <div className={styles.bubble}>
              {reply}
              <span className={styles.caret} aria-hidden="true" />
            </div>
          </>
        )}

        {phase === 'done' && <div className={styles.bubble}>{reply}</div>}
      </div>
    </article>
  )
}

function ToolChip({ step }: { step: ToolStep }): ReactElement {
  const isDone = step.state === 'done'
  return (
    <div className={cx(styles.chip, isDone && styles.chipDone)}>
      <span className={cx(styles.glyph, isDone && styles.glyphDone)}>
        {isDone ? '✓' : <span className={styles.ring} aria-hidden="true" />}
      </span>
      <span className={styles.what}>{step.what}</span>
      {step.arg && <span className={styles.arg}>{step.arg}</span>}
    </div>
  )
}
