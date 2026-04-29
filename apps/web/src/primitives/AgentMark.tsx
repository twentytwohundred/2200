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
  children,
}: AgentMarkProps): ReactNode {
  const classes = cx(
    styles.mark,
    styles[`size-${size}`],
    agentColorClass(id),
    solid ? styles.solid : styles.outline,
    state ? styles[`state-${state}`] : undefined,
  )

  return (
    <span className={classes} title={name} aria-label={name}>
      {children ?? monogram(name)}
    </span>
  )
}
