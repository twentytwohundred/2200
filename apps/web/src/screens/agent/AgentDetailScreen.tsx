/**
 * Agent detail screen ... chat-first layout per design-system v1.1.
 *
 *   ┌────────────────────────────────────────────────────────────┐
 *   │ Breadcrumb · Title · Status pill · Actions (Stop, ← Fleet) │
 *   ├──────────────┬─────────────────────────────────────────────┤
 *   │ 260px rail   │ Active chat pane                            │
 *   │              │                                             │
 *   │ Identity     │ Title bar                                   │
 *   │ + New chat   │ Messages                                    │
 *   │              │                                             │
 *   │ Chat list    │                                             │
 *   │              │                                             │
 *   │ More:        │ Composer (mode segmented + attach + send)   │
 *   │  Brain →     │                                             │
 *   │  Schedules → │                                             │
 *   │  Tools →     │                                             │
 *   └──────────────┴─────────────────────────────────────────────┘
 *
 * The chat panel reads from the multi-chat HTTP surface (see
 * `api.chatsList`, `api.chatMessagesList`, `api.chatMessageSend`).
 * Composer mode (pure | checkpointed | destructive) maps to the
 * task's idempotency. Live updates land via WS `chat.message`
 * events; we invalidate the messages query on receipt.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  api,
  type Agent,
  type ChatThread,
  type ChatThreadMessage,
  type ChatAttachmentRef,
  type ListEnvelope,
} from '../../lib/api'
import {
  AgentMark,
  Button,
  Meta,
  Pill,
  Screen,
  ScreenNavLink,
  type PillVariant,
} from '../../primitives'
import {
  ChatComposer,
  ChatListRow,
  ChatMessage,
  ChatTitleBar,
  DayDivider,
  type ComposerAttachment,
  type ComposerMode,
} from '../../chat'
import { ModelPicker } from './ModelPicker'
import { AgentStatusPanel } from './AgentStatusPanel'
import { AgentIdentityPanel } from './AgentIdentityPanel'
import { AgentBudgetPanel } from './AgentBudgetPanel'
import { BrainBody } from '../brain/BrainScreen'
import { SchedulesBody } from '../schedules/SchedulesScreen'
import { ToolsBody } from '../tools/ToolsScreen'
import { cx } from '../../primitives/cx'
import styles from './AgentDetailScreen.module.css'

type AgentTab = 'chat' | 'status' | 'identity' | 'budget' | 'brain' | 'schedules' | 'tools'
const VALID_TABS: AgentTab[] = [
  'chat',
  'status',
  'identity',
  'budget',
  'brain',
  'schedules',
  'tools',
]
function parseTab(raw: string | null): AgentTab {
  return (VALID_TABS as string[]).includes(raw ?? '') ? (raw as AgentTab) : 'chat'
}

function pillVariant(status: string): PillVariant {
  if (status === 'running') return 'running'
  if (status === 'waiting') return 'info'
  if (status === 'errored') return 'error'
  if (status.startsWith('blocked_')) return 'attention'
  return 'idle'
}

function pillLabel(status: string): string {
  if (status === 'blocked_on_user') return 'needs you'
  if (status === 'blocked_on_agent') return 'blocked'
  if (status === 'blocked_on_detector') return 'paused'
  return status.replace(/_/g, ' ')
}

export function AgentDetailScreen(): ReactElement {
  const { name, chatId: routeChatId } = useParams<{ name: string; chatId?: string }>()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const queryClient = useQueryClient()
  const agentName = name ?? ''

  // Active tab. Forced to 'chat' when a chatId is in the URL; otherwise
  // read from the ?tab= query param so deep-linking works. Switching to
  // a non-chat tab navigates to the bare /agent/:name URL so routeChatId
  // clears and the new tab actually takes effect (the routeChatId
  // override would otherwise pin tab back to 'chat').
  const tab: AgentTab = routeChatId !== undefined ? 'chat' : parseTab(searchParams.get('tab'))
  const setTab = (next: AgentTab): void => {
    const base = `/agent/${encodeURIComponent(agentName)}`
    if (next === 'chat') {
      void navigate(base)
    } else {
      void navigate(`${base}?tab=${next}`)
    }
  }

  const agentQuery = useQuery({
    queryKey: ['agents', agentName],
    queryFn: () => api.agent(agentName),
    enabled: agentName.length > 0,
    staleTime: 5_000,
  })

  const chatsQuery = useQuery<ListEnvelope<ChatThread>>({
    queryKey: ['agentChats', agentName],
    queryFn: () => api.chatsList(agentName),
    enabled: agentName.length > 0,
    staleTime: 2_000,
  })

  // Pick the active chat: route param wins; otherwise the most-recent
  // non-archived chat; otherwise null (which triggers create-first UX).
  const activeChatId = useMemo<string | null>(() => {
    if (routeChatId !== undefined) return routeChatId
    const chats = chatsQuery.data?.items ?? []
    const liveChat = chats.find((c) => !c.archived)
    return liveChat?.id ?? null
  }, [routeChatId, chatsQuery.data])

  const messagesQuery = useQuery<ListEnvelope<ChatThreadMessage>>({
    queryKey: ['agentChatMessages', agentName, activeChatId],
    queryFn: () => api.chatMessagesList(agentName, activeChatId ?? ''),
    enabled: agentName.length > 0 && activeChatId !== null,
    staleTime: 2_000,
  })

  // Mark active chat read on focus.
  const lastReadRef = useRef<string | null>(null)
  useEffect(() => {
    if (activeChatId === null || lastReadRef.current === activeChatId) return
    lastReadRef.current = activeChatId
    void api.chatThreadRead(agentName, activeChatId).then(() => {
      void queryClient.invalidateQueries({ queryKey: ['agentChats', agentName] })
    })
  }, [agentName, activeChatId, queryClient])

  const createChat = useMutation({
    mutationFn: () => api.chatThreadCreate(agentName),
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: ['agentChats', agentName] })
      void navigate(
        `/agent/${encodeURIComponent(agentName)}/chat/${encodeURIComponent(res.chat.id)}`,
      )
    },
  })

  const archiveChat = useMutation({
    mutationFn: (chatId: string) => api.chatThreadArchive(agentName, chatId, true),
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: ['agentChats', agentName] })
      if (activeChatId === res.chat.id) {
        void navigate(`/agent/${encodeURIComponent(agentName)}`)
      }
    },
  })

  const renameChat = useMutation({
    mutationFn: ({ chatId, title }: { chatId: string; title: string }) =>
      api.chatThreadRename(agentName, chatId, title),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['agentChats', agentName] })
    },
  })

  const stopAgent = useMutation({
    mutationFn: () => api.agentStop(agentName, 'web_request'),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['agents', agentName] })
    },
  })

  // Track the task spawned by the most-recent send so we can show a
  // "thinking…" placeholder until the assistant's reply lands, then
  // animate the reply in word-by-word.
  const [pendingTaskId, setPendingTaskId] = useState<string | null>(null)
  const [streamingId, setStreamingId] = useState<string | null>(null)
  const [streamingChars, setStreamingChars] = useState(0)

  const submitMessage = useCallback(
    async (args: { body: string; mode: ComposerMode; attachments: ComposerAttachment[] }) => {
      let chatId = activeChatId
      if (chatId === null) {
        const created = await api.chatThreadCreate(agentName)
        chatId = created.chat.id
      }
      const res = await sendMessageWithAttachments(agentName, chatId, args)
      setPendingTaskId(res.task_id)
      void queryClient.invalidateQueries({
        queryKey: ['agentChatMessages', agentName, chatId],
      })
      void queryClient.invalidateQueries({ queryKey: ['agentChats', agentName] })
      if (activeChatId === null) {
        void navigate(`/agent/${encodeURIComponent(agentName)}/chat/${encodeURIComponent(chatId)}`)
      }
    },
    [agentName, activeChatId, navigate, queryClient],
  )

  const agent: Agent | undefined = agentQuery.data
  const chats = chatsQuery.data?.items ?? []
  const liveChats = chats.filter((c) => !c.archived)
  const activeChat = chats.find((c) => c.id === activeChatId) ?? null
  const messages = messagesQuery.data?.items ?? []
  const messagesScrollRef = useRef<HTMLDivElement | null>(null)
  const [atBottom, setAtBottom] = useState(true)
  const [unreadBelow, setUnreadBelow] = useState(0)

  const SCROLL_BOTTOM_THRESHOLD = 80

  const updateAtBottom = useCallback((): boolean => {
    const el = messagesScrollRef.current
    if (!el) return true
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight
    const next = distance <= SCROLL_BOTTOM_THRESHOLD
    setAtBottom(next)
    if (next) setUnreadBelow(0)
    return next
  }, [])

  // Custom rAF-based smooth scroll. Native `behavior: 'smooth'` paces
  // by distance on most browsers and crawls when the chat is long; this
  // takes a fixed ~260ms regardless and uses an ease-out curve so the
  // arrival feels soft. Cancels on user wheel/touch input so we never
  // fight the operator.
  const scrollAnimRef = useRef<number | null>(null)
  const scrollToBottom = useCallback((smooth: boolean): void => {
    const el = messagesScrollRef.current
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

  // When the assistant message that closes out `pendingTaskId` lands
  // in the messages list, kick off the typewriter animation.
  useEffect(() => {
    if (pendingTaskId === null) return
    const reply = messages.find((m) => m.task_id === pendingTaskId && m.role === 'assistant')
    if (!reply) return
    setStreamingId(reply.id)
    setStreamingChars(0)
    setPendingTaskId(null)
  }, [messages, pendingTaskId])

  // Advance the streaming cursor. ~6 chars per 28ms ≈ 200 chars/sec ≈
  // 35 wps ... a touch faster than Claude's web cadence but feels live
  // without dragging on long replies.
  useEffect(() => {
    if (streamingId === null) return
    const reply = messages.find((m) => m.id === streamingId)
    if (!reply) {
      setStreamingId(null)
      return
    }
    if (streamingChars >= reply.body.length) {
      setStreamingId(null)
      return
    }
    const t = setTimeout(() => {
      setStreamingChars((c) => Math.min(c + 6, reply.body.length))
    }, 28)
    return () => {
      clearTimeout(t)
    }
  }, [streamingId, streamingChars, messages])

  // If the chat changes mid-stream, drop the streaming animation and
  // reset the scroll-position tracking so the new thread snaps to its
  // own bottom without inheriting the prior chat's "scrolled up" state.
  useEffect(() => {
    setPendingTaskId(null)
    setStreamingId(null)
    setStreamingChars(0)
    setAtBottom(true)
    setUnreadBelow(0)
  }, [activeChatId])

  // When new messages land or the streaming cursor advances, keep the
  // viewport pinned to the bottom *only* if the operator was already
  // there. If they scrolled up to read history, leave their position
  // alone and surface an unread-below count on the floating button.
  const prevMsgCountRef = useRef(messages.length)
  useEffect(() => {
    const el = messagesScrollRef.current
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
  }, [messages.length, pendingTaskId, streamingChars, atBottom])

  return (
    <Screen
      className={styles.shell}
      crumbs={['2200', 'agent', agentName]}
      title={
        <span className={styles.titleRow}>
          <span>{agentName}</span>
          {agent && <Pill variant={pillVariant(agent.status)}>{pillLabel(agent.status)}</Pill>}
        </span>
      }
      lede="Chat with this Agent. Each thread keeps its full history."
      actions={
        <>
          <ScreenNavLink to="/">← Fleet</ScreenNavLink>
          {agent?.status === 'running' && (
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                stopAgent.mutate()
              }}
            >
              Stop
            </Button>
          )}
        </>
      }
    >
      <div className={styles.body}>
        <aside className={styles.rail}>
          <div className={styles.identity}>
            <div className={styles.identityRow}>
              <AgentMark
                id={agentName}
                name={agentName}
                size="lg"
                state={agent?.status === 'running' ? 'speaking' : null}
                glyph={agent?.avatar ?? undefined}
                imageUrl={api.authedUrl(agent?.avatar_image_url) ?? undefined}
              />
              <div className={styles.identityText}>
                <div className={styles.identityName}>{agentName}</div>
                {agent?.model ? (
                  <ModelPicker
                    agentName={agentName}
                    currentProvider={agent.model.provider}
                    currentModelId={agent.model.model_id}
                  />
                ) : (
                  <div className={styles.identityModel}>—</div>
                )}
              </div>
            </div>
            <Button
              variant="primary"
              size="sm"
              className={styles.newChat}
              onClick={() => {
                createChat.mutate()
              }}
              disabled={createChat.isPending}
            >
              + New chat
            </Button>
          </div>

          <div className={styles.chatList}>
            <div className={styles.chatListHeader}>
              <Meta>chats · {String(liveChats.length)}</Meta>
            </div>
            <div className={styles.chatListInner}>
              {liveChats.length === 0 && (
                <p className={styles.empty}>No chats yet. Click + New chat to start.</p>
              )}
              {liveChats.map((c) => (
                <ChatListRow
                  key={c.id}
                  title={c.title}
                  snippet={c.snippet}
                  time={formatChatTime(c.updated_at)}
                  active={c.id === activeChatId}
                  unread={c.unread}
                  onClick={() => {
                    void navigate(
                      `/agent/${encodeURIComponent(agentName)}/chat/${encodeURIComponent(c.id)}`,
                    )
                  }}
                />
              ))}
            </div>
          </div>

          <div className={styles.settings}>
            <div className={styles.settingsHeader}>
              <Meta>settings</Meta>
            </div>
            <RailSwitch
              label="Chat"
              hint="messages"
              active={tab === 'chat'}
              onClick={() => {
                setTab('chat')
              }}
            />
            <RailSwitch
              label="Status"
              hint="runtime · model"
              active={tab === 'status'}
              onClick={() => {
                setTab('status')
              }}
            />
            <RailSwitch
              label="Identity"
              hint="prompt · md"
              active={tab === 'identity'}
              onClick={() => {
                setTab('identity')
              }}
            />
            <RailSwitch
              label="Budget"
              hint="spend · cap"
              active={tab === 'budget'}
              onClick={() => {
                setTab('budget')
              }}
            />
            <RailSwitch
              label="Brain"
              hint="notes"
              active={tab === 'brain'}
              onClick={() => {
                setTab('brain')
              }}
            />
            <RailSwitch
              label="Schedules"
              hint="cron · timers"
              active={tab === 'schedules'}
              onClick={() => {
                setTab('schedules')
              }}
            />
            <RailSwitch
              label="Tools"
              hint="mcp servers"
              active={tab === 'tools'}
              onClick={() => {
                setTab('tools')
              }}
            />
          </div>
        </aside>

        <section className={styles.pane}>
          {tab === 'chat' &&
            (activeChat ? (
              <>
                <div className={styles.paneHead}>
                  <ChatTitleBar
                    title={activeChat.title}
                    agent={agentName}
                    agentGlyph={agent?.avatar ?? undefined}
                    agentImageUrl={api.authedUrl(agent?.avatar_image_url) ?? undefined}
                    count={messages.length}
                    onRename={(next) => {
                      renameChat.mutate({ chatId: activeChat.id, title: next })
                    }}
                    onArchive={() => {
                      archiveChat.mutate(activeChat.id)
                    }}
                  />
                </div>
                <div className={styles.messagesWrap}>
                  <div
                    className={styles.messages}
                    ref={messagesScrollRef}
                    onScroll={updateAtBottom}
                  >
                    {renderMessages(
                      messages,
                      agentName,
                      agent?.avatar ?? null,
                      api.authedUrl(agent?.avatar_image_url),
                      pendingTaskId,
                      streamingId,
                      streamingChars,
                    )}
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
                      {unreadBelow > 0 && (
                        <span className={styles.jumpToBottomBadge}>{unreadBelow}</span>
                      )}
                      <span>Jump to latest</span>
                      <span className={styles.jumpToBottomArrow} aria-hidden="true">
                        ↓
                      </span>
                    </button>
                  )}
                </div>
                <div className={styles.composer}>
                  <ChatComposer
                    agent={agentName}
                    onSubmit={(args) => {
                      void submitMessage(args)
                    }}
                  />
                  <div className={styles.composerHint}>
                    Brain, fs, and pub tools available. Mode applies to the next message only.
                  </div>
                </div>
              </>
            ) : (
              <EmptyChat
                agent={agentName}
                onCreate={() => {
                  createChat.mutate()
                }}
                disabled={createChat.isPending}
              />
            ))}

          {tab === 'status' && agent && (
            <div className={styles.tabBody}>
              <AgentStatusPanel agent={agent} />
            </div>
          )}
          {tab === 'identity' && (
            <div className={styles.tabBody}>
              <AgentIdentityPanel agentName={agentName} />
            </div>
          )}
          {tab === 'budget' && (
            <div className={styles.tabBody}>
              <AgentBudgetPanel agentName={agentName} />
            </div>
          )}
          {tab === 'brain' && (
            <div className={styles.tabBody}>
              <BrainBody agentName={agentName} />
            </div>
          )}
          {tab === 'schedules' && (
            <div className={styles.tabBody}>
              <SchedulesBody agentName={agentName} />
            </div>
          )}
          {tab === 'tools' && (
            <div className={styles.tabBody}>
              <ToolsBody agentName={agentName} />
            </div>
          )}
        </section>
      </div>
    </Screen>
  )
}

function RailSwitch({
  label,
  hint,
  active,
  onClick,
}: {
  label: string
  hint: string
  active: boolean
  onClick: () => void
}): ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx(styles.railSwitch, active && styles.railSwitchActive)}
      aria-current={active ? 'page' : undefined}
    >
      <span className={styles.railSwitchLabel}>{label}</span>
      <span className={styles.railSwitchSpacer} />
      <span className={styles.railSwitchHint}>{hint}</span>
    </button>
  )
}

function EmptyChat({
  agent,
  onCreate,
  disabled,
}: {
  agent: string
  onCreate: () => void
  disabled: boolean
}): ReactElement {
  return (
    <div className={styles.emptyChat}>
      <p className={styles.emptyChatLede}>Start your first chat with {agent}.</p>
      <Button variant="primary" size="md" onClick={onCreate} disabled={disabled}>
        + New chat
      </Button>
    </div>
  )
}

function formatChatTime(iso: string): string {
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso
    const today = new Date()
    const sameDay =
      d.getUTCFullYear() === today.getUTCFullYear() &&
      d.getUTCMonth() === today.getUTCMonth() &&
      d.getUTCDate() === today.getUTCDate()
    if (sameDay) {
      return d.toISOString().slice(11, 16)
    }
    return d.toISOString().slice(5, 10)
  } catch {
    return iso
  }
}

function renderMessages(
  messages: ChatThreadMessage[],
  agent: string,
  agentGlyph: string | null,
  agentImageUrl: string | null,
  pendingTaskId: string | null,
  streamingId: string | null,
  streamingChars: number,
): ReactElement[] {
  const out: ReactElement[] = []
  let lastDay = ''
  for (const m of messages) {
    const day = m.ts.slice(0, 10)
    if (day !== lastDay) {
      lastDay = day
      out.push(<DayDivider key={`d-${day}`} label={formatDayLabel(day)} />)
    }
    const isStreaming = m.id === streamingId
    const bodyText = isStreaming ? m.body.slice(0, streamingChars) : m.body
    out.push(
      <ChatMessage
        key={m.id}
        from={m.role === 'user' ? 'you' : 'agent'}
        who={agent}
        agentGlyph={agentGlyph}
        agentImageUrl={agentImageUrl}
        time={m.ts.slice(11, 16)}
        body={bodyText}
        streamingCursor={isStreaming}
        attachments={m.attachments.map((a) => ({
          id: a.id,
          kind: a.kind,
          name: a.name,
          size: a.size,
        }))}
      />,
    )
  }
  if (pendingTaskId !== null) {
    out.push(
      <ChatMessage
        key="__thinking__"
        from="agent"
        who={agent}
        agentGlyph={agentGlyph}
        agentImageUrl={agentImageUrl}
        thinking
      />,
    )
  }
  return out
}

function formatDayLabel(day: string): string {
  const today = new Date().toISOString().slice(0, 10)
  if (day === today) return 'Today'
  const y = new Date()
  y.setUTCDate(y.getUTCDate() - 1)
  if (day === y.toISOString().slice(0, 10)) return 'Yesterday'
  return day
}

async function sendMessageWithAttachments(
  agent: string,
  chatId: string,
  args: { body: string; mode: ComposerMode; attachments: ComposerAttachment[] },
): Promise<{ task_id: string }> {
  const uploaded: ChatAttachmentRef[] = []
  for (const a of args.attachments) {
    const data = await composerAttachmentToBase64(a)
    const res = await api.chatAttachmentUpload(agent, chatId, {
      name: a.name,
      mime: a.mime,
      kind: a.kind,
      data_base64: data,
    })
    uploaded.push({
      id: res.attachment.id,
      kind: res.attachment.kind,
      name: res.attachment.name,
      size: res.attachment.size,
      mime: res.attachment.mime,
    })
  }
  const res = await api.chatMessageSend(agent, chatId, {
    body: args.body,
    mode: args.mode,
    attachments: uploaded,
  })
  return { task_id: res.task_id }
}

async function composerAttachmentToBase64(a: ComposerAttachment): Promise<string> {
  if (a.src !== undefined) {
    const res = await fetch(a.src)
    const buf = await res.arrayBuffer()
    return arrayBufferToBase64(buf)
  }
  throw new Error(`attachment ${a.name} has no source data`)
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  let binary = ''
  const bytes = new Uint8Array(buf)
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)))
  }
  return btoa(binary)
}
