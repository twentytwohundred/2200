/**
 * System Update tile.
 *
 * Shows current vs. latest published version. When an update is
 * available, exposes an Upgrade button. Click → 2-step confirm
 * (inline, per [[feedback_no_browser_popups]]) → POST /system/update.
 *
 * Once the upgrade is in flight, the tile switches to a polling view
 * driven by GET /system/upgrade-status. The daemon shuts itself down
 * during the upgrade, so polling expects intermittent network errors;
 * we treat them as transient and keep polling until the daemon
 * answers again.
 *
 * Edge cases handled:
 *   - Source-checkout install: button disabled, with a note pointing
 *     at `git pull && pnpm build`.
 *   - Current version ahead of registry latest (pre-publish build):
 *     "you're on a newer version than the registry" message.
 *   - Registry error (offline, 5xx, package not yet published):
 *     surface the error + Retry button.
 *   - Upgrade failed: show error + a clear next step.
 */
import { useEffect, useRef, useState, type ReactElement } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiError, NetworkError, apiSystem, type UpgradeStatus } from '../../lib/api'
import { Card, ErrorState, KV, LoadingState, Pill, cx } from '../../primitives'
import { shouldShowUpgradeProgress } from './upgradeProgress'
import styles from './SettingsScreen.module.css'

function formatError(err: unknown): string {
  if (err instanceof ApiError) return `${err.code}: ${err.message}`
  if (err instanceof NetworkError) return 'Cannot reach the runtime.'
  return err instanceof Error ? err.message : String(err)
}

const STAGE_LABEL: Record<UpgradeStatus['stage'], string> = {
  pending: 'queued',
  stopping_daemon: 'stopping the daemon',
  installing: 'installing new version',
  restarting: 'restarting the daemon',
  completed: 'completed',
  failed: 'failed',
}

function isTerminalStage(stage: UpgradeStatus['stage']): boolean {
  return stage === 'completed' || stage === 'failed'
}

export function SystemUpdateSection(): ReactElement {
  const qc = useQueryClient()

  const versionQuery = useQuery({
    queryKey: ['system', 'version'],
    queryFn: () => apiSystem.version(),
    // Poll so a freshly-published release shows up within a minute for
    // an operator sitting on this tab (the dogfooding loop: push a
    // release, then click-update the running instance). The manual
    // "Check now" button forces an immediate read.
    refetchInterval: 60_000,
    staleTime: 30_000,
  })

  const refreshVersion = (): void => {
    void qc.invalidateQueries({ queryKey: ['system', 'version'] })
  }

  // Continuously poll upgrade-status. When stage is terminal, slow
  // the poll to nearly-never (the tile still picks up new triggers
  // because invalidating the queryKey forces a refetch). When a
  // non-terminal stage is active or we have not loaded yet, poll
  // every 2s.
  const upgradeStatusQuery = useQuery({
    queryKey: ['system', 'upgrade-status'],
    queryFn: async () => {
      try {
        return await apiSystem.upgradeStatus()
      } catch (err) {
        // The daemon is briefly down mid-upgrade. Treat as a
        // transient blip; the polling loop will recover.
        if (err instanceof NetworkError) return null
        throw err
      }
    },
    refetchInterval: (query): number | false => {
      const data = query.state.data
      const status = data?.status ?? null
      if (!status) return false
      return isTerminalStage(status.stage) ? false : 2_000
    },
    staleTime: 0,
  })

  const upgradeStatus = upgradeStatusQuery.data?.status ?? null
  const upgradeActive = upgradeStatus !== null && !isTerminalStage(upgradeStatus.stage)

  // Two-step inline confirm for the destructive Upgrade button.
  // First click arms; second click within 5s commits. Mouseout or
  // timeout reverts. Matches the provider-clear pattern.
  const [armed, setArmed] = useState(false)
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (armTimer.current) clearTimeout(armTimer.current)
    },
    [],
  )

  const update = useMutation({
    mutationFn: () => apiSystem.update(),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['system', 'upgrade-status'] })
    },
  })

  // When the upgrade transitions to completed, refresh the version
  // query so the "up to date" pill appears immediately.
  useEffect(() => {
    if (upgradeStatus?.stage === 'completed') {
      void qc.invalidateQueries({ queryKey: ['system', 'version'] })
    }
  }, [upgradeStatus?.stage, qc])

  // ------------------------------------------------------------------
  // Render branches.
  // ------------------------------------------------------------------
  if (versionQuery.isLoading) {
    return (
      <Card padding={20}>
        <LoadingState rows={2} />
      </Card>
    )
  }
  if (versionQuery.isError) {
    return (
      <Card padding={0}>
        <ErrorState title="Could not check for updates" body={formatError(versionQuery.error)} />
      </Card>
    )
  }
  const v = versionQuery.data
  if (!v) return <></>

  return (
    <Card padding={20}>
      <div className={styles.statusGrid}>
        <KV
          k="CURRENT"
          v={<span style={{ fontFamily: 'var(--ds-font-mono)' }}>{v.current}</span>}
        />
        <KV
          k="LATEST"
          v={
            v.latest ? (
              <span style={{ fontFamily: 'var(--ds-font-mono)' }}>{v.latest}</span>
            ) : (
              <span style={{ fontFamily: 'var(--ds-font-mono)' }}>—</span>
            )
          }
        />
        <KV k="STATUS" v={<StatusPill version={v} active={upgradeActive} />} />
      </div>

      {upgradeStatus &&
      shouldShowUpgradeProgress({
        hasStatus: true,
        versionStatus: v.status,
        active: upgradeActive,
      }) ? (
        <UpgradeProgress status={upgradeStatus} />
      ) : v.status === 'registry-error' ? (
        <RegistryErrorView
          message={v.registry_error ?? 'unknown'}
          onRetry={() => {
            void qc.invalidateQueries({ queryKey: ['system', 'version'] })
          }}
        />
      ) : v.status === 'ahead' ? (
        <AheadNote current={v.current} latest={v.latest ?? '?'} />
      ) : v.status === 'up-to-date' ? (
        <UpToDateNote onCheck={refreshVersion} checking={versionQuery.isFetching} />
      ) : v.install_source === 'source-checkout' ? (
        <SourceCheckoutNote />
      ) : (
        <UpgradeAction
          current={v.current}
          latest={v.latest ?? '?'}
          armed={armed}
          pending={update.isPending}
          onArm={() => {
            setArmed(true)
            if (armTimer.current) clearTimeout(armTimer.current)
            armTimer.current = setTimeout(() => {
              setArmed(false)
            }, 5000)
          }}
          onConfirm={() => {
            if (armTimer.current) {
              clearTimeout(armTimer.current)
              armTimer.current = null
            }
            setArmed(false)
            update.mutate()
          }}
          onCancelArm={() => {
            setArmed(false)
            if (armTimer.current) {
              clearTimeout(armTimer.current)
              armTimer.current = null
            }
          }}
          error={update.error}
        />
      )}
    </Card>
  )
}

function StatusPill({
  version,
  active,
}: {
  version: { status: string }
  active: boolean
}): ReactElement {
  if (active) return <Pill variant="attention">UPGRADING</Pill>
  switch (version.status) {
    case 'up-to-date':
      return <Pill variant="info">UP TO DATE</Pill>
    case 'update-available':
      return <Pill variant="attention">UPDATE AVAILABLE</Pill>
    case 'ahead':
      return <Pill variant="idle">AHEAD</Pill>
    case 'registry-error':
      return <Pill variant="error">REGISTRY ERROR</Pill>
    default:
      return <Pill variant="idle">{version.status.toUpperCase()}</Pill>
  }
}

function UpToDateNote({
  onCheck,
  checking,
}: {
  onCheck: () => void
  checking: boolean
}): ReactElement {
  return (
    <div className={styles.systemNote}>
      <div>
        You are running the latest published version. New releases appear here automatically within
        a minute.
      </div>
      <button type="button" className={styles.providerBtn} onClick={onCheck} disabled={checking}>
        {checking ? 'CHECKING…' : 'CHECK NOW'}
      </button>
    </div>
  )
}

function AheadNote({ current, latest }: { current: string; latest: string }): ReactElement {
  return (
    <div className={styles.systemNote}>
      Your install ({current}) is newer than the latest published version ({latest}). This is normal
      for a pre-publish build; nothing to do.
    </div>
  )
}

function SourceCheckoutNote(): ReactElement {
  return (
    <div className={styles.systemNote}>
      This install is a source checkout, not an npm-managed install. Upgrade by running{' '}
      <code>git pull &amp;&amp; pnpm build</code> in the repo.
    </div>
  )
}

function RegistryErrorView({
  message,
  onRetry,
}: {
  message: string
  onRetry: () => void
}): ReactElement {
  return (
    <div className={styles.systemNote}>
      <div>Could not query the npm registry: {message}</div>
      <button type="button" className={styles.providerBtn} onClick={onRetry}>
        RETRY
      </button>
    </div>
  )
}

function UpgradeAction({
  current,
  latest,
  armed,
  pending,
  onArm,
  onConfirm,
  onCancelArm,
  error,
}: {
  current: string
  latest: string
  armed: boolean
  pending: boolean
  onArm: () => void
  onConfirm: () => void
  onCancelArm: () => void
  error: unknown
}): ReactElement {
  return (
    <div className={styles.systemNote}>
      <div>
        A new version is available: <code>{current}</code> → <code>{latest}</code>. The daemon will
        stop, install the update, and restart. Your fleet state on disk is untouched.
      </div>
      <button
        type="button"
        className={cx(
          styles.providerBtn,
          armed ? styles.providerBtnDanger : styles.providerBtnPrimary,
        )}
        onClick={armed ? onConfirm : onArm}
        onMouseLeave={armed ? onCancelArm : undefined}
        disabled={pending}
      >
        {pending ? 'STARTING…' : armed ? 'CLICK TO CONFIRM' : `UPGRADE TO ${latest}`}
      </button>
      {error ? <ErrorState title="Upgrade trigger failed" body={formatError(error)} /> : null}
    </div>
  )
}

function UpgradeProgress({ status }: { status: UpgradeStatus }): ReactElement {
  const isFailed = status.stage === 'failed'
  const isDone = status.stage === 'completed'
  return (
    <div className={styles.systemNote}>
      <div>
        Upgrading <code>{status.version_from}</code> → <code>{status.version_to}</code>
      </div>
      <ol className={styles.systemStages}>
        {(['pending', 'stopping_daemon', 'installing', 'restarting'] as const).map((stage) => {
          const cur = status.stage
          const order: UpgradeStatus['stage'][] = [
            'pending',
            'stopping_daemon',
            'installing',
            'restarting',
            'completed',
          ]
          const isPast = order.indexOf(stage) < order.indexOf(cur) || isDone
          const isCurrent = stage === cur
          return (
            <li
              key={stage}
              className={cx(
                styles.systemStage,
                isPast && styles.systemStagePast,
                isCurrent && !isFailed && styles.systemStageCurrent,
                isFailed && isCurrent && styles.systemStageFailed,
              )}
            >
              {STAGE_LABEL[stage]}
            </li>
          )
        })}
      </ol>
      {isDone ? (
        <Pill variant="info">COMPLETED</Pill>
      ) : isFailed ? (
        <ErrorState
          title="Upgrade failed"
          body={status.error ?? 'See the daemon log for details.'}
        />
      ) : null}
    </div>
  )
}
