/**
 * Persistent chat with one Agent.
 *
 * The transcript is the source of truth on the runtime side
 * (`<home>/agents/<name>/chat.jsonl`). Each user POST to /chat appends
 * a user-role message and spawns a checkpointed task whose body
 * carries the recent transcript + new turn as context. When the task
 * reaches a terminal state, the daemon appends the assistant reply
 * back into the chat log. This screen polls the chat list every 3s
 * and also invalidates on every WS pulse.changed event for the agent
 * so live transitions surface fast.
 */
import { useEffect, useRef, useState, type FormEvent, type ReactElement } from 'react'
import { useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiError, NetworkError, api, type ChatMessage } from '../../lib/api'
import {
  Button,
  Card,
  cx,
  ErrorState,
  LoadingState,
  PulseDot,
  Screen,
  ScreenNavLink,
} from '../../primitives'
import styles from './ChatScreen.module.css'

function formatTime(value: string): string {
  try {
    return new Date(value).toISOString().slice(11, 16) + ' UTC'
  } catch {
    return value
  }
}

function formatError(err: unknown): string {
  if (err instanceof ApiError) return `${err.code}: ${err.message}`
  if (err instanceof NetworkError) return 'Cannot reach the runtime.'
  return err instanceof Error ? err.message : String(err)
}

export function ChatScreen(): ReactElement {
  const { name } = useParams<{ name: string }>()
  const queryClient = useQueryClient()
  const [draft, setDraft] = useState('')
  const [pendingTaskId, setPendingTaskId] = useState<string | null>(null)
  const transcriptRef = useRef<HTMLDivElement | null>(null)

  const query = useQuery({
    queryKey: ['chat', name],
    queryFn: () => {
      if (!name) throw new Error('agent name missing from route')
      return api.chatList(name)
    },
    enabled: Boolean(name),
    staleTime: 1_000,
    refetchInterval: 3_000,
  })

  // Live pulse for the agent: drives the header indicator and the
  // "thinking…" affordance. Polls faster than the chat list so the
  // dot tracks short bursts of activity.
  const agentQuery = useQuery({
    queryKey: ['agent-pulse', name],
    queryFn: () => {
      if (!name) throw new Error('agent name missing from route')
      return api.agent(name)
    },
    enabled: Boolean(name),
    staleTime: 1_000,
    refetchInterval: 2_000,
  })

  const pulse = agentQuery.data?.pulse ?? null
  const isWorking =
    pulse?.state === 'working_light' ||
    pulse?.state === 'working_medium' ||
    pulse?.state === 'working_hard'

  const messages = query.data?.items ?? []

  // Clear pendingTaskId once the assistant message for it shows up.
  useEffect(() => {
    if (!pendingTaskId) return
    const replyLanded = messages.some((m) => m.task_id === pendingTaskId && m.role === 'assistant')
    if (replyLanded) setPendingTaskId(null)
  }, [messages, pendingTaskId])

  // Autoscroll to the bottom on new messages.
  useEffect(() => {
    const el = transcriptRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages.length, pendingTaskId])

  const send = useMutation({
    mutationFn: (content: string) => {
      if (!name) throw new Error('agent name missing')
      return api.chatSend(name, content)
    },
    onSuccess: (res) => {
      setDraft('')
      setPendingTaskId(res.task_id)
      void queryClient.invalidateQueries({ queryKey: ['chat', name] })
    },
  })

  const handleSubmit = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault()
    const content = draft.trim()
    if (content.length === 0) return
    send.mutate(content)
  }

  return (
    <Screen
      crumbs={['2200', 'agent', name ?? '', 'chat']}
      title={`Chat · ${name ?? ''}`}
      lede={`Persistent conversation with ${name ?? 'the agent'}. Each turn is a checkpointed task.`}
      actions={
        <>
          {pulse ? (
            <span className={styles.pulseChip}>
              <PulseDot state={pulse.state} intensity={pulse.intensity} size="md" />
              <span>{isWorking ? 'thinking…' : pulse.state.replace('_', ' ')}</span>
            </span>
          ) : null}
          <ScreenNavLink to={`/agent/${encodeURIComponent(name ?? '')}`}>← Agent</ScreenNavLink>
        </>
      }
    >
      <div ref={transcriptRef} className={styles.transcript}>
        {query.isLoading ? (
          <LoadingState rows={4} />
        ) : query.isError ? (
          <Card padding={0}>
            <ErrorState title="Could not load chat" body={formatError(query.error)} />
          </Card>
        ) : messages.length === 0 && !pendingTaskId ? (
          <div className={styles.empty}>No messages yet. Say hi and the agent will respond.</div>
        ) : (
          messages.map((m: ChatMessage) => (
            <ChatBubble key={m.id} message={m} agentName={name ?? 'agent'} />
          ))
        )}
        {pendingTaskId || isWorking ? (
          <div className={styles.thinking}>
            <span className={styles.thinkingDot} />
            <span>{name ?? 'agent'} is thinking…</span>
          </div>
        ) : null}
      </div>

      <form onSubmit={handleSubmit} className={styles.composer}>
        <textarea
          className={styles.input}
          placeholder={`Message ${name ?? 'the agent'}...`}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value)
          }}
          onKeyDown={(e) => {
            // Shift+Enter inserts newline; Enter submits.
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              const content = draft.trim()
              if (content.length === 0 || send.isPending) return
              send.mutate(content)
            }
          }}
          disabled={send.isPending}
        />
        <Button
          type="submit"
          variant="primary"
          disabled={send.isPending || draft.trim().length === 0}
          kbd="↵"
        >
          {send.isPending ? 'Sending…' : 'Send'}
        </Button>
      </form>

      {send.error ? (
        <Card padding={20}>
          <ErrorState title="Could not send" body={formatError(send.error)} />
        </Card>
      ) : null}
    </Screen>
  )
}

interface ChatBubbleProps {
  message: ChatMessage
  agentName: string
}

function ChatBubble({ message, agentName }: ChatBubbleProps): ReactElement {
  const bubbleClass = cx(
    styles.bubble,
    message.role === 'user' && styles.bubbleUser,
    message.role === 'assistant' && styles.bubbleAgent,
    message.role === 'system' && styles.bubbleSystem,
  )
  // Show the Agent's actual name in place of the generic "assistant"
  // role so the user knows who is speaking. User and system stay
  // labeled by role.
  const speaker = message.role === 'assistant' ? agentName : message.role
  return (
    <div className={styles.messageRow} data-role={message.role}>
      <div>
        <div className={bubbleClass}>{message.content || '(empty response)'}</div>
        <div className={styles.meta}>
          {speaker} · {formatTime(message.ts)}
        </div>
      </div>
    </div>
  )
}
