/**
 * Operator identity ... your name.
 *
 * The name other Agents see when you chat in the Studio. Non-interactive
 * setup defaults it to your OS user; this is where you set it to whatever you
 * want, and change it later. Saving re-registers you in the Studio under the
 * new name (the prior registration is left inert and hidden by the member
 * view), so the change shows up right away.
 */
import { useState, type ReactElement } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiError, NetworkError, api, type UserIdentityResponse } from '../../lib/api'
import { Button, Card, ErrorState, Input, LoadingState, SectionHeader } from '../../primitives'
import styles from './IdentitySection.module.css'

function formatError(err: unknown): string {
  if (err instanceof ApiError) return `${err.code}: ${err.message}`
  if (err instanceof NetworkError) return 'Cannot reach the runtime.'
  return err instanceof Error ? err.message : String(err)
}

export function IdentitySection(): ReactElement {
  const query = useQuery({
    queryKey: ['user'],
    queryFn: () => api.userIdentity(),
    staleTime: 10_000,
  })
  if (query.isLoading) {
    return (
      <Card padding={20}>
        <LoadingState rows={2} />
      </Card>
    )
  }
  if (query.isError) {
    return (
      <Card padding={0}>
        <ErrorState title="Could not load your identity" body={formatError(query.error)} />
      </Card>
    )
  }
  const data = query.data
  if (!data) return <></>
  return <IdentityCard data={data} />
}

function IdentityCard({ data }: { data: UserIdentityResponse }): ReactElement {
  const qc = useQueryClient()
  const current = data.identity?.display_name ?? ''
  const [name, setName] = useState(current)

  const save = useMutation({
    mutationFn: (display_name: string) => api.setUserName(display_name),
    onSuccess: () => {
      // The name shows in the Studio member rail (pub) and the "me" principal.
      void qc.invalidateQueries({ queryKey: ['user'] })
      void qc.invalidateQueries({ queryKey: ['pub', 'studio'] })
      void qc.invalidateQueries({ queryKey: ['me'] })
    },
  })

  const trimmed = name.trim()
  const unchanged = trimmed === current
  const defaulted = data.identity !== null && !data.identity.name_set_by_operator

  return (
    <section>
      <SectionHeader title="YOUR NAME" />
      <Card padding={20}>
        <div className={styles.body}>
          <p className={styles.note}>
            The name other Agents see when you chat in the Studio.
            {defaulted ? (
              <>
                {' '}
                Right now it's a default (<code>{current}</code>) ... set it to whatever you like.
              </>
            ) : null}
          </p>
          <div className={styles.row}>
            <Input
              placeholder="Your name"
              value={name}
              onChange={(e) => {
                setName(e.target.value)
              }}
              aria-label="Your display name"
            />
            <Button
              variant="primary"
              disabled={trimmed === '' || unchanged || save.isPending}
              onClick={() => {
                save.mutate(trimmed)
              }}
            >
              Save
            </Button>
          </div>
          {save.isError ? <ErrorState title="Save failed" body={formatError(save.error)} /> : null}
          {save.isSuccess ? (
            <div className={styles.saved}>Saved. You'll show as this in the Studio.</div>
          ) : null}
        </div>
      </Card>
    </section>
  )
}
