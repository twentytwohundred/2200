/**
 * Studio: a multi-agent room with composer + reactions.
 *
 * The operator, their Agents, and any other pub members all in one
 * threaded view. Routing: `/studio` redirects to the install's first running
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
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type SyntheticEvent,
  type KeyboardEvent,
  type ReactElement,
} from 'react'
import { Navigate, useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Attachment } from '../../chat/Attachment'
import { NewRoomForm } from './NewRoomForm'
import {
  ApiError,
  NetworkError,
  api,
  type Agent,
  type PubMember,
  type PubMessage,
  type PubReactionDto,
} from '../../lib/api'
import {
  AgentMark,
  Button,
  Card,
  cx,
  ErrorState,
  Kbd,
  LoadingState,
  Meta,
  PulseDot,
  Screen,
  ScreenNavLink,
  Tag,
} from '../../primitives'
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

/** Label shown for a member chip: the canonical Agent name, or the
 * display_name for a non-Agent participant (the operator / a guest). */
function memberLabel(m: PubMember): string {
  return m.agent_name ?? m.display_name
}

/**
 * Extract @<token> mentions from message content and resolve to
 * agent_ids. Lookups are case-insensitive against the member label
 * (canonical Agent name, or display_name for the operator/guests).
 * Tokens that don't match any member are dropped silently; the pub
 * server's @<handle> fallback parser will catch them server-side if
 * they correspond to a known agent in the room.
 */
function extractMentions(content: string, members: PubMember[]): string[] {
  const tokens = content.match(/(?:^|\s)@([\w.-]+)/g) ?? []
  const ids = new Set<string>()
  for (const tok of tokens) {
    const handle = tok.trim().slice(1).toLowerCase()
    const match = members.find((m) => memberLabel(m).toLowerCase() === handle)
    if (match) ids.add(match.agent_id)
  }
  return Array.from(ids)
}

export function StudioScreen(): ReactElement {
  const { pub: pubParam } = useParams<{ pub?: string }>()

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
        <Screen crumbs={['2200', 'studio']} title="Studio">
          <Card padding={20}>
            <LoadingState rows={3} />
          </Card>
        </Screen>
      )
    }
    const first =
      pubsQuery.data?.items.find((p) => p.state === 'running') ?? pubsQuery.data?.items[0]
    if (!first) {
      return <StudioEmpty />
    }
    return <Navigate to={`/studio/${encodeURIComponent(first.name)}`} replace />
  }

  return <StudioPubView pubName={pubParam} />
}

function StudioEmpty(): ReactElement {
  return (
    <Screen
      crumbs={['2200', 'studio']}
      title="Studio"
      lede="No rooms yet. Create one and pick who's in it."
      actions={<ScreenNavLink to="/">← Fleet</ScreenNavLink>}
    >
      <NewRoomForm
        onClose={() => {
          /* no-op: empty state stays open until a room exists */
        }}
      />
    </Screen>
  )
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

interface ParsedPubAttachment {
  attId: string
  filename: string
  content_type: string
  size_label: string
  isImage: boolean
}

/**
 * Pub messages with attachments arrive as a single string the runtime
 * pre-rendered with an "Attached files:" header followed by virtual
 * paths under /commons/scratch/attachments/<attId>/<filename>.
 *
 * Split that out so the timeline can show image previews + file
 * chips and render only the user-authored body as markdown. The
 * agent's view of the same message is the raw augmented content;
 * that path is untouched by this client-side parse.
 */
function parsePubAttachments(content: string): {
  attachments: ParsedPubAttachment[]
  body: string
} {
  if (!content.startsWith('Attached files:\n')) {
    return { attachments: [], body: content }
  }
  const lines = content.split('\n')
  let idx = 1 // first attachment line
  const attachments: ParsedPubAttachment[] = []
  const ATT_LINE =
    /^-\s+\/commons\/scratch\/attachments\/([a-f0-9]+)\/([^\s]+)\s+\(([^,]+),\s*([^)]+)\)\s*$/i
  while (idx < lines.length) {
    const line = lines[idx] ?? ''
    const m = ATT_LINE.exec(line)
    if (!m) break
    const [, attId, filename, contentType, sizeLabel] = m
    if (attId && filename && contentType && sizeLabel) {
      attachments.push({
        attId,
        filename,
        content_type: contentType.trim(),
        size_label: sizeLabel.trim(),
        isImage: contentType.trim().toLowerCase().startsWith('image/'),
      })
    }
    idx++
  }
  if (attachments.length === 0) {
    return { attachments: [], body: content }
  }
  // Skip optional inline-text blocks: `\n--- name (inline) ---` …
  // `--- end name ---`. They live between the attachment list and
  // the user content per the runtime's render.
  while (idx < lines.length) {
    const line = lines[idx] ?? ''
    if (/^---\s+.+\s+\(inline\)\s+---$/.test(line)) {
      // Walk to the matching `--- end <name> ---` (or EOF as fallback).
      idx++
      while (idx < lines.length) {
        const inner = lines[idx] ?? ''
        idx++
        if (/^---\s+end\s+.+\s+---$/.test(inner)) break
      }
      continue
    }
    break
  }
  // Skip blank separator the runtime inserts before the user content.
  while (idx < lines.length && (lines[idx] ?? '') === '') idx++
  const body = lines.slice(idx).join('\n')
  return { attachments, body }
}

function StudioPubView({ pubName }: { pubName: string }): ReactElement {
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

  // Polled agents list gives us live pulse for each member. The
  // bridge polls every 2s (faster than the pub query) so the dot
  // tracks short bursts of activity without lagging the user's
  // message arrival.
  const agentsQuery = useQuery({
    queryKey: ['agents'],
    queryFn: () => api.agents(),
    refetchInterval: 2_000,
    staleTime: 1_000,
  })

  // Identify which member is the operator so we can render the "you" tag.
  // The Studio member is keyed by the operator's user-identity display_name
  // (which they can change in Settings), not the auth principal ... so read
  // that, falling back to the principal name.
  const meQuery = useQuery({
    queryKey: ['me'],
    queryFn: () => api.me(),
    staleTime: 60_000,
  })
  const userQuery = useQuery({
    queryKey: ['user'],
    queryFn: () => api.userIdentity(),
    staleTime: 10_000,
  })
  const meName = userQuery.data?.identity?.display_name ?? meQuery.data?.name ?? null

  const messages = useMemo(() => messagesQuery.data?.items ?? [], [messagesQuery.data])
  const members = pubQuery.data?.members ?? []

  // Map display_name → agent (for pulse lookup). Pub members are
  // identified by display_name; the agents API keys by agent name,
  // which equals display_name for the seed-team identities.
  const agentByName = useMemo(() => {
    const map = new Map<string, NonNullable<typeof agentsQuery.data>['items'][number]>()
    for (const a of agentsQuery.data?.items ?? []) {
      map.set(a.name, a)
    }
    return map
  }, [agentsQuery.data])

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

  // Sticky-bottom autoscroll: only follow new messages when the
  // operator is already at the bottom. If they've scrolled up to
  // re-read, leave them where they are and tick an unread badge on
  // the floating "jump to latest" button.
  const [atBottom, setAtBottom] = useState(true)
  const [unreadBelow, setUnreadBelow] = useState(0)
  const SCROLL_BOTTOM_THRESHOLD = 80

  const updateAtBottom = useCallback((): boolean => {
    const el = timelineRef.current
    if (!el) return true
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight
    const next = distance <= SCROLL_BOTTOM_THRESHOLD
    setAtBottom(next)
    if (next) setUnreadBelow(0)
    return next
  }, [])

  const scrollAnimRef = useRef<number | null>(null)
  const scrollToBottom = useCallback((smooth: boolean): void => {
    const el = timelineRef.current
    if (!el) return
    if (scrollAnimRef.current !== null) {
      cancelAnimationFrame(scrollAnimRef.current)
      scrollAnimRef.current = null
    }
    const target = el.scrollHeight - el.clientHeight
    if (!smooth || Math.abs(target - el.scrollTop) < 8) {
      el.scrollTop = target
      setAtBottom(true)
      setUnreadBelow(0)
      return
    }
    const start = el.scrollTop
    const distance = target - start
    const duration = 260
    const startTs = performance.now()
    let cancelled = false
    const onUserScroll = (): void => {
      cancelled = true
    }
    el.addEventListener('wheel', onUserScroll, { passive: true, once: true })
    el.addEventListener('touchmove', onUserScroll, { passive: true, once: true })
    const tick = (now: number): void => {
      if (cancelled) {
        scrollAnimRef.current = null
        return
      }
      const t = Math.min(1, (now - startTs) / duration)
      const eased = 1 - Math.pow(1 - t, 3)
      el.scrollTop = start + distance * eased
      if (t < 1) {
        scrollAnimRef.current = requestAnimationFrame(tick)
      } else {
        scrollAnimRef.current = null
        setAtBottom(true)
        setUnreadBelow(0)
        el.removeEventListener('wheel', onUserScroll)
        el.removeEventListener('touchmove', onUserScroll)
      }
    }
    scrollAnimRef.current = requestAnimationFrame(tick)
  }, [])

  // Track message-count deltas so the unread-below badge only ticks
  // when new content actually arrives (not on every poll refetch).
  const prevMsgCountRef = useRef(messages.length)
  useEffect(() => {
    const el = timelineRef.current
    if (!el) return
    const prev = prevMsgCountRef.current
    const grew = messages.length > prev
    prevMsgCountRef.current = messages.length
    if (atBottom) {
      el.scrollTop = el.scrollHeight
      setUnreadBelow(0)
    } else if (grew) {
      setUnreadBelow((n) => n + (messages.length - prev))
    }
  }, [messages.length, atBottom])

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

  const handleSubmit = (e?: SyntheticEvent<HTMLFormElement>): void => {
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

  const workingMembers = members.filter((m) => {
    const p = m.agent_name ? agentByName.get(m.agent_name)?.pulse : undefined
    if (!p) return false
    return p.state === 'working_light' || p.state === 'working_medium' || p.state === 'working_hard'
  })

  // Defense in depth: the API already collapses shadow registrations to one
  // row per Agent (the pub-server keys on display_name and can't delete
  // stale entries), but dedup by canonical label here too so any straggler
  // never doubles a chip.
  const dedupedMembers = useMemo(() => {
    const seen = new Set<string>()
    const out: PubMember[] = []
    for (const m of members) {
      const key = memberLabel(m)
      if (seen.has(key)) continue
      seen.add(key)
      out.push(m)
    }
    return out
  }, [members])

  // For the "+ Add guest" picker: agents on this instance who
  // aren't already in the room.
  const availableToAdd = useMemo(() => {
    const present = new Set(dedupedMembers.map((m) => memberLabel(m)))
    return Array.from(agentByName.values())
      .filter((a) => !present.has(a.name))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [dedupedMembers, agentByName])

  const guestMutation = useMutation({
    mutationFn: (body: { add_guests?: string[]; remove_guests?: string[] }) =>
      api.pubUpdateGuests(pubName, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['pub', pubName] })
      void queryClient.invalidateQueries({ queryKey: ['pubs'] })
      void queryClient.invalidateQueries({ queryKey: ['agents'] })
    },
  })

  // "Studio" is the singular canonical pub the whole fleet lives in.
  // Anything else is a Room with curated membership ... show the
  // room name in the title and breadcrumb so the operator knows
  // which conversation surface they are on.
  const isStudio = pubName === 'studio'
  const screenCrumbs: readonly string[] = isStudio ? ['2200', 'studio'] : ['2200', 'rooms', pubName]
  const screenTitle = isStudio ? 'Studio' : pubName
  const screenLede = isStudio
    ? 'The fleet room. Every Agent lives here. Tag with @, react with one click.'
    : `Room with curated membership. Tag with @, react with one click.`
  return (
    <Screen
      className={styles.shell}
      crumbs={screenCrumbs}
      title={screenTitle}
      lede={screenLede}
      actions={
        <ScreenNavLink to={isStudio ? '/' : '/rooms'}>
          {isStudio ? '← Fleet' : '← Rooms'}
        </ScreenNavLink>
      }
    >
      {pubQuery.isError && !pubQuery.data ? (
        <Card padding={0}>
          <ErrorState title="Pub unavailable" body={formatError(pubQuery.error)} />
        </Card>
      ) : null}

      <div className={styles.body}>
        <aside className={styles.sidebar}>
          <section className={styles.section}>
            <Meta>guests</Meta>
            {dedupedMembers.length === 0 ? (
              <p className={styles.atmosphereText}>
                {pubQuery.isLoading ? 'Loading…' : 'No guests reported yet.'}
              </p>
            ) : (
              <ul className={styles.memberList}>
                {dedupedMembers.map((m) => {
                  const label = memberLabel(m)
                  const agent = m.agent_name ? agentByName.get(m.agent_name) : undefined
                  const pulse = agent?.pulse ?? null
                  // The operator row carries no agent_name; identify "you" by
                  // matching the operator's display_name.
                  const isYou =
                    meName !== null && m.agent_name === null && m.display_name === meName
                  const canRemove = !isStudio && !isYou && m.agent_name !== null
                  return (
                    <li key={m.agent_id} className={styles.memberRow}>
                      <AgentMark
                        id={label}
                        name={label}
                        size="sm"
                        glyph={agent?.avatar ?? undefined}
                        imageUrl={api.authedUrl(agent?.avatar_image_url) ?? undefined}
                      />
                      <span className={cx(styles.memberName, isYou && styles.memberNameYou)}>
                        {label}
                      </span>
                      {isYou && <span className={styles.memberYouTag}>you</span>}
                      {pulse && (
                        <PulseDot
                          state={pulse.state}
                          intensity={pulse.intensity}
                          size="sm"
                          title={`${label} · ${pulse.state} (intensity ${pulse.intensity.toFixed(2)})`}
                        />
                      )}
                      {canRemove && (
                        <RemoveGuestButton
                          pubName={pubName}
                          guest={label}
                          disabled={guestMutation.isPending}
                          onRemove={(g) => {
                            guestMutation.mutate({ remove_guests: [g] })
                          }}
                        />
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
            {!isStudio && availableToAdd.length > 0 && (
              <AddGuestPicker
                available={availableToAdd}
                agentByName={agentByName}
                disabled={guestMutation.isPending}
                onAdd={(name) => {
                  guestMutation.mutate({ add_guests: [name] })
                }}
              />
            )}
            {guestMutation.error && (
              <p className={styles.guestError}>
                {guestMutation.error instanceof Error
                  ? guestMutation.error.message
                  : 'unknown error'}
              </p>
            )}
          </section>

          {pubQuery.data?.atmosphere ? (
            <section className={styles.section}>
              <Meta>atmosphere</Meta>
              <p className={styles.atmosphereText}>
                {pubQuery.data.atmosphere.tone ?? '—'}
                {pubQuery.data.atmosphere.energy ? ` · ${pubQuery.data.atmosphere.energy}` : ''}
              </p>
              {pubQuery.data.atmosphere.active_topics?.length ? (
                <p className={styles.atmosphereTopics}>
                  topics: {pubQuery.data.atmosphere.active_topics.join(', ')}
                </p>
              ) : null}
            </section>
          ) : null}
        </aside>

        <div className={styles.feedWrap}>
          <div ref={timelineRef} className={styles.feed} onScroll={updateAtBottom}>
            {messagesQuery.isLoading && messages.length === 0 ? (
              <LoadingState rows={4} />
            ) : messages.length === 0 ? (
              <div className={styles.empty}>No messages in {pubName} yet. Say hi below.</div>
            ) : (
              messages.map((m) => (
                <MessageItem
                  key={m.message_id}
                  message={m}
                  agentByName={agentByName}
                  onReact={(emoji) => {
                    reactMutation.mutate({ message_id: m.message_id, emoji })
                  }}
                  reactPending={reactMutation.isPending}
                />
              ))
            )}
            {workingMembers.map((m) => {
              const label = memberLabel(m)
              const p = m.agent_name ? agentByName.get(m.agent_name)?.pulse : undefined
              if (!p) return null
              return (
                <div
                  key={`thinking-${m.agent_id}`}
                  className={styles.thinkingRow}
                  title={`${label} · ${p.state} (intensity ${p.intensity.toFixed(2)})`}
                >
                  <PulseDot state={p.state} intensity={p.intensity} size="sm" />
                  <span>{label} is thinking…</span>
                </div>
              )
            })}
          </div>
          {!atBottom && (
            <button
              type="button"
              className={styles.jumpToBottom}
              onClick={() => {
                scrollToBottom(true)
              }}
              aria-label="Jump to latest message"
            >
              {unreadBelow > 0 && <span className={styles.jumpToBottomBadge}>{unreadBelow}</span>}
              <span>Jump to latest</span>
              <span className={styles.jumpToBottomArrow} aria-hidden="true">
                ↓
              </span>
            </button>
          )}
        </div>
      </div>

      <form className={styles.composer} onSubmit={handleSubmit}>
        {members.length > 0 ? (
          <div className={styles.composerTagRow}>
            <Meta>tag</Meta>
            {members.map((m) => (
              <Tag
                key={m.agent_id}
                agent={m.display_name}
                onClick={() => {
                  handleInsertMention(m.display_name)
                }}
              >
                @{m.display_name}
              </Tag>
            ))}
          </div>
        ) : null}

        {staged.length > 0 || stageError ? (
          <div className={styles.attachmentsRow}>
            <Meta>files</Meta>
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

        <textarea
          ref={composerRef}
          className={styles.composerTextarea}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value)
          }}
          onKeyDown={handleKeyDown}
          placeholder={`Message ${pubName} … use @<name> to direct it.`}
        />

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

        <div className={styles.composerFoot}>
          <span className={styles.kbdHint}>
            <Kbd>↵</Kbd> to send · <Kbd>⇧</Kbd>+<Kbd>↵</Kbd> for newline
          </span>
          <div className={styles.composerActions}>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              disabled={staged.length >= ATTACH_MAX_COUNT}
            >
              Attach
            </Button>
            <Button
              type="submit"
              variant="primary"
              size="md"
              disabled={sendMutation.isPending || draft.trim().length === 0}
            >
              {sendMutation.isPending ? 'Sending…' : 'Send'}
            </Button>
          </div>
        </div>
        {sendMutation.error ? (
          <div className={styles.composerError}>{formatError(sendMutation.error)}</div>
        ) : null}
      </form>

      {!isStudio && <DestroyRoomFooter pubName={pubName} />}
    </Screen>
  )
}

function MessageItem({
  message,
  agentByName,
  onReact,
  reactPending,
}: {
  message: PubMessage
  agentByName: Map<string, Agent>
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

  const sender = agentByName.get(message.display_name)
  const { attachments, body } = useMemo(
    () => parsePubAttachments(message.content),
    [message.content],
  )

  return (
    <article className={styles.message}>
      <div className={styles.messageHead}>
        <AgentMark
          id={message.display_name}
          name={message.display_name}
          size="md"
          glyph={sender?.avatar ?? undefined}
          imageUrl={api.authedUrl(sender?.avatar_image_url) ?? undefined}
        />
        <span className={styles.sender}>{message.display_name}</span>
        <span className={styles.timestamp}>{formatTime(message.timestamp)}</span>
        {message.mention_names.map((n) => (
          <Tag key={n} agent={n}>
            @{n}
          </Tag>
        ))}
      </div>
      {attachments.length > 0 && (
        <div className={styles.messageAttachments}>
          {attachments.map((att) => {
            const href = api.authedUrl(api.pubAttachmentUrl(att.attId, att.filename)) ?? '#'
            return (
              <a
                key={`${att.attId}-${att.filename}`}
                href={href}
                target="_blank"
                rel="noreferrer noopener"
                className={styles.attachmentLink}
                title={`Open ${att.filename}`}
              >
                <Attachment
                  kind={att.isImage ? 'image' : 'file'}
                  name={att.filename}
                  size={att.size_label}
                  {...(att.isImage ? { src: href } : {})}
                />
              </a>
            )
          })}
        </div>
      )}
      <div className={cx(styles.messageBody, styles.markdown)}>
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{body}</ReactMarkdown>
      </div>
      <div className={styles.messageReactions}>
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
            <span className={styles.reactionChipCount}>{list.length}</span>
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
    </article>
  )
}

/**
 * Two-step remove button next to a guest row. First click flips to
 * "remove?" with danger tint; second click within 3s commits.
 * Mouse-leave or timeout reverts. No popups
 * ([[feedback_no_browser_popups]]).
 */
function RemoveGuestButton({
  pubName: _pubName,
  guest,
  disabled,
  onRemove,
}: {
  pubName: string
  guest: string
  disabled: boolean
  onRemove: (guest: string) => void
}): ReactElement {
  const [armed, setArmed] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )
  return (
    <button
      type="button"
      className={cx(styles.removeBtn, armed && styles.removeBtnArmed)}
      disabled={disabled}
      title={armed ? `Click again to remove ${guest}` : `Remove ${guest} from this room`}
      onClick={() => {
        if (armed) {
          if (timer.current) clearTimeout(timer.current)
          setArmed(false)
          onRemove(guest)
        } else {
          setArmed(true)
          if (timer.current) clearTimeout(timer.current)
          timer.current = setTimeout(() => {
            setArmed(false)
          }, 3000)
        }
      }}
      onMouseLeave={
        armed
          ? () => {
              setArmed(false)
              if (timer.current) clearTimeout(timer.current)
            }
          : undefined
      }
    >
      {armed ? 'remove?' : '×'}
    </button>
  )
}

/**
 * Inline picker for agents not currently in the room. Opens a small
 * dropdown of available agents; clicking one calls `onAdd`.
 */
function AddGuestPicker({
  available,
  agentByName,
  disabled,
  onAdd,
}: {
  available: Agent[]
  agentByName: Map<string, Agent>
  disabled: boolean
  onAdd: (name: string) => void
}): ReactElement {
  const [open, setOpen] = useState(false)
  return (
    <div className={styles.addGuestWrap}>
      {open ? (
        <ul className={styles.addGuestList}>
          {available.map((a) => {
            const agent = agentByName.get(a.name)
            return (
              <li key={a.name}>
                <button
                  type="button"
                  className={styles.addGuestRow}
                  disabled={disabled}
                  onClick={() => {
                    setOpen(false)
                    onAdd(a.name)
                  }}
                >
                  <AgentMark
                    id={a.name}
                    name={a.name}
                    size="sm"
                    glyph={agent?.avatar ?? undefined}
                    imageUrl={api.authedUrl(agent?.avatar_image_url) ?? undefined}
                  />
                  <span>{a.name}</span>
                </button>
              </li>
            )
          })}
          <li>
            <button
              type="button"
              className={styles.addGuestCancel}
              onClick={() => {
                setOpen(false)
              }}
            >
              cancel
            </button>
          </li>
        </ul>
      ) : (
        <button
          type="button"
          className={styles.addGuestTrigger}
          disabled={disabled}
          onClick={() => {
            setOpen(true)
          }}
        >
          + add guest
        </button>
      )}
    </div>
  )
}

/**
 * Tiny "destroy this room" trigger that lives below the composer.
 * Click opens a floating overlay anchored above the link with the
 * typed-DESTROY input + button. Keeps the destructive surface out
 * of the way until the operator reaches for it.
 *
 * On destroy success, navigate back to /rooms.
 */
function DestroyRoomFooter({ pubName }: { pubName: string }): ReactElement {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [confirm, setConfirm] = useState('')
  const matches = confirm === 'DESTROY'

  const mutation = useMutation({
    mutationFn: () => api.pubDestroy(pubName),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['pubs'] })
      void qc.invalidateQueries({ queryKey: ['agents'] })
      void navigate('/rooms')
    },
  })

  // Esc closes the overlay.
  useEffect(() => {
    if (!open) return
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const close = (): void => {
    setOpen(false)
    setConfirm('')
  }

  return (
    <div className={styles.destroyFooter}>
      {open && (
        <div className={styles.destroyOverlay} role="dialog" aria-label="Destroy room">
          <div className={styles.destroyOverlayHead}>
            <span className={styles.destroyOverlayTitle}>Destroy "{pubName}"</span>
            <button
              type="button"
              className={styles.destroyOverlayClose}
              onClick={close}
              aria-label="Cancel destroy"
            >
              ×
            </button>
          </div>
          <p className={styles.destroyExplain}>
            Stops the pub-server, removes the room record, deletes its on-disk state, and drops it
            from every guest's <span className={styles.destroyMono}>pubs.md</span>. Cannot be
            undone. Type <span className={styles.destroyMono}>DESTROY</span> below to enable.
          </p>
          <input
            className={styles.destroyInput}
            value={confirm}
            onChange={(e) => {
              setConfirm(e.target.value)
            }}
            placeholder="type DESTROY to enable"
            spellCheck={false}
            autoCapitalize="characters"
            autoFocus
          />
          <div className={styles.destroyOverlayActions}>
            <button
              type="button"
              className={styles.destroyCancelBtn}
              onClick={close}
              disabled={mutation.isPending}
            >
              Cancel
            </button>
            <button
              type="button"
              className={cx(styles.destroyBtn, matches && styles.destroyBtnArmed)}
              disabled={!matches || mutation.isPending}
              onClick={() => {
                mutation.mutate()
              }}
            >
              {mutation.isPending ? 'Destroying…' : `Destroy ${pubName}`}
            </button>
          </div>
          {mutation.error && (
            <p className={styles.guestError}>
              {mutation.error instanceof Error ? mutation.error.message : 'unknown error'}
            </p>
          )}
        </div>
      )}
      <button
        type="button"
        className={styles.destroyTrigger}
        onClick={() => {
          setOpen((v) => !v)
        }}
      >
        {open ? 'cancel' : 'destroy this room'}
      </button>
    </div>
  )
}
