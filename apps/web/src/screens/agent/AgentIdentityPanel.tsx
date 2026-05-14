/**
 * Agent identity editor.
 *
 * Loads `<home>/agents/<name>/identity.md` via `GET
 * /api/v1/agents/:name/identity`, lets the operator edit the markdown
 * inline, and saves via PUT. Saves are atomic on the runtime side; a
 * restart of the Agent is required before the new prompt takes effect
 * (the server marks `restart_required: true` in the response).
 */
import { useEffect, useRef, useState, type ReactElement } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiError, NetworkError, api, type Agent } from '../../lib/api'
import { Button, Card, ErrorState, LoadingState, Meta, SectionHeader } from '../../primitives'
import { AvatarEditor } from './AvatarEditor'
import styles from './AgentIdentityPanel.module.css'

function formatError(err: unknown): string {
  if (err instanceof ApiError) return `${err.code}: ${err.message}`
  if (err instanceof NetworkError) return 'Cannot reach the runtime.'
  return err instanceof Error ? err.message : String(err)
}

export interface AgentIdentityPanelProps {
  agentName: string
}

export function AgentIdentityPanel({ agentName }: AgentIdentityPanelProps): ReactElement {
  const queryClient = useQueryClient()
  const navigate = useNavigate()

  const query = useQuery({
    queryKey: ['identity', agentName],
    queryFn: () => api.identityRead(agentName),
    staleTime: 30_000,
  })
  const agentQuery = useQuery({
    queryKey: ['agents', agentName],
    queryFn: () => api.agent(agentName),
    staleTime: 5_000,
  })

  const [draft, setDraft] = useState<string>('')
  const [dirty, setDirty] = useState(false)
  const [restartRequired, setRestartRequired] = useState(false)

  useEffect(() => {
    if (query.data && !dirty) {
      setDraft(query.data.content)
    }
  }, [query.data, dirty])

  const save = useMutation({
    mutationFn: (content: string) => api.identityWrite(agentName, content),
    onSuccess: (res) => {
      setDirty(false)
      setRestartRequired(res.restart_required)
      void queryClient.invalidateQueries({ queryKey: ['identity', agentName] })
    },
  })

  const archiveMutation = useMutation({
    mutationFn: (reason: string | undefined) => api.agentArchive(agentName, reason),
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: ['agents'] })
      void queryClient.invalidateQueries({ queryKey: ['agents', agentName] })
      // Navigate to the renamed agent's detail screen so the operator
      // lands on a coherent URL (the old `agentName` path now 404s).
      void navigate(`/agent/${encodeURIComponent(res.name)}?tab=identity`)
    },
  })
  const unarchiveMutation = useMutation({
    mutationFn: (renameTo: string | undefined) => api.agentUnarchive(agentName, renameTo),
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: ['agents'] })
      void queryClient.invalidateQueries({ queryKey: ['agents', agentName] })
      void navigate(`/agent/${encodeURIComponent(res.name)}?tab=identity`)
    },
  })

  if (query.isLoading) {
    return (
      <div className={styles.panel}>
        <Card padding={20}>
          <LoadingState rows={6} />
        </Card>
      </div>
    )
  }

  if (query.isError) {
    return (
      <div className={styles.panel}>
        <Card padding={0}>
          <ErrorState title="Could not load identity" body={formatError(query.error)} />
        </Card>
      </div>
    )
  }

  return (
    <div className={styles.panel}>
      <section className={styles.avatarSection}>
        <SectionHeader title="AVATAR" />
        <AvatarEditor agentName={agentName} />
      </section>

      <div className={styles.header}>
        <Meta>identity · {query.data?.path}</Meta>
        <div className={styles.actions}>
          {restartRequired && <span className={styles.warn}>restart required</span>}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              if (query.data) {
                setDraft(query.data.content)
                setDirty(false)
              }
            }}
            disabled={!dirty || save.isPending}
          >
            Revert
          </Button>
          <Button
            size="sm"
            variant="primary"
            onClick={() => {
              save.mutate(draft)
            }}
            disabled={!dirty || save.isPending}
          >
            {save.isPending ? 'Saving…' : 'Save identity'}
          </Button>
        </div>
      </div>

      <textarea
        className={styles.editor}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value)
          setDirty(true)
          setRestartRequired(false)
        }}
        spellCheck={false}
      />

      {save.isError && <p className={styles.error}>{formatError(save.error)}</p>}

      <ArchiveSection
        agent={agentQuery.data ?? null}
        archiving={archiveMutation.isPending}
        unarchiving={unarchiveMutation.isPending}
        onArchive={(reason) => {
          archiveMutation.mutate(reason)
        }}
        onUnarchive={(renameTo) => {
          unarchiveMutation.mutate(renameTo)
        }}
        archiveError={archiveMutation.error}
        unarchiveError={unarchiveMutation.error}
      />
    </div>
  )
}

interface ArchiveSectionProps {
  agent: Agent | null
  archiving: boolean
  unarchiving: boolean
  onArchive: (reason: string | undefined) => void
  onUnarchive: (renameTo: string | undefined) => void
  archiveError: unknown
  unarchiveError: unknown
}

/**
 * Archive panel below the identity editor. Two states:
 *  - live agent: two-step "Archive" with optional reason
 *  - archived agent: "Restore" with optional rename_to (defaults to
 *    the pre-archive name; required when the original is now in use,
 *    surfaced as a 409 from the runtime which we render inline).
 */
function ArchiveSection({
  agent,
  archiving,
  unarchiving,
  onArchive,
  onUnarchive,
  archiveError,
  unarchiveError,
}: ArchiveSectionProps): ReactElement {
  const [armed, setArmed] = useState(false)
  const armTimerRef = useRef<number | null>(null)
  const [reason, setReason] = useState('')
  const [renameTo, setRenameTo] = useState('')

  useEffect(() => {
    return () => {
      if (armTimerRef.current !== null) window.clearTimeout(armTimerRef.current)
    }
  }, [])

  if (!agent) return <span />

  const isArchived = agent.status === 'archived'
  const archivedAt = agent.archived?.at ?? null
  const archivedReason = agent.archived?.reason ?? null

  const arm = (): void => {
    setArmed(true)
    if (armTimerRef.current !== null) window.clearTimeout(armTimerRef.current)
    armTimerRef.current = window.setTimeout(() => {
      setArmed(false)
    }, 4000)
  }

  if (isArchived) {
    return (
      <section className={styles.archiveSection}>
        <SectionHeader title="ARCHIVED" />
        <Card padding={16}>
          <div className={styles.archiveMeta}>
            {archivedAt && (
              <Meta>
                archived {new Date(archivedAt).toLocaleString()}{' '}
                {archivedReason && <>· {archivedReason}</>}
              </Meta>
            )}
          </div>
          <div className={styles.archiveActions}>
            <input
              type="text"
              className={styles.archiveInput}
              placeholder="rename to (optional)"
              value={renameTo}
              onChange={(e) => {
                setRenameTo(e.target.value.trim())
              }}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              disabled={unarchiving}
            />
            <Button
              size="sm"
              variant="primary"
              onClick={() => {
                onUnarchive(renameTo.length > 0 ? renameTo : undefined)
              }}
              disabled={unarchiving}
            >
              {unarchiving ? 'Restoring…' : 'Restore Agent'}
            </Button>
          </div>
          {unarchiveError !== undefined && unarchiveError !== null ? (
            <p className={styles.error}>{formatError(unarchiveError)}</p>
          ) : null}
        </Card>
      </section>
    )
  }

  return (
    <section className={styles.archiveSection}>
      <SectionHeader title="ARCHIVE" />
      <Card padding={16}>
        <Meta>
          archive freezes the Agent and renames its directory so the original name is free for a new
          Agent. brain, chats, identity all move with the rename.
        </Meta>
        <div className={styles.archiveActions}>
          <input
            type="text"
            className={styles.archiveInput}
            placeholder="reason (optional)"
            value={reason}
            onChange={(e) => {
              setReason(e.target.value)
            }}
            spellCheck={false}
            disabled={archiving}
          />
          {!armed ? (
            <Button size="sm" variant="ghost" onClick={arm} disabled={archiving}>
              Archive…
            </Button>
          ) : (
            <Button
              size="sm"
              variant="destructive"
              onClick={() => {
                setArmed(false)
                if (armTimerRef.current !== null) window.clearTimeout(armTimerRef.current)
                onArchive(reason.trim().length > 0 ? reason.trim() : undefined)
              }}
              disabled={archiving}
            >
              {archiving ? 'Archiving…' : 'Click to confirm'}
            </Button>
          )}
        </div>
        {archiveError !== undefined && archiveError !== null ? (
          <p className={styles.error}>{formatError(archiveError)}</p>
        ) : null}
      </Card>
    </section>
  )
}
