/**
 * Settings -> Doctor.
 *
 * Substrate self-healing surface. Polls /api/v1/doctor/diagnose every
 * 10s and renders each issue as a row with severity, description, and
 * a per-issue Fix button when the runtime declares one available.
 * Read-only on issues without fixes (operator escalation).
 *
 * v1 issue kinds (server side, kept in sync there):
 *   - agent_errored_recoverable  (fix: restart the Agent)
 *   - agent_errored_unknown      (report only; operator triages)
 *   - connector_gateway_missing  (fix: spawn the gateway)
 *   - pending_credential_orphaned (fix: expire the request)
 *
 * Decision context: 2026-05-16 evening Doctor add ... self-healing as
 * a first-class UI surface so the operator doesn't need to read the
 * supervisor log to know "what is currently wedged."
 */
import { useState, type ReactElement } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiError, NetworkError, apiDoctor, type DoctorIssue } from '../../lib/api'
import { Button, Card, ErrorState, LoadingState, Pill } from '../../primitives'

function formatError(err: unknown): string {
  if (err instanceof ApiError) return `${err.code}: ${err.message}`
  if (err instanceof NetworkError) return 'Cannot reach the runtime.'
  return err instanceof Error ? err.message : String(err)
}

function severityVariant(severity: DoctorIssue['severity']): 'info' | 'attention' | 'error' {
  if (severity === 'info') return 'info'
  if (severity === 'warn') return 'attention'
  return 'error'
}

export function DoctorSection(): ReactElement {
  const qc = useQueryClient()
  const [lastFix, setLastFix] = useState<{ id: string; message: string; ok: boolean } | null>(null)

  const diagnoseQuery = useQuery({
    queryKey: ['doctor', 'diagnose'],
    queryFn: () => apiDoctor.diagnose(),
    refetchInterval: 10_000,
  })

  const fixMutation = useMutation({
    mutationFn: (id: string) => apiDoctor.fix(id),
    onSuccess: (result, id) => {
      setLastFix({ id, message: result.message, ok: result.applied })
      // Refresh diagnose so the fixed issue drops off the list (or
      // surfaces a follow-up). Also refresh fleet so the operator
      // sees the restart land.
      void qc.invalidateQueries({ queryKey: ['doctor', 'diagnose'] })
      void qc.invalidateQueries({ queryKey: ['agents'] })
    },
    onError: (err, id) => {
      setLastFix({ id, message: formatError(err), ok: false })
    },
  })

  if (diagnoseQuery.isLoading) {
    return (
      <Card padding={20}>
        <LoadingState rows={2} />
      </Card>
    )
  }
  if (diagnoseQuery.isError) {
    return (
      <Card padding={0}>
        <ErrorState title="Doctor unavailable" body={formatError(diagnoseQuery.error)} />
      </Card>
    )
  }

  const items = diagnoseQuery.data?.items ?? []
  const generatedAt = diagnoseQuery.data?.generated_at

  if (items.length === 0) {
    return (
      <Card padding={20}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
          }}
        >
          <div>
            <strong style={{ color: 'var(--text)' }}>All clear.</strong>{' '}
            <span style={{ color: 'var(--text-2)', fontSize: 13 }}>No known issues detected.</span>
          </div>
          <Button
            variant="ghost"
            size="md"
            onClick={() => {
              void diagnoseQuery.refetch()
            }}
            disabled={diagnoseQuery.isFetching}
          >
            {diagnoseQuery.isFetching ? 'Scanning…' : 'Run sweep'}
          </Button>
        </div>
        {generatedAt && (
          <div style={{ marginTop: 6, color: 'var(--text-3)', fontSize: 11 }}>
            last sweep: {new Date(generatedAt).toLocaleTimeString()}
          </div>
        )}
      </Card>
    )
  }

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
        }}
      >
        <div style={{ color: 'var(--text-2)', fontSize: 13 }}>
          {String(items.length)} issue{items.length === 1 ? '' : 's'} detected
        </div>
        <Button
          variant="ghost"
          size="md"
          onClick={() => {
            void diagnoseQuery.refetch()
          }}
          disabled={diagnoseQuery.isFetching}
        >
          {diagnoseQuery.isFetching ? 'Scanning…' : 'Run sweep'}
        </Button>
      </div>
      {items.map((issue) => (
        <IssueRow
          key={issue.id}
          issue={issue}
          isFixing={fixMutation.isPending && fixMutation.variables === issue.id}
          onFix={() => {
            fixMutation.mutate(issue.id)
          }}
          lastFix={lastFix?.id === issue.id ? lastFix : null}
        />
      ))}
      {generatedAt && (
        <div style={{ color: 'var(--text-3)', fontSize: 11 }}>
          last sweep: {new Date(generatedAt).toLocaleTimeString()}
        </div>
      )}
    </div>
  )
}

interface IssueRowProps {
  issue: DoctorIssue
  isFixing: boolean
  onFix: () => void
  lastFix: { message: string; ok: boolean } | null
}

function IssueRow({ issue, isFixing, onFix, lastFix }: IssueRowProps): ReactElement {
  return (
    <Card padding={16}>
      <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
        <div>
          <Pill variant={severityVariant(issue.severity)} size="sm">
            {issue.severity}
          </Pill>
        </div>
        <div style={{ flex: 1, display: 'grid', gap: 6 }}>
          <div style={{ fontWeight: 600, color: 'var(--text)' }}>{issue.title}</div>
          <div style={{ color: 'var(--text-2)', fontSize: 13, lineHeight: 1.55 }}>
            {issue.description}
          </div>
          <div
            style={{
              color: 'var(--text-3)',
              fontSize: 10,
              fontFamily: 'JetBrains Mono, ui-monospace, monospace',
              letterSpacing: '0.04em',
            }}
          >
            {issue.kind}
          </div>
          {lastFix && (
            <div
              style={{
                marginTop: 6,
                padding: '8px 10px',
                background: lastFix.ok ? 'var(--bg-sunk)' : 'var(--danger-soft)',
                border: `1px solid ${lastFix.ok ? 'var(--line)' : 'var(--danger)'}`,
                borderRadius: 6,
                color: 'var(--text)',
                fontSize: 12,
              }}
            >
              {lastFix.ok ? '✓ ' : '✗ '}
              {lastFix.message}
            </div>
          )}
        </div>
        {issue.fix_available && (
          <div>
            <Button variant="primary" size="md" onClick={onFix} disabled={isFixing}>
              {isFixing ? 'Fixing…' : (issue.fix_label ?? 'Fix it')}
            </Button>
          </div>
        )}
      </div>
    </Card>
  )
}
