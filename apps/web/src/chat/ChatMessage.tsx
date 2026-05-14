import type { ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { AgentMark } from '../primitives/AgentMark'
import { cx } from '../primitives/cx'
import { Attachment, type AttachmentDisplayKind } from './Attachment'
import styles from './ChatMessage.module.css'

export interface ChatMessageAttachment {
  id: string
  kind: AttachmentDisplayKind
  name: string
  size?: number | string
  src?: string
}

export interface ChatMessageProps {
  from: 'you' | 'agent'
  /** Agent name (used for the avatar). Ignored when from='you'. */
  who?: string
  /** Operator-set glyph (emoji) for the avatar circle. */
  agentGlyph?: string | null | undefined
  /** Operator-uploaded portrait. Authed URL — caller must pre-sign. */
  agentImageUrl?: string | null | undefined
  /** Optional pre-formatted time stamp. */
  time?: string
  /**
   * Body. Strings are rendered as Markdown (GFM-flavored). ReactNode
   * passes through as-is. `**bold**`, lists, inline `code`, fences,
   * and tables all render. Raw HTML is stripped by react-markdown's
   * default policy.
   */
  body?: ReactNode
  attachments?: ChatMessageAttachment[]
  /** Placeholder bubble while the agent computes a reply. */
  thinking?: boolean
  /** When true, append a blinking cursor to the body (used while streaming). */
  streamingCursor?: boolean
}

/**
 * One bubble in a chat thread. The agent's mark sits on the left;
 * the user's mark on the right. `thinking` replaces the body with a
 * blinking-dot placeholder until the reply lands.
 */
export function ChatMessage({
  from,
  who = 'agent',
  agentGlyph,
  agentImageUrl,
  time,
  body,
  attachments = [],
  thinking = false,
  streamingCursor = false,
}: ChatMessageProps): ReactNode {
  const isYou = from === 'you'
  const bodyContent = typeof body === 'string' ? <Markdown text={body} /> : body
  return (
    <article className={cx(styles.row, isYou && styles.rowYou)}>
      {isYou ? (
        <span className={styles.youMark}>you</span>
      ) : (
        <AgentMark
          id={who}
          name={who}
          size="md"
          glyph={agentGlyph ?? undefined}
          imageUrl={agentImageUrl ?? undefined}
        />
      )}
      <div className={cx(styles.column, isYou && styles.columnYou)}>
        <div className={cx(styles.head, isYou && styles.headYou)}>
          <span className={styles.name}>{isYou ? 'you' : who}</span>
          {time !== undefined && <span className={styles.time}>{time}</span>}
        </div>
        {(body !== undefined || thinking) && (
          <div className={cx(styles.bubble, isYou ? styles.bubbleYou : styles.bubbleAgent)}>
            {thinking ? (
              <ThinkingDots />
            ) : (
              <>
                {bodyContent}
                {streamingCursor && <span className={styles.cursor} aria-hidden="true" />}
              </>
            )}
          </div>
        )}
        {attachments.length > 0 && (
          <div className={cx(styles.atts, isYou && styles.attsYou)}>
            {attachments.map((a) => (
              <Attachment
                key={a.id}
                kind={a.kind}
                name={a.name}
                {...(a.size !== undefined ? { size: a.size } : {})}
                {...(a.src !== undefined ? { src: a.src } : {})}
              />
            ))}
          </div>
        )}
      </div>
    </article>
  )
}

function Markdown({ text }: { text: string }): ReactNode {
  return (
    <div className={styles.markdown}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  )
}

function ThinkingDots(): ReactNode {
  return (
    <span className={styles.thinking}>
      <span className={styles.dot} />
      <span className={styles.dot} />
      <span className={styles.dot} />
      <span className={styles.thinkingLabel}>thinking…</span>
    </span>
  )
}
