/**
 * First-run "what should we call you?" prompt.
 *
 * Non-interactive setup defaults the operator's name to $USER and never asks.
 * This surfaces on the Fleet landing until the operator sets their name (here
 * or in Settings → Your name), then self-dismisses. It covers fresh,
 * OpenClaw-migrated, and existing installs alike (the flag defaults false on
 * any user.md that predates it). Saving re-registers the operator in the
 * Studio under the chosen name.
 */
import { useState, type KeyboardEvent, type ReactElement } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { Button, Card, Input, Meta } from '../../primitives'
import styles from './OperatorNamePrompt.module.css'

export function OperatorNamePrompt(): ReactElement | null {
  const query = useQuery({
    queryKey: ['user'],
    queryFn: () => api.userIdentity(),
    staleTime: 10_000,
  })
  const qc = useQueryClient()
  const [name, setName] = useState('')

  const save = useMutation({
    mutationFn: (display_name: string) => api.setUserName(display_name),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['user'] })
      void qc.invalidateQueries({ queryKey: ['pub', 'studio'] })
      void qc.invalidateQueries({ queryKey: ['me'] })
    },
  })

  // Only ask once we know there's an identity the operator hasn't named yet.
  const identity = query.data?.identity
  if (!identity || identity.name_set_by_operator) return null

  const trimmed = name.trim()
  const submit = (): void => {
    if (trimmed !== '' && !save.isPending) save.mutate(trimmed)
  }
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      e.preventDefault()
      submit()
    }
  }

  return (
    <Card padding={20}>
      <div className={styles.body}>
        <Meta>welcome</Meta>
        <p className={styles.lede}>
          What should we call you? This is the name your Agents see when you chat with them in the
          Studio. You can change it later in Settings.
        </p>
        <div className={styles.row}>
          <Input
            placeholder="Your name"
            value={name}
            onChange={(e) => {
              setName(e.target.value)
            }}
            onKeyDown={onKeyDown}
            aria-label="Your name"
          />
          <Button variant="primary" disabled={trimmed === '' || save.isPending} onClick={submit}>
            Save
          </Button>
        </div>
        {save.isError ? <p className={styles.err}>Could not save ... try again.</p> : null}
      </div>
    </Card>
  )
}
