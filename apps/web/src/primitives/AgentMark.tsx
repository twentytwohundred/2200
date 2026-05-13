import type { ReactNode } from 'react'
import { agentColorClass } from './agentColorClass'
import { cx } from './cx'
import styles from './AgentMark.module.css'

export type AgentMarkSize = 'sm' | 'md' | 'lg' | 'xl'
export type AgentMarkState = 'speaking' | 'thinking' | null

export interface AgentMarkProps {
  /** The agent's stable identifier. Drives the deterministic color hash. */
  id: string
  /** Used for the monogram fallback and the title attribute. */
  name: string
  /** sm 18 / md 24 / lg 40 / xl 64. */
  size?: AgentMarkSize
  /** Hero treatment for identity surfaces (Onboarding, Agent identity card). */
  solid?: boolean
  /** Pub-only ring annotation. */
  state?: AgentMarkState
  /**
   * Custom glyph (emoji or 1-2 chars) the operator set on the Agent
   * Identity. When provided, renders inside the circle in place of the
   * generated initial letter. Empty/undefined falls back to the
   * monogram.
   */
  glyph?: string | null | undefined
  /**
   * URL to a portrait image the operator uploaded. When set, fills
   * the circle (object-fit: cover) and takes precedence over `glyph`.
   * Null / undefined falls back to glyph → monogram.
   */
  imageUrl?: string | null | undefined
  /** Override monogram (rare, e.g. emoji policy escapes). */
  children?: ReactNode
}

function monogram(name: string): string {
  const trimmed = name.trim()
  if (trimmed.length === 0) return '?'
  return trimmed.charAt(0).toUpperCase()
}

export function AgentMark({
  id,
  name,
  size = 'md',
  solid = false,
  state = null,
  glyph,
  imageUrl,
  children,
}: AgentMarkProps): ReactNode {
  const hasImage = imageUrl !== null && imageUrl !== undefined && imageUrl.length > 0
  const hasGlyph = glyph !== null && glyph !== undefined && glyph.length > 0
  const classes = cx(
    styles.mark,
    styles[`size-${size}`],
    agentColorClass(id),
    solid ? styles.solid : styles.outline,
    state ? styles[`state-${state}`] : undefined,
    hasGlyph && !hasImage && styles.markGlyph,
    hasImage && styles.markImage,
  )

  if (children !== undefined) {
    return (
      <span className={classes} title={name} aria-label={name}>
        {children}
      </span>
    )
  }

  if (hasImage) {
    return (
      <span className={classes} title={name} aria-label={name}>
        <img src={imageUrl} alt="" className={styles.markImg} draggable={false} />
      </span>
    )
  }

  return (
    <span className={classes} title={name} aria-label={name}>
      {hasGlyph ? glyph : monogram(name)}
    </span>
  )
}
