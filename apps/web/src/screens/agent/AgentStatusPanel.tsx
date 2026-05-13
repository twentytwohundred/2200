import type { ReactElement } from 'react'
import { Link } from 'react-router-dom'
import { Card, KV, Meta, Pill, PulseDot, type PillVariant } from '../../primitives'
import type { Agent } from '../../lib/api'
import styles from './AgentStatusPanel.module.css'

function pillVariant(status: string): PillVariant {
  if (status === 'running') return 'running'
  if (status === 'waiting') return 'info'
  if (status === 'errored') return 'error'
  if (status.startsWith('blocked_')) return 'attention'
  return 'idle'
}

function pillLabel(status: string): string {
  if (status === 'blocked_on_user') return 'needs you'
  if (status === 'blocked_on_agent') return 'blocked'
  if (status === 'blocked_on_detector') return 'paused'
  return status.replace(/_/g, ' ')
}

function formatTime(value: string | null | undefined): string {
  if (value === null || value === undefined) return '—'
  try {
    const d = new Date(value)
    if (Number.isNaN(d.getTime())) return value
    return `${d.toISOString().slice(0, 19).replace('T', ' ')} UTC`
  } catch {
    return value
  }
}

function formatRelative(value: string | null | undefined): string {
  if (value === null || value === undefined) return '—'
  try {
    const d = new Date(value)
    if (Number.isNaN(d.getTime())) return value
    const diff = Date.now() - d.getTime()
    const s = Math.round(diff / 1000)
    if (s < 60) return `${String(s)}s ago`
    const m = Math.round(s / 60)
    if (m < 60) return `${String(m)}m ago`
    const h = Math.round(m / 60)
    if (h < 48) return `${String(h)}h ago`
    return formatTime(value)
  } catch {
    return value
  }
}

export interface AgentStatusPanelProps {
  agent: Agent
}

export function AgentStatusPanel({ agent }: AgentStatusPanelProps): ReactElement {
  const pulse = agent.pulse
  return (
    <div className={styles.panel}>
      <section className={styles.section}>
        <Meta>runtime</Meta>
        <Card padding={20}>
          <div className={styles.grid}>
            <KV
              k="state"
              v={<Pill variant={pillVariant(agent.status)}>{pillLabel(agent.status)}</Pill>}
            />
            <KV
              k="pid"
              v={
                <span className={styles.mono}>{agent.pid !== null ? String(agent.pid) : '—'}</span>
              }
            />
            <KV
              k="pulse"
              v={
                pulse ? (
                  <span className={styles.pulseRow}>
                    <PulseDot state={pulse.state} intensity={pulse.intensity} size="sm" />
                    <span className={styles.mono}>{pulse.state.replace('_', ' ')}</span>
                  </span>
                ) : (
                  <span className={styles.muted}>—</span>
                )
              }
            />
            <KV
              k="current task"
              v={
                agent.current_task_id !== null ? (
                  <Link
                    to={`/agent/${encodeURIComponent(agent.name)}/chat`}
                    className={styles.taskLink}
                  >
                    <code className={styles.mono}>{agent.current_task_id.slice(0, 24)}</code>
                  </Link>
                ) : (
                  <span className={styles.muted}>none</span>
                )
              }
            />
            <KV
              k="heartbeat"
              v={<span className={styles.mono}>{formatRelative(agent.last_heartbeat)}</span>}
            />
            <KV
              k="spawned"
              v={<span className={styles.mono}>{formatTime(agent.spawned_at)}</span>}
            />
          </div>
        </Card>
      </section>

      <section className={styles.section}>
        <Meta>model</Meta>
        <Card padding={20}>
          <div className={styles.grid}>
            <KV
              k="provider"
              v={<code className={styles.mono}>{agent.model?.provider ?? '—'}</code>}
            />
            <KV
              k="model id"
              v={<code className={styles.mono}>{agent.model?.model_id ?? '—'}</code>}
            />
            <KV
              k="followup"
              v={
                agent.model?.followup_model_id ? (
                  <code className={styles.mono}>{agent.model.followup_model_id}</code>
                ) : (
                  <span className={styles.muted}>same as primary</span>
                )
              }
            />
          </div>
        </Card>
      </section>

      <section className={styles.section}>
        <Meta>identity</Meta>
        <Card padding={20}>
          <KV
            k="identity path"
            v={<code className={styles.monoPath}>{agent.identity_path}</code>}
          />
        </Card>
      </section>
    </div>
  )
}
