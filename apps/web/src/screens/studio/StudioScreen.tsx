/**
 * Studio: a multi-agent room with composer + reactions.
 *
 * Doug, Hobby, Simon, and any other pub members all in one threaded
 * view. Routing: `/studio` redirects to the install's first running
 * pub; `/studio/:pub` opens that pub specifically.
 *
 * Substrate: the supervisor's `SupervisorPubBridge` owns one
 * PubClient per pub authenticated as the local user. This screen
 * polls `/api/v1/pubs/:name/messages` (3s), and posts via
 * `/api/v1/pubs/:name/messages` and `/api/v1/pubs/:name/reactions`.
 *
 * Tagging: clicking a member chip inserts `@<display_name> ` into
 * the composer. On send we extract @-tokens from the content and
 * resolve them against the live members list to populate
 * `mentions[]` (agent_ids); the pub-server uses `mentions[]` as
 * the canonical wake-source for `@<handle>` direction.
 *
 * Reactions: each message has a small picker (✓ 👍 👀 ❤️). Clicking
 * one POSTs to /reactions; the pub-server upserts (agent_id,
 * message_id) so reacting again with the same emoji is a no-op,
 * with a different emoji replaces.
 */
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent,
  type ReactElement,
} from 'react'
import { Link, Navigate, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ApiError,
  NetworkError,
  api,
  type PubMember,
  type PubMessage,
  type PubReactionDto,
} from '../../lib/api'
import { Button, Card, ErrorState, LoadingState, PageHeader, cx } from '../../primitives'
import { ThemeSwitcher } from '../../theme/ThemeSwitcher'
import { useTheme } from '../../theme/ThemeProvider'
import { useLiveSignal } from '../../ws/useLiveSignal'
import styles from './StudioScreen.module.css'

const REACTION_OPTIONS = ['✓', '👍', '👀', '❤️'] as const

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

/**
 * Extract @<token> mentions from message content and resolve to
 * agent_ids. Lookups are case-insensitive against display_name.
 * Tokens that don't match any member are dropped silently; the pub
 * server's @<handle> fallback parser will catch them server-side if
 * they correspond to a known agent in the room.
 */
function extractMentions(content: string, members: PubMember[]): string[] {
  const tokens = content.match(/(?:^|\s)@([\w.-]+)/g) ?? []
  const ids = new Set<string>()
  for (const tok of tokens) {
    const handle = tok.trim().slice(1).toLowerCase()
    const match = members.find((m) => m.display_name.toLowerCase() === handle)
    if (match) ids.add(match.agent_id)
  }
  return Array.from(ids)
}

export function StudioScreen(): ReactElement {
  const { pub: pubParam } = useParams<{ pub?: string }>()
  const { theme } = useTheme()
  const live = useLiveSignal()

  // If no pub is specified, send the user to the first running pub.
  const pubsQuery = useQuery({
    queryKey: ['pubs'],
    queryFn: () => api.pubsList(),
    enabled: !pubParam,
    staleTime: 5_000,
  })

  if (!pubParam) {
    if (pubsQuery.isLoading) {
      return (
        <main className={styles.shell}>
          <Card padding={20}>
            <LoadingState rows={3} />
          </Card>
        </main>
      )
    }
    const first =
      pubsQuery.data?.items.find((p) => p.state === 'running') ?? pubsQuery.data?.items[0]
    if (!first) {
      return (
        <main className={styles.shell}>
          <PageHeader
            eyebrow={`2200 · STUDIO · ${theme.toUpperCase()} · WS ${live.status.toUpperCase()}`}
            title="Studio"
            subtitle="No pubs running on this install."
          />
          <div className={styles.banner}>
            Run <code>2200 pub create studio</code> and <code>2200 pub start studio</code> to bring
            up the default Studio.
          </div>
        </main>
      )
    }
    return <Navigate to={`/studio/${encodeURIComponent(first.name)}`} replace />
  }

  return <StudioPubView pubName={pubParam} />
}

interface StagedAttachment {
  filename: string
  content_type: string
  size_bytes: number
  base64: string
}

const ATTACH_MAX_BYTES = 5 * 1024 * 1024
const ATTACH_MAX_COUNT = 6

async function readFileAsAttachment(file: File): Promise<StagedAttachment> {
  const buf = await file.arrayBuffer()
  // Browser-native base64 encoding via btoa on a binary string.
  // Chunked to avoid stack overflow on large files.
  let binary = ''
  const bytes = new Uint8Array(buf)
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return {
    filename: file.name,
    content_type: file.type || 'application/octet-stream',
    size_bytes: file.size,
    base64: btoa(binary),
  }
}

function formatAttachmentSize(n: number): string {
  if (n < 1024) return `${String(n)} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

function StudioPubView({ pubName }: { pubName: string }): ReactElement {
  const { theme } = useTheme()
  const live = useLiveSignal()
  const queryClient = useQueryClient()
  const timelineRef = useRef<HTMLDivElement | null>(null)
  const composerRef = useRef<HTMLTextAreaElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [draft, setDraft] = useState('')
  const [staged, setStaged] = useState<StagedAttachment[]>([])
  const [stageError, setStageError] = useState<string | null>(null)

  const pubQuery = useQuery({
    queryKey: ['pub', pubName],
    queryFn: () => api.pub(pubName),
    staleTime: 5_000,
    refetchInterval: 8_000,
  })

  const messagesQuery = useQuery({
    queryKey: ['pub', pubName, 'messages'],
    queryFn: () => api.pubMessages(pubName, { limit: 100 }),
    refetchInterval: 3_000,
    staleTime: 1_000,
  })

  const messages = useMemo(() => messagesQuery.data?.items ?? [], [messagesQuery.data])
  const members = pubQuery.data?.members ?? []

  // Track the last-sent content so we can restore the draft on
  // failure without clobbering anything the user may have typed
  // since.
  const lastSentContentRef = useRef<string>('')

  const sendMutation = useMutation({
    mutationFn: (input: { content: string; attachments: StagedAttachment[] }) => {
      const mentions = extractMentions(input.content, members)
      return api.pubSend(pubName, {
        content: input.content,
        ...(mentions.length > 0 ? { mentions } : {}),
        ...(input.attachments.length > 0
          ? {
              attachments: input.attachments.map((a) => ({
                filename: a.filename,
                content_type: a.content_type,
                base64: a.base64,
              })),
            }
          : {}),
      })
    },
    onSuccess: () => {
      lastSentContentRef.current = ''
      void queryClient.invalidateQueries({ queryKey: ['pub', pubName, 'messages'] })
    },
    onError: () => {
      // Restore what we cleared on submit (only if user hasn't already
      // typed something new).
      setDraft((current) => (current.length === 0 ? lastSentContentRef.current : current))
    },
  })

  const reactMutation = useMutation({
    mutationFn: (input: { message_id: string; emoji: string }) => api.pubReact(pubName, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['pub', pubName, 'messages'] })
    },
  })

  // Autoscroll to the bottom on new messages.
  useEffect(() => {
    const el = timelineRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages.length])

  const eyebrow = `2200 · STUDIO · ${pubName.toUpperCase()} · ${theme.toUpperCase()} · WS ${live.status.toUpperCase()}`

  const handleInsertMention = (handle: string): void => {
    const insert = `@${handle} `
    const ta = composerRef.current
    if (!ta) {
      setDraft((d) => (d.endsWith(' ') || d.length === 0 ? d : `${d} `) + insert)
      return
    }
    const start = ta.selectionStart
    const end = ta.selectionEnd
    const next = draft.slice(0, start) + insert + draft.slice(end)
    setDraft(next)
    setTimeout(() => {
      ta.focus()
      const cursor = start + insert.length
      ta.setSelectionRange(cursor, cursor)
    }, 0)
  }

  const handleSubmit = (e?: FormEvent<HTMLFormElement>): void => {
    e?.preventDefault()
    const content = draft.trim()
    if (content.length === 0 || sendMutation.isPending) return
    // Optimistic clear so the user can keep typing immediately.
    // Refocus the textarea on the next tick so Enter doesn't lose
    // the cursor (the form submit blurs by default).
    lastSentContentRef.current = content
    const attachments = staged
    setDraft('')
    setStaged([])
    setStageError(null)
    sendMutation.mutate({ content, attachments })
    setTimeout(() => composerRef.current?.focus(), 0)
  }

  const handleFileSelect = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    setStageError(null)
    const files = event.target.files ? Array.from(event.target.files) : []
    if (files.length === 0) return
    const next: StagedAttachment[] = [...staged]
    for (const file of files) {
      if (next.length >= ATTACH_MAX_COUNT) {
        setStageError(`Up to ${String(ATTACH_MAX_COUNT)} attachments per message.`)
        break
      }
      if (file.size > ATTACH_MAX_BYTES) {
        setStageError(
          `"${file.name}" is too large (max ${formatAttachmentSize(ATTACH_MAX_BYTES)}).`,
        )
        continue
      }
      try {
        next.push(await readFileAsAttachment(file))
      } catch (err) {
        setStageError(
          `Failed to read "${file.name}": ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }
    setStaged(next)
    // Reset the input so selecting the same file again re-fires onChange.
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const handleRemoveAttachment = (idx: number): void => {
    setStaged((prev) => prev.filter((_, i) => i !== idx))
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit()
    }
  }

  return (
    <main className={styles.shell}>
      <PageHeader
        eyebrow={eyebrow}
        title={`Studio · ${pubName}`}
        subtitle="Multi-agent room. Tag with @, react with one click."
        actions={
          <div className={styles.headerActions}>
            <Link to="/" className={styles.back}>
              ← FLEET
            </Link>
            <ThemeSwitcher />
          </div>
        }
      />

      {pubQuery.isError && !pubQuery.data ? (
        <Card padding={0}>
          <ErrorState title="Pub unavailable" body={formatError(pubQuery.error)} />
        </Card>
      ) : null}

      <div className={styles.body}>
        <aside className={styles.sidebar}>
          <Card padding={16}>
            <div className={styles.sidebarLabel}>Members</div>
            {members.length ? (
              members.map((m) => (
                <div key={m.agent_id} className={styles.memberRow}>
                  <span
                    className={cx(styles.memberDot, m.status !== 'active' && styles.memberDotIdle)}
                  />
                  <span>{m.display_name}</span>
                </div>
              ))
            ) : (
              <div className={styles.atmosphere}>
                {pubQuery.isLoading ? 'Loading…' : 'No members reported yet.'}
              </div>
            )}
          </Card>
          {pubQuery.data?.atmosphere ? (
            <Card padding={16}>
              <div className={styles.sidebarLabel}>Atmosphere</div>
              <div className={styles.atmosphere}>
                {pubQuery.data.atmosphere.tone ?? '—'}
                {pubQuery.data.atmosphere.energy ? ` · ${pubQuery.data.atmosphere.energy}` : ''}
              </div>
              {pubQuery.data.atmosphere.active_topics?.length ? (
                <div className={cx(styles.atmosphere, styles.atmosphereTopics)}>
                  Topics: {pubQuery.data.atmosphere.active_topics.join(', ')}
                </div>
              ) : null}
            </Card>
          ) : null}
        </aside>

        <div ref={timelineRef} className={styles.timeline}>
          {messagesQuery.isLoading && messages.length === 0 ? (
            <LoadingState rows={4} />
          ) : messages.length === 0 ? (
            <div className={styles.empty}>No messages in {pubName} yet. Say hi below.</div>
          ) : (
            messages.map((m) => (
              <MessageItem
                key={m.message_id}
                message={m}
                onReact={(emoji) => {
                  reactMutation.mutate({ message_id: m.message_id, emoji })
                }}
                reactPending={reactMutation.isPending}
              />
            ))
          )}
        </div>
      </div>

      <form className={styles.composer} onSubmit={handleSubmit}>
        {members.length > 0 ? (
          <div className={styles.composerChips}>
            <span className={styles.composerChipsLabel}>TAG</span>
            {members.map((m) => (
              <button
                key={m.agent_id}
                type="button"
                className={styles.composerChip}
                onClick={() => {
                  handleInsertMention(m.display_name)
                }}
              >
                @{m.display_name}
              </button>
            ))}
          </div>
        ) : null}
        {staged.length > 0 || stageError ? (
          <div className={styles.attachmentsRow}>
            <span className={styles.attachmentsLabel}>FILES</span>
            {staged.map((att, idx) => (
              <span key={`${att.filename}-${String(idx)}`} className={styles.attachmentChip}>
                <span>{att.filename}</span>
                <span className={styles.attachmentChipSize}>
                  ({formatAttachmentSize(att.size_bytes)})
                </span>
                <button
                  type="button"
                  className={styles.attachmentChipRemove}
                  onClick={() => {
                    handleRemoveAttachment(idx)
                  }}
                  aria-label={`Remove ${att.filename}`}
                  title="Remove"
                >
                  ×
                </button>
              </span>
            ))}
            {stageError ? <span className={styles.composerError}>{stageError}</span> : null}
          </div>
        ) : null}
        <div className={styles.composerRow}>
          <textarea
            ref={composerRef}
            className={styles.composerInput}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value)
            }}
            onKeyDown={handleKeyDown}
            placeholder={`Message ${pubName} … use @<name> to direct it.`}
          />
          <button
            type="button"
            className={styles.attachButton}
            onClick={() => fileInputRef.current?.click()}
            aria-label="Attach files"
            title="Attach files"
            disabled={staged.length >= ATTACH_MAX_COUNT}
          >
            📎
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="text/*,image/*,application/json,application/yaml,application/x-yaml,application/pdf,.md,.csv,.log,.yml,.yaml"
            className={styles.hiddenInput}
            onChange={(e) => {
              void handleFileSelect(e)
            }}
          />
          <Button
            type="submit"
            variant="primary"
            size="sm"
            disabled={sendMutation.isPending || draft.trim().length === 0}
          >
            {sendMutation.isPending ? 'SENDING…' : 'SEND'}
          </Button>
        </div>
        {sendMutation.error ? (
          <div className={styles.composerError}>{formatError(sendMutation.error)}</div>
        ) : (
          <div className={styles.composerHint}>
            ENTER TO SEND · SHIFT+ENTER FOR NEWLINE · 📎 ATTACHES FILES (up to{' '}
            {String(ATTACH_MAX_COUNT)} files, {formatAttachmentSize(ATTACH_MAX_BYTES)} each)
          </div>
        )}
      </form>
    </main>
  )
}

function MessageItem({
  message,
  onReact,
  reactPending,
}: {
  message: PubMessage
  onReact: (emoji: string) => void
  reactPending: boolean
}): ReactElement {
  // Aggregate reactions by emoji: { '👍': [agent_id, ...], ... }
  const grouped = useMemo(() => {
    const map = new Map<string, PubReactionDto[]>()
    for (const r of message.reactions) {
      const arr = map.get(r.emoji) ?? []
      arr.push(r)
      map.set(r.emoji, arr)
    }
    return Array.from(map.entries())
  }, [message.reactions])

  return (
    <div className={styles.message}>
      <div className={styles.messageMeta}>
        <span className={styles.sender}>{message.display_name}</span>
        <span className={styles.timestamp}>{formatTime(message.timestamp)}</span>
        {message.mention_names.length > 0 ? (
          <span className={styles.mentions}>
            {message.mention_names.map((n) => `@${n}`).join(' ')}
          </span>
        ) : null}
      </div>
      <div className={styles.content}>{message.content}</div>
      <div className={styles.reactionsRow}>
        {grouped.map(([emoji, list]) => (
          <button
            key={emoji}
            type="button"
            className={styles.reactionChip}
            disabled={reactPending}
            title={list.map((r) => r.display_name).join(', ')}
            onClick={() => {
              onReact(emoji)
            }}
          >
            <span>{emoji}</span>
            <span>{list.length}</span>
          </button>
        ))}
        <span className={styles.reactPicker}>
          {REACTION_OPTIONS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              className={styles.reactPickerButton}
              title={`React with ${emoji}`}
              disabled={reactPending}
              onClick={() => {
                onReact(emoji)
              }}
            >
              {emoji}
            </button>
          ))}
        </span>
      </div>
    </div>
  )
}
