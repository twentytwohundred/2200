/**
 * Agent identity editor.
 *
 * Loads `<home>/agents/<name>/identity.md` via `GET
 * /api/v1/agents/:name/identity`, lets the operator edit the markdown
 * inline, and saves via PUT. Saves are atomic on the runtime side; a
 * restart of the Agent is required before the new prompt takes effect
 * (the server marks `restart_required: true` in the response).
 */
import { useEffect, useState, type ReactElement } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiError, NetworkError, api } from '../../lib/api'
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

  const query = useQuery({
    queryKey: ['identity', agentName],
    queryFn: () => api.identityRead(agentName),
    staleTime: 30_000,
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
    </div>
  )
}
