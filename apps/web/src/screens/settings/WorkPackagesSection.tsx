/**
 * Work-package approval tile (PR 5).
 *
 * Operator surface for the inert proposals MCP connector callers
 * (Grok) handed into the fleet. The Settings page renders this
 * tile below the MCP Connector tile; the inert package lifecycle
 * lives in the shared brain and the CLI verbs
 * `2200 connector work-package approve | reject` drive the same
 * RPCs as the approve / reject buttons here.
 *
 * Phase 1 framing: every proposal is read-only material UNTIL the
 * operator clicks Approve. Approval submits the parsed `## Plan`
 * steps as normal Agent tasks via the existing task-submit substrate;
 * no execution tools are reachable from a coordination task itself.
 */
import { useState, type ReactElement } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiConnectorWorkPackages, ApiError, NetworkError } from '../../lib/api'
import type { WorkPackageStatus, WorkPackageSummary } from '../../lib/api'
import { Card } from '../../primitives'
import styles from './WorkPackagesSection.module.css'

function formatError(err: unknown): string {
  if (err instanceof ApiError) return `${err.code}: ${err.message}`
  if (err instanceof NetworkError) return 'Cannot reach the runtime.'
  return err instanceof Error ? err.message : String(err)
}

function statusLabel(status: WorkPackageStatus): string {
  switch (status) {
    case 'proposed':
      return 'Coordinating (plan pending)'
    case 'reviewable':
      return 'Awaiting your review'
    case 'approved':
      return 'Approved'
    case 'rejected':
      return 'Rejected'
  }
}

function statusClassName(status: WorkPackageStatus): string {
  switch (status) {
    case 'reviewable':
      return styles.statusAttention ?? ''
    case 'approved':
      return styles.statusApproved ?? ''
    case 'rejected':
      return styles.statusRejected ?? ''
    default:
      return styles.statusPending ?? ''
  }
}

export function WorkPackagesSection(): ReactElement {
  const queryClient = useQueryClient()
  const [filter, setFilter] = useState<'reviewable' | 'all'>('reviewable')
  const listQuery = useQuery({
    queryKey: ['connector', 'work-packages', filter],
    queryFn: () =>
      apiConnectorWorkPackages.list(filter === 'reviewable' ? 'reviewable' : undefined),
    staleTime: 10_000,
    refetchInterval: 15_000,
  })

  const packages = listQuery.data?.items ?? []

  return (
    <Card padding={0}>
      <div className={styles.tile}>
        <div className={styles.header}>
          <h2 className={styles.title}>Work packages</h2>
          <p className={styles.subtitle}>
            Proposals handed into the fleet via the MCP connector. Each package sits inert until you
            approve or reject. Approval routes the planned steps to the primary Agent as normal
            tasks; rejection records the decision in the shared brain for the project record.
          </p>
        </div>

        <div className={styles.filterRow}>
          <button
            type="button"
            className={`${styles.filterButton ?? ''} ${filter === 'reviewable' ? (styles.filterActive ?? '') : ''}`}
            onClick={() => {
              setFilter('reviewable')
            }}
          >
            Awaiting review
          </button>
          <button
            type="button"
            className={`${styles.filterButton ?? ''} ${filter === 'all' ? (styles.filterActive ?? '') : ''}`}
            onClick={() => {
              setFilter('all')
            }}
          >
            All packages
          </button>
        </div>

        {listQuery.isLoading && <p className={styles.muted}>Loading...</p>}
        {listQuery.error && (
          <div className={styles.errorBlock}>List fetch failed: {formatError(listQuery.error)}</div>
        )}

        {packages.length === 0 && !listQuery.isLoading && !listQuery.error && (
          <p className={styles.muted}>
            {filter === 'reviewable'
              ? 'No work packages awaiting your review.'
              : 'No work packages have been proposed yet.'}
          </p>
        )}

        <div className={styles.list}>
          {packages.map((pkg) => (
            <WorkPackageCard
              key={pkg.packageId}
              pkg={pkg}
              onMutated={() => {
                void queryClient.invalidateQueries({ queryKey: ['connector', 'work-packages'] })
              }}
            />
          ))}
        </div>
      </div>
    </Card>
  )
}

interface WorkPackageCardProps {
  pkg: WorkPackageSummary
  onMutated: () => void
}

function WorkPackageCard({ pkg, onMutated }: WorkPackageCardProps): ReactElement {
  const [pendingConfirm, setPendingConfirm] = useState<'approve' | 'reject' | null>(null)
  const [rejectReason, setRejectReason] = useState<string>('')

  const approve = useMutation({
    mutationFn: () => apiConnectorWorkPackages.approve(pkg.packageId),
    onSuccess: () => {
      setPendingConfirm(null)
      onMutated()
    },
  })

  const reject = useMutation({
    mutationFn: (reason: string) =>
      apiConnectorWorkPackages.reject(pkg.packageId, reason.length > 0 ? reason : undefined),
    onSuccess: () => {
      setPendingConfirm(null)
      setRejectReason('')
      onMutated()
    },
  })

  const planSection = extractSection(pkg.body, 'Plan')
  const risksSection = extractSection(pkg.body, 'Risks')
  const successCriteriaSection = extractSection(pkg.body, 'Success criteria')
  const summarySection = extractSection(pkg.body, 'Summary')

  return (
    <article className={styles.card}>
      <div className={styles.cardHead}>
        <div className={styles.cardTitleRow}>
          <h3 className={styles.cardTitle}>{pkg.title}</h3>
          <span className={`${styles.statusPill ?? ''} ${statusClassName(pkg.status)}`}>
            {statusLabel(pkg.status)}
          </span>
        </div>
        <div className={styles.cardMeta}>
          <span>
            target: <code>{pkg.targetKind}</code> <code>{pkg.targetName}</code>
          </span>
          <span>
            primary: <code>{pkg.primaryAgent}</code>
          </span>
          <span>proposed: {new Date(pkg.createdAt).toLocaleString()}</span>
          <code className={styles.packageId}>{pkg.packageId}</code>
        </div>
      </div>

      {summarySection && (
        <div className={styles.section}>
          <Meta>Summary</Meta>
          <div className={styles.sectionBody}>{summarySection}</div>
        </div>
      )}

      {pkg.status === 'proposed' && (
        <div className={styles.muted}>
          The coordination task is in flight. The plan will appear here when the primary Agent
          finishes assembling it (the page polls automatically).
        </div>
      )}

      {planSection && (
        <div className={styles.section}>
          <Meta>Plan</Meta>
          <pre className={styles.preBody}>{planSection}</pre>
        </div>
      )}

      {risksSection && (
        <div className={styles.section}>
          <Meta>Risks</Meta>
          <pre className={styles.preBody}>{risksSection}</pre>
        </div>
      )}

      {successCriteriaSection && (
        <div className={styles.section}>
          <Meta>Success criteria</Meta>
          <pre className={styles.preBody}>{successCriteriaSection}</pre>
        </div>
      )}

      {pkg.status === 'reviewable' && pendingConfirm === null && (
        <div className={styles.buttons}>
          <button
            type="button"
            className={styles.primaryButton}
            onClick={() => {
              setPendingConfirm('approve')
            }}
          >
            Approve
          </button>
          <button
            type="button"
            className={styles.tertiaryButton}
            onClick={() => {
              setPendingConfirm('reject')
            }}
          >
            Reject
          </button>
        </div>
      )}

      {pendingConfirm === 'approve' && (
        <div className={styles.confirmBlock}>
          <div>
            <strong>Approve this work package?</strong> Each plan step becomes a normal Agent task
            for <code>{pkg.primaryAgent}</code> via the standard task-submit substrate. Execution
            tools are now reachable for these tasks (this is the gate the connector relies on).
          </div>
          <div className={styles.buttons}>
            <button
              type="button"
              className={styles.primaryButton}
              onClick={() => {
                approve.mutate()
              }}
              disabled={approve.isPending}
            >
              {approve.isPending ? 'Approving...' : 'Yes, approve'}
            </button>
            <button
              type="button"
              className={styles.tertiaryButton}
              onClick={() => {
                setPendingConfirm(null)
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {pendingConfirm === 'reject' && (
        <div className={styles.confirmBlock}>
          <div>
            <strong>Reject this work package?</strong> The proposal stays in the shared brain for
            the record. Optionally include a short reason.
          </div>
          <textarea
            className={styles.reasonInput}
            placeholder="Reason (optional)..."
            value={rejectReason}
            onChange={(e) => {
              setRejectReason(e.target.value)
            }}
            rows={2}
          />
          <div className={styles.buttons}>
            <button
              type="button"
              className={styles.dangerButton}
              onClick={() => {
                reject.mutate(rejectReason.trim())
              }}
              disabled={reject.isPending}
            >
              {reject.isPending ? 'Rejecting...' : 'Yes, reject'}
            </button>
            <button
              type="button"
              className={styles.tertiaryButton}
              onClick={() => {
                setPendingConfirm(null)
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {pkg.status === 'approved' && pkg.approvedAt && (
        <div className={styles.approvedBlock}>
          Approved {new Date(pkg.approvedAt).toLocaleString()}.{' '}
          {pkg.approvedFollowOnTaskIds.length === 1
            ? '1 task'
            : `${String(pkg.approvedFollowOnTaskIds.length)} tasks`}{' '}
          dispatched to <code>{pkg.primaryAgent}</code>.
        </div>
      )}

      {pkg.status === 'rejected' && pkg.rejectedAt && (
        <div className={styles.rejectedBlock}>
          Rejected {new Date(pkg.rejectedAt).toLocaleString()}
          {pkg.rejectionReason !== null && pkg.rejectionReason.length > 0
            ? `: ${pkg.rejectionReason}`
            : '.'}
        </div>
      )}

      {(approve.error ?? reject.error) && (
        <div className={styles.errorBlock}>{formatError(approve.error ?? reject.error)}</div>
      )}
    </article>
  )
}

function Meta({ children }: { children: ReactElement | string }): ReactElement {
  return <div className={styles.meta}>{children}</div>
}

/**
 * Extract the body of a `## <heading>` section from the package
 * note. Returns null if the heading is missing or the body is just
 * a `_(pending)_` placeholder.
 */
function extractSection(body: string, heading: string): string | null {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`^##\\s+${escaped}\\s*$([\\s\\S]*?)(?=^##\\s+|$(?![\\s\\S]))`, 'mi')
  const match = re.exec(body)
  if (match?.[1] === undefined) return null
  const text = match[1].trim()
  if (text.length === 0) return null
  if (/^_\(pending\b/.test(text)) return null
  return text
}
